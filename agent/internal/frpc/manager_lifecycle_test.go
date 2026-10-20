package frpc

import (
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/fatedier/frp/client"
	"github.com/fatedier/frp/client/proxy"
)

// listenerCore uses an actual TCP listener but no FRPS connection. Shutdown can
// be gated, reproducing a core whose control session closes before its Admin API.
type listenerCore struct {
	listener  net.Listener
	gate      <-chan struct{}
	stopping  chan struct{}
	connected atomic.Bool
	grace     atomic.Int64
	modes     map[string]string
}

func (s *listenerCore) Run(ctx context.Context) error {
	<-ctx.Done()
	s.connected.Store(false)
	close(s.stopping)
	if s.gate != nil {
		<-s.gate
	}
	return s.listener.Close()
}

func (s *listenerCore) GracefulClose(d time.Duration)         { s.grace.Store(int64(d)) }
func (s *listenerCore) IsConnected() bool                     { return s.connected.Load() }
func (s *listenerCore) StatusExporter() client.StatusExporter { return readyProxyStatus{} }

type readyProxyStatus struct{}

func (readyProxyStatus) GetProxyStatus(string) (*proxy.WorkingStatus, bool) {
	return &proxy.WorkingStatus{Phase: proxy.ProxyPhaseRunning}, true
}

type listenerHarness struct {
	mu          sync.Mutex
	cores       []*listenerCore
	attempts    int
	failNext    bool
	statuses    []string
	gate        chan struct{}
	releaseOnce sync.Once
}

func (h *listenerHarness) release() {
	if h.gate != nil {
		h.releaseOnce.Do(func() { close(h.gate) })
	}
}

func (h *listenerHarness) snapshot() ([]*listenerCore, int, []string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]*listenerCore(nil), h.cores...), h.attempts, append([]string(nil), h.statuses...)
}

func availableAdminPort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	if err := ln.Close(); err != nil {
		t.Fatal(err)
	}
	return port
}

func tunnelConfig(port int, name, mode string) string {
	text := fmt.Sprintf("serverAddr = \"127.0.0.1\"\nserverPort = 7000\nloginFailExit = false\nwebServer.addr = \"127.0.0.1\"\nwebServer.port = %d\n", port)
	if name != "" {
		text += fmt.Sprintf("[[proxies]]\nname = %q\ntype = \"tcp\"\nlocalIP = \"127.0.0.1\"\nlocalPort = 22\nremotePort = 6000\n", name)
		if mode != "" {
			text += fmt.Sprintf("transport.bandwidthLimitMode = %q\n", mode)
		}
	}
	return text
}

func newListenerManager(t *testing.T, gated bool) (*Manager, *listenerHarness, int) {
	t.Helper()
	port := availableAdminPort(t)
	path := filepath.Join(t.TempDir(), "frpc.toml")
	if err := os.WriteFile(path, []byte(tunnelConfig(port, "", "")), 0o600); err != nil {
		t.Fatal(err)
	}
	m := NewManager(path, nil)
	h := &listenerHarness{}
	if gated {
		h.gate = make(chan struct{})
	}
	m.OnStatus = func(status string) {
		h.mu.Lock()
		h.statuses = append(h.statuses, status)
		h.mu.Unlock()
	}
	m.newService = func(options client.ServiceOptions) (managedService, error) {
		h.mu.Lock()
		h.attempts++
		fail := h.failNext
		h.failNext = false
		h.mu.Unlock()
		if fail {
			return nil, fmt.Errorf("fixture candidate creation failed")
		}
		proxies, _, err := options.ConfigSourceAggregator.Load()
		if err != nil {
			return nil, err
		}
		modes := make(map[string]string)
		for _, cfg := range proxies {
			base := cfg.GetBaseConfig()
			modes[base.Name] = base.Transport.BandwidthLimitMode
		}
		ln, err := net.Listen("tcp", net.JoinHostPort(options.Common.WebServer.Addr, strconv.Itoa(options.Common.WebServer.Port)))
		if err != nil {
			return nil, err
		}
		core := &listenerCore{listener: ln, gate: h.gate, stopping: make(chan struct{}), modes: modes}
		core.connected.Store(true)
		h.mu.Lock()
		h.cores = append(h.cores, core)
		h.mu.Unlock()
		return core, nil
	}
	t.Cleanup(func() {
		h.release()
		m.operationMu.Lock()
		m.stopTimeout = 2 * time.Second
		m.operationMu.Unlock()
		if err := m.Stop(); err != nil {
			t.Errorf("cleanup: %v", err)
		}
	})
	return m, h, port
}

