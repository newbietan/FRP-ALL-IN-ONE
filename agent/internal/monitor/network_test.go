package monitor

import (
	"os"
	"testing"
)

func TestScoreIP(t *testing.T) {
	tests := []struct {
		name     string
		ip       string
		envIP    string
		expected int
	}{
		{"EnvMatch", "192.168.1.50", "192.168.1.50", 1000},
		{"192.168", "192.168.1.14", "", 800},
		{"10.x", "10.0.0.5", "", 700},
		{"172.16", "172.20.0.5", "", 600},
		{"172.17(docker)", "172.17.0.1", "", 400},
		{"PublicIP", "1.2.3.4", "", 500},
		{"Loopback", "127.0.0.1", "", -100},
		{"Invalid", "not-an-ip", "", -100},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			score := scoreIP(tt.ip, tt.envIP)
			if score != tt.expected {
				t.Errorf("scoreIP(%s, %s) = %d; want %d", tt.ip, tt.envIP, score, tt.expected)
			}
		})
	}
}

func TestSelectBestHostIP(t *testing.T) {
	candidates := []string{"172.17.0.1", "192.168.1.14", "10.0.0.2"}
	best := selectBestHostIP(candidates, "")
	if best != "192.168.1.14" {
		t.Errorf("selectBestHostIP() = %s; want 192.168.1.14", best)
	}

	// When env IP is provided, it must win
	bestWithEnv := selectBestHostIP(candidates, "10.0.0.2")
	if bestWithEnv != "10.0.0.2" {
		t.Errorf("selectBestHostIP() with env = %s; want 10.0.0.2", bestWithEnv)
	}
}

func TestDetectHostIPWithEnv(t *testing.T) {
	os.Setenv("FRP_HOST_IP", "192.168.100.88")
	defer os.Unsetenv("FRP_HOST_IP")

	primary, candidates := DetectHostIP()
	if primary != "192.168.100.88" {
		t.Errorf("DetectHostIP() primary = %s; want 192.168.100.88", primary)
	}
	found := false
	for _, c := range candidates {
		if c == "192.168.100.88" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("candidates %v does not contain 192.168.100.88", candidates)
	}
}
