package frpc

import (
	"context"
	"crypto/rand"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	v1 "github.com/fatedier/frp/pkg/config/v1"
	frpserver "github.com/fatedier/frp/server"
)

// Reproduce two Ubuntu/SSH devices colliding under the old display-name scheme,
// then migrate in either order without deleting devices or stealing proxies.
func TestSameDisplayNamesMigrateAndToggleIndependently(t *testing.T) {
	for _, order := range [][2]int{{0, 1}, {1, 0}} {
		t.Run(fmt.Sprintf("migration-order-%d-%d", order[0], order[1]), func(t *testing.T) {
			token := rand.Text()
			cfg := &v1.ServerConfig{
				BindAddr: "127.0.0.1", BindPort: availableAdminPort(t),
				ProxyBindAddr: "127.0.0.1", Auth: v1.AuthServerConfig{Token: token},
			}
			if err := cfg.Complete(); err != nil {
				t.Fatal(err)
			}
			frps, err := frpserver.NewService(cfg)
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			serverDone := make(chan struct{})
			go func() {
				defer close(serverDone)
				frps.Run(ctx)
			}()
			t.Cleanup(func() {
				cancel()
				if err := frps.Close(); err != nil {
					t.Error(err)
				}
				awaitClosed(t, serverDone)
			})

			type node struct {
				manager      *Manager
				base, legacy string
				stable       string
				remoteAddr   string
				responseText string
			}
			newNode := func(id string, tunnelID int, responseText string) node {
				target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
					if _, err := io.WriteString(w, responseText); err != nil {
						t.Errorf("target response: %v", err)
					}
				}))
				t.Cleanup(target.Close)
				_, localPort, err := net.SplitHostPort(target.Listener.Addr().String())
				if err != nil {
					t.Fatal(err)
				}
				base := fmt.Sprintf("serverAddr = \"127.0.0.1\"\nserverPort = %d\nauth.token = %q\nwebServer.addr = \"127.0.0.1\"\nwebServer.port = %d\n", cfg.BindPort, token, availableAdminPort(t))
				remotePort := availableAdminPort(t)
				proxyConfig := func(name string) string {
					return base + fmt.Sprintf("[[proxies]]\nname = %q\ntype = \"tcp\"\nlocalIP = \"127.0.0.1\"\nlocalPort = %s\nremotePort = %d\n", name, localPort, remotePort)
				}
				path := filepath.Join(t.TempDir(), "frpc.toml")
				if err := os.WriteFile(path, []byte(base), 0o600); err != nil {
					t.Fatal(err)
				}
				m := NewManager(path, nil)
				t.Cleanup(func() {
					if err := m.Stop(); err != nil {
						t.Error(err)
					}
				})
				return node{
					manager: m, base: base, legacy: proxyConfig("ubuntu.SSH"),
					stable:     proxyConfig(fmt.Sprintf("client-%s.tunnel-%d", id, tunnelID)),
					remoteAddr: net.JoinHostPort("127.0.0.1", strconv.Itoa(remotePort)), responseText: responseText,
				}
			}
			first := newNode("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 1, "first Ubuntu SSH target")
			if err := first.manager.ApplyConfig(first.legacy); err != nil {
				t.Fatal(err)
			}
			second := newNode("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", 2, "second Ubuntu SSH target")
			second.manager.readyTimeout = 500 * time.Millisecond
			err = second.manager.ApplyConfig(second.legacy)
			if err == nil || !strings.Contains(err.Error(), "already exists") {
				t.Fatalf("legacy naming did not reproduce the reported conflict: %v", err)
			}
			if !second.manager.IsRunning() {
				t.Fatal("name conflict incorrectly stopped the second core")
			}
			second.manager.readyTimeout = defaultReadyTimeout
			nodes := []node{first, second}
			for _, index := range order {
				if err := nodes[index].manager.ApplyConfig(nodes[index].stable); err != nil {
					t.Fatalf("device %d could not migrate to stable identity: %v", index, err)
				}
			}

			transport := &http.Transport{DisableKeepAlives: true}
			defer transport.CloseIdleConnections()
			httpClient := &http.Client{Transport: transport, Timeout: 3 * time.Second}
			assertRoute := func(n node) {
				t.Helper()
				response, err := httpClient.Get("http://" + n.remoteAddr)
				if err != nil {
					t.Fatalf("tunnel did not forward to its own device: %v", err)
				}
				body, err := io.ReadAll(response.Body)
				closeErr := response.Body.Close()
				if err != nil || closeErr != nil || response.StatusCode != http.StatusOK || string(body) != n.responseText {
					t.Fatalf("wrong device/response: status=%d body=%q want=%q read=%v close=%v", response.StatusCode, body, n.responseText, err, closeErr)
				}
			}
			assertRoute(first)
			assertRoute(second)
			for _, index := range order {
				active, peer := nodes[index], nodes[1-index]
				if err := active.manager.ApplyConfig(active.base); err != nil {
					t.Fatal(err)
				}
				if conn, err := net.DialTimeout("tcp", active.remoteAddr, time.Second); err == nil {
					_ = conn.Close()
					t.Fatal("disabled tunnel still accepts traffic")
				}
				assertRoute(peer)
				if err := active.manager.ApplyConfig(active.stable); err != nil {
					t.Fatalf("same-display-name tunnel did not re-enable: %v", err)
				}
				assertRoute(active)
				assertRoute(peer)
			}
		})
	}
}