func awaitClosed(t *testing.T, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(2 * time.Second):
		t.Fatal("core lifecycle did not finish")
	}
}

func assertConfig(t *testing.T, m *Manager, expected string) {
	t.Helper()
	data, err := os.ReadFile(m.configPath)
	if err != nil || string(data) != expected {
		t.Fatalf("unexpected config: %q, %v", data, err)
	}
	if _, err := os.Stat(m.configPath + ".next"); !os.IsNotExist(err) {
		t.Fatalf("temporary config not removed: %v", err)
	}
}

func TestUpdateConfigCompletesDefaultBandwidthMode(t *testing.T) {
	for _, mode := range []string{"", "client", "server"} {
		t.Run("mode="+mode, func(t *testing.T) {
			m, h, port := newListenerManager(t, false)
			if err := m.Start(); err != nil {
				t.Fatal(err)
			}
			updated := tunnelConfig(port, "ubuntu.SSH", mode)
			if err := m.UpdateConfig(updated); err != nil {
				t.Fatalf("valid SSH config rejected: %v", err)
			}
			cores, attempts, _ := h.snapshot()
			expected := mode
			if expected == "" {
				expected = "client"
			}
			if len(cores) != 2 || attempts != 2 || cores[1].modes["ubuntu.SSH"] != expected {
				t.Fatalf("defaults not passed to core: %#v, attempts=%d", cores, attempts)
			}
			if !m.Healthy() {
				t.Fatal("new proxy was not tracked by readiness")
			}
			assertConfig(t, m, updated)
			if err := m.UpdateConfig(updated); err != nil {
				t.Fatal(err)
			}
			_, attempts, _ = h.snapshot()
			if attempts != 2 {
				t.Fatal("identical reconnect restarted a working core")
			}
		})
	}
}

func TestInvalidBandwidthModePreservesRunningCore(t *testing.T) {
	for _, mode := range []string{"auto", "CLIENT", "none"} {
		t.Run(mode, func(t *testing.T) {
			m, h, port := newListenerManager(t, false)
			original := tunnelConfig(port, "", "")
			if err := m.Start(); err != nil {
				t.Fatal(err)
			}
			err := m.UpdateConfig(tunnelConfig(port, "ubuntu.SSH", mode))
			if err == nil || !strings.Contains(err.Error(), "bandwidth limit mode") {
				t.Fatalf("invalid mode accepted: %v", err)
			}
			assertConfig(t, m, original)
			_, attempts, statuses := h.snapshot()
			if attempts != 1 || len(statuses) != 1 || !m.Healthy() {
				t.Fatal("preflight failure disturbed the working core")
			}
		})
	}
}

func TestRestartWaitsForListenerAndStoppedEvent(t *testing.T) {
	m, h, port := newListenerManager(t, true)
	if err := m.Start(); err != nil {
		t.Fatal(err)
	}
	cores, _, _ := h.snapshot()
	result := make(chan error, 1)
	go func() { result <- m.Restart() }()
	awaitClosed(t, cores[0].stopping)
	// The old implementation started another core after a fixed 500 ms.
	select {
	case err := <-result:
		t.Fatalf("restart returned before old listener release: %v", err)
	case <-time.After(650 * time.Millisecond):
	}
	_, attempts, _ := h.snapshot()
	if attempts != 1 || m.Healthy() || m.IsRunning() {
		t.Fatal("stopping core was treated as ready, or new core started early")
	}
	if time.Duration(cores[0].grace.Load()) != time.Second {
		t.Fatal("graceful shutdown duration was not preserved")
	}
	h.release()
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("restart did not resume after listener release")
	}
	_, attempts, statuses := h.snapshot()
	if attempts != 2 || strings.Join(statuses, ",") != "running,stopped,running" {
		t.Fatalf("out-of-order lifecycle: attempts=%d statuses=%v", attempts, statuses)
	}
	if err := m.Stop(); err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		t.Fatalf("Stop returned before admin listener release: %v", err)
	}
	if err := ln.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestStopTimeoutKeepsServiceSlotUntilRunExits(t *testing.T) {
	m, h, _ := newListenerManager(t, true)
	m.stopTimeout = 30 * time.Millisecond
	if err := m.Start(); err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	done := m.done
	m.mu.Unlock()
	if err := m.Restart(); err == nil || !strings.Contains(err.Error(), "退出超时") {
		t.Fatalf("stuck shutdown was not bounded: %v", err)
	}
	if err := m.Start(); err == nil {
		t.Fatal("Start replaced a core that had not finished shutdown")
	}
	_, attempts, _ := h.snapshot()
	if attempts != 1 {
		t.Fatal("timeout created a second listener")
	}
	h.release()
	awaitClosed(t, done)
	if err := m.Start(); err != nil {
		t.Fatalf("slot not released after Run exited: %v", err)
	}
}

