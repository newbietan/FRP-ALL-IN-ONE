package ws

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestManagementURLRequiresTLS(t *testing.T) {
	t.Setenv("FRP_ALLOW_INSECURE_HTTP", "")
	for _, test := range []struct {
		url     string
		allowed bool
	}{
		{"wss://panel.example/ws/agent/device", true},
		{"ws://127.0.0.1/ws/agent/device", true},
		{"ws://[::1]/ws/agent/device", true},
		{"ws://localhost/ws/agent/device", true},
		{"ws://panel.example/ws/agent/device", false},
		{"ws://127.0.0.1.attacker.example/ws", false},
		{"https://panel.example/ws", false},
		{"wss://user:secret@panel.example/ws", false},
		{"wss:///missing-host", false},
	} {
		t.Run(test.url, func(t *testing.T) {
			if allowed := validateServerURL(test.url) == nil; allowed != test.allowed {
				t.Fatalf("allowed=%v, want %v", allowed, test.allowed)
			}
		})
	}
	t.Setenv("FRP_ALLOW_INSECURE_HTTP", "1")
	if err := validateServerURL("ws://panel.example/ws/agent/device"); err != nil {
		t.Fatalf("explicit development opt-in rejected: %v", err)
	}
}

func TestSelfSignedTLSFingerprint(t *testing.T) {
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
	}))
	defer server.Close()

	wsURL := "wss" + strings.TrimPrefix(server.URL, "https")
	cert := server.Certificate()
	sum := sha256.Sum256(cert.Raw)
	actualFP := hex.EncodeToString(sum[:])
	wrongFP := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

	// Case 1: Default verification fails on untrusted self-signed cert
	c1 := NewClient(wsURL, "client-1", "token", "test")
	if err := c1.connect(); err == nil {
		c1.Close()
		t.Fatalf("expected connect to fail on self-signed cert without options")
	}

	// Case 2: InsecureTLS connects successfully
	c2 := NewClient(wsURL, "client-2", "token", "test").WithTLS(true, "")
	if err := c2.connect(); err != nil {
		t.Fatalf("expected connect to succeed with InsecureTLS: %v", err)
	}
	c2.Close()

	// Case 3: Correct Fingerprint connects successfully
	c3 := NewClient(wsURL, "client-3", "token", "test").WithTLS(false, actualFP)
	if err := c3.connect(); err != nil {
		t.Fatalf("expected connect to succeed with matching fingerprint: %v", err)
	}
	c3.Close()

	// Case 4: Wrong Fingerprint fails
	c4 := NewClient(wsURL, "client-4", "token", "test").WithTLS(false, wrongFP)
	if err := c4.connect(); err == nil {
		c4.Close()
		t.Fatalf("expected connect to fail with wrong fingerprint")
	}
}

func TestSendSerializesConcurrentWrites(t *testing.T) {
	const messageCount = 100
	received := make(chan Message, messageCount)
	serverErrors := make(chan error, 1)

	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			serverErrors <- err
			return
		}
		defer conn.Close()

		for i := 0; i < messageCount; i++ {
			_, payload, err := conn.ReadMessage()
			if err != nil {
				serverErrors <- err
				return
			}
			var msg Message
			if err := json.Unmarshal(payload, &msg); err != nil {
				serverErrors <- err
				return
			}
			received <- msg
		}
	}))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial websocket: %v", err)
	}

	client := NewClient(wsURL, "client-1", "token", "test")
	client.conn = conn
	defer client.Close()

	var wg sync.WaitGroup
	for i := 0; i < messageCount; i++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			if err := client.Send("metric", index); err != nil {
				t.Errorf("send %d: %v", index, err)
			}
		}(i)
	}
	wg.Wait()

	for i := 0; i < messageCount; i++ {
		select {
		case msg := <-received:
			if msg.Type != "metric" {
				t.Fatalf("unexpected message type: %s", msg.Type)
			}
		case err := <-serverErrors:
			t.Fatalf("server read failed: %v", err)
		case <-time.After(5 * time.Second):
			t.Fatal(fmt.Errorf("timed out waiting for message %d", i+1))
		}
	}
}
