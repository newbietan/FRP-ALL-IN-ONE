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
	"testing"
	"time"

	v1 "github.com/fatedier/frp/pkg/config/v1"
	frpserver "github.com/fatedier/frp/server"
)

func waitForCoreReady(t *testing.T, manager *Manager) {
	t.Helper()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	timer := time.NewTimer(10 * time.Second)
	defer timer.Stop()
	for {
		if manager.Healthy() {
			return
		}
		select {
		case <-ticker.C:
		case <-timer.C:
			t.Fatalf("FRPC did not authenticate/register proxies; running=%v", manager.IsRunning())
		}
	}
}

// Exercise the reported flow with a real FRPS, authenticated control connection,
// Admin listener, and forwarded TCP traffic. All endpoints are test-owned loopback
// ports; neither SSH software nor Docker is required.
func TestAddDefaultTunnelAfterAuthenticatedStartup(t *testing.T) {
	token := rand.Text()
	cfg := &v1.ServerConfig{
		BindAddr:      "127.0.0.1",
		BindPort:      availableAdminPort(t),
		ProxyBindAddr: "127.0.0.1",
		Auth:          v1.AuthServerConfig{Token: token},
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

	const responseText = "frpc hot reload forwarding works"
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		written, err := io.WriteString(w, responseText)
		if err != nil || written != len(responseText) {
			t.Errorf("local target response: written=%d error=%v", written, err)
		}
	}))
	t.Cleanup(target.Close)
	targetHost, localPort, err := net.SplitHostPort(target.Listener.Addr().String())
	if err != nil || targetHost != "127.0.0.1" {
		t.Fatalf("target is not the test-owned loopback listener: host=%q error=%v", targetHost, err)
	}

	adminPort := availableAdminPort(t)
	path := filepath.Join(t.TempDir(), "frpc.toml")
	initial := fmt.Sprintf("serverAddr = \"127.0.0.1\"\nserverPort = %d\nauth.token = %q\nwebServer.addr = \"127.0.0.1\"\nwebServer.port = %d\n", cfg.BindPort, token, adminPort)
	if err := os.WriteFile(path, []byte(initial), 0o600); err != nil {
		t.Fatal(err)
	}
	manager := NewManager(path, nil)
	t.Cleanup(func() {
		if err := manager.Stop(); err != nil {
			t.Errorf("FRPC cleanup: %v", err)
		}
	})
	if err := manager.Start(); err != nil {
		t.Fatal(err)
	}
	waitForCoreReady(t, manager)

	remotePort := availableAdminPort(t)
	// No bandwidth settings: this is the ordinary panel-generated SSH/TCP case.
	updated := initial + fmt.Sprintf("[[proxies]]\nname = \"ubuntu.SSH\"\ntype = \"tcp\"\nlocalIP = \"127.0.0.1\"\nlocalPort = %s\nremotePort = %d\n", localPort, remotePort)
	if err := manager.UpdateConfig(updated); err != nil {
		t.Fatalf("valid new tunnel failed to reload: %v", err)
	}
	waitForCoreReady(t, manager)

	transport := &http.Transport{DisableKeepAlives: true}
	defer transport.CloseIdleConnections()
	httpClient := &http.Client{Transport: transport, Timeout: 3 * time.Second}
	response, err := httpClient.Get("http://" + net.JoinHostPort("127.0.0.1", strconv.Itoa(remotePort)))
	if err != nil {
		t.Fatalf("registered tunnel did not forward traffic: %v", err)
	}
	body, err := io.ReadAll(response.Body)
	closeErr := response.Body.Close()
	if err != nil || closeErr != nil || response.StatusCode != http.StatusOK || string(body) != responseText {
		t.Fatalf("unexpected forwarded response: status=%d body=%q read=%v close=%v", response.StatusCode, body, err, closeErr)
	}
}
