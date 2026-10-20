package frpc

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/fatedier/frp/pkg/config"
)

func TestInvalidUpdatePreservesWorkingConfiguration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "frpc.toml")
	original := "serverAddr = \"127.0.0.1\"\nserverPort = 7000\n"
	if err := os.WriteFile(path, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	manager := NewManager(path, nil)
	if err := manager.UpdateConfig("this is not valid TOML [[[{"); err == nil {
		t.Fatal("accepted invalid update")
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != original {
		t.Fatalf("old config changed: %s, %v", data, err)
	}
}

func TestIdenticalReconnectionDoesNotRestartCore(t *testing.T) {
	path := filepath.Join(t.TempDir(), "frpc.toml")
	original := "serverAddr = \"127.0.0.1\"\nserverPort = 7000\n"
	if err := os.WriteFile(path, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	manager := NewManager(path, nil)
	manager.isRunning = true
	if err := manager.UpdateConfig(original); err != nil {
		t.Fatal(err)
	}
	if !manager.isRunning {
		t.Fatal("identical config restarted the core")
	}
	if _, err := os.Stat(path + ".bak"); !os.IsNotExist(err) {
		t.Fatal("unnecessary backup/reload on reconnect")
	}
}

func TestTemporaryConfigIsRecognizedAsTOML(t *testing.T) {
	path := filepath.Join(t.TempDir(), "frpc.toml.next")
	content := "serverAddr = \"127.0.0.1\"\nserverPort = 7000\n[[proxies]]\nname = \"ssh\"\ntype = \"tcp\"\nlocalPort = 22\nremotePort = 6000\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := config.LoadClientConfigResult(path, false)
	if err != nil || len(result.Proxies) != 1 {
		t.Fatalf("temporary config not parsed correctly: %v", err)
	}
	if err := completeAndValidateConfig(result); err != nil {
		t.Fatalf("ordinary tunnel rejected during preflight: %v", err)
	}
	if mode := result.Proxies[0].GetBaseConfig().Transport.BandwidthLimitMode; mode != "client" {
		t.Fatalf("missing default bandwidth mode: %q", mode)
	}
}

func TestPreflightCompletesVisitorDefaults(t *testing.T) {
	path := filepath.Join(t.TempDir(), "frpc.toml.next")
	content := "serverAddr = \"127.0.0.1\"\nserverPort = 7000\n[[visitors]]\nname = \"visitor\"\ntype = \"stcp\"\nserverName = \"peer\"\nbindPort = 6001\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := config.LoadClientConfigResult(path, false)
	if err != nil || len(result.Visitors) != 1 {
		t.Fatalf("visitor not parsed correctly: %v", err)
	}
	if err := completeAndValidateConfig(result); err != nil {
		t.Fatalf("visitor rejected during preflight: %v", err)
	}
	if addr := result.Visitors[0].GetBaseConfig().BindAddr; addr != "127.0.0.1" {
		t.Fatalf("missing default bind address: %q", addr)
	}
}