func TestUpdateShutdownTimeoutRestoresConfigWithoutSecondCore(t *testing.T) {
	m, h, port := newListenerManager(t, true)
	m.stopTimeout = 30 * time.Millisecond
	original := tunnelConfig(port, "", "")
	if err := m.Start(); err != nil {
		t.Fatal(err)
	}
	if err := m.UpdateConfig(tunnelConfig(port, "ubuntu.SSH", "")); err == nil {
		t.Fatal("update succeeded while old listener was still owned")
	}
	assertConfig(t, m, original)
	_, attempts, _ := h.snapshot()
	if attempts != 1 {
		t.Fatal("failed update/rollback created a competing core")
	}
}

func TestFailedCandidateRestoresOldConfigAndCore(t *testing.T) {
	m, h, port := newListenerManager(t, false)
	original := tunnelConfig(port, "", "")
	if err := m.Start(); err != nil {
		t.Fatal(err)
	}
	h.mu.Lock()
	h.failNext = true
	h.mu.Unlock()
	if err := m.UpdateConfig(tunnelConfig(port, "ubuntu.SSH", "")); err == nil {
		t.Fatal("candidate startup failure was not reported")
	}
	assertConfig(t, m, original)
	cores, attempts, _ := h.snapshot()
	if attempts != 3 || len(cores) != 2 || !m.Healthy() {
		t.Fatalf("old core not restored: attempts=%d cores=%d", attempts, len(cores))
	}
}

func TestConcurrentLifecycleTransactions(t *testing.T) {
	m, h, port := newListenerManager(t, false)
	if err := m.Start(); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	errors := make(chan error, 12)
	for i := range 12 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			switch i % 3 {
			case 0:
				if err := m.Start(); err != nil && !strings.Contains(err.Error(), "已在运行") {
					errors <- err
				}
			case 1:
				if err := m.Stop(); err != nil {
					errors <- err
				}
			case 2:
				if err := m.UpdateConfig(tunnelConfig(port, fmt.Sprintf("ssh-%d", i), "")); err != nil {
					errors <- err
				}
			}
		}()
	}
	wg.Wait()
	close(errors)
	for err := range errors {
		t.Error(err)
	}
	if err := m.Stop(); err != nil {
		t.Fatal(err)
	}
	cores, _, statuses := h.snapshot()
	if len(statuses) != len(cores)*2 {
		t.Fatalf("missing lifecycle events: cores=%d statuses=%v", len(cores), statuses)
	}
	for i, status := range statuses {
		expected := "running"
		if i%2 == 1 {
			expected = "stopped"
		}
		if status != expected {
			t.Fatalf("stale core status overwrote newer status: %v", statuses)
		}
	}
}

func TestRealCoreRepeatedReloadReleasesAdminListener(t *testing.T) {
	// Own the login endpoint instead of connecting to any real local FRPS.
	// Closing accepted connections keeps this lifecycle test deterministic.
	login, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	loginDone := make(chan struct{})
	go func() {
		defer close(loginDone)
		for {
			conn, err := login.Accept()
			if err != nil {
				return
			}
			_ = conn.Close()
		}
	}()
	t.Cleanup(func() {
		if err := login.Close(); err != nil {
			t.Error(err)
		}
		awaitClosed(t, loginDone)
	})
	port := availableAdminPort(t)
	realConfig := func(name string) string {
		return strings.Replace(tunnelConfig(port, name, ""), "serverPort = 7000",
			fmt.Sprintf("serverPort = %d", login.Addr().(*net.TCPAddr).Port), 1)
	}
	path := filepath.Join(t.TempDir(), "frpc.toml")
	if err := os.WriteFile(path, []byte(realConfig("")), 0o600); err != nil {
		t.Fatal(err)
	}
	m := NewManager(path, nil)
	t.Cleanup(func() {
		if err := m.Stop(); err != nil {
			t.Errorf("real core cleanup: %v", err)
		}
	})
	for i := range 10 {
		if err := m.Start(); err != nil {
			t.Fatalf("start %d: %v", i, err)
		}
		if err := m.UpdateConfig(realConfig(fmt.Sprintf("ubuntu.SSH-%d", i))); err != nil {
			t.Fatalf("reload %d: %v", i, err)
		}
		if err := m.Stop(); err != nil {
			t.Fatalf("stop %d: %v", i, err)
		}
		ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			t.Fatalf("listener leaked at cycle %d: %v", i, err)
		}
		if err := ln.Close(); err != nil {
			t.Fatal(err)
		}
	}
}
