package frpc

import (
	"context"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/fatedier/frp/client"
	"github.com/fatedier/frp/client/proxy"
)

type registrationStatus struct{ ready atomic.Bool }

func (s *registrationStatus) GetProxyStatus(name string) (*proxy.WorkingStatus, bool) {
	if s.ready.Load() {
		return &proxy.WorkingStatus{Name: name, Phase: proxy.ProxyPhaseRunning}, true
	}
	return &proxy.WorkingStatus{
		Name: name, Phase: proxy.ProxyPhaseStartErr, Err: "fixture remote port unavailable",
	}, true
}

type registrationService struct {
	managedService
	status *registrationStatus
}

func (s *registrationService) StatusExporter() client.StatusExporter { return s.status }

func holdRegistration(m *Manager) *registrationStatus {
	status := &registrationStatus{}
	factory := m.newService
	m.newService = func(options client.ServiceOptions) (managedService, error) {
		core, err := factory(options)
		if err != nil {
			return nil, err
		}
		return &registrationService{managedService: core, status: status}, nil
	}
	return status
}

func TestApplyConfigWaitsForProxyRegistration(t *testing.T) {
	m, _, port := newListenerManager(t, false)
	m.readyTimeout = 2 * time.Second
	status := holdRegistration(m)
	updated := tunnelConfig(port, "ubuntu.SSH", "")
	result := make(chan error, 1)
	go func() { result <- m.ApplyConfig(updated) }()
	select {
	case err := <-result:
		t.Fatalf("reported completion before proxy registration: %v", err)
	case <-time.After(80 * time.Millisecond):
	}
	status.ready.Store(true)
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("config acknowledgment did not follow proxy registration")
	}
	if !m.Healthy() {
		t.Fatal("acknowledged config was not healthy")
	}
}

func TestApplyTimeoutKeepsDesiredConfigAndChecksIdenticalConfigReadiness(t *testing.T) {
	m, h, port := newListenerManager(t, false)
	m.readyTimeout = 80 * time.Millisecond
	status := holdRegistration(m)
	updated := tunnelConfig(port, "ubuntu.SSH", "")
	for attempt := 0; attempt < 2; attempt++ {
		err := m.ApplyConfig(updated)
		if err == nil || !strings.Contains(err.Error(), "ubuntu.SSH") || !strings.Contains(err.Error(), "fixture remote port unavailable") {
			t.Fatalf("missing proxy failure detail (attempt %d): %v", attempt, err)
		}
		assertConfig(t, m, updated)
		if !m.IsRunning() || m.Healthy() {
			t.Fatal("readiness timeout stopped retries or marked the proxy healthy")
		}
	}
	status.ready.Store(true)
	if err := m.ApplyConfig(updated); err != nil {
		t.Fatalf("same config could not recover after proxy registration: %v", err)
	}
	_, attempts, _ := h.snapshot()
	if attempts != 1 {
		t.Fatalf("rechecking identical config unnecessarily restarted the core: %d", attempts)
	}
}

type exitingService struct{}

func (exitingService) Run(context.Context) error {
	return fmt.Errorf("fixture asynchronous core failure")
}
func (exitingService) GracefulClose(time.Duration)           {}
func (exitingService) IsConnected() bool                     { return false }
func (exitingService) StatusExporter() client.StatusExporter { return readyProxyStatus{} }

func TestApplyReportsAsynchronousCoreExit(t *testing.T) {
	m, _, port := newListenerManager(t, false)
	m.newService = func(client.ServiceOptions) (managedService, error) { return exitingService{}, nil }
	err := m.ApplyConfig(tunnelConfig(port, "ubuntu.SSH", ""))
	if err == nil || !strings.Contains(err.Error(), "fixture asynchronous core failure") {
		t.Fatalf("core exit was incorrectly acknowledged: %v", err)
	}
}
