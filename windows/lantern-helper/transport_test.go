package main

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"path/filepath"
	"testing"
	"time"
)

// Radiance's IPC explicitly accepts h2c, not HTTP/1.1. A default Go
// http.Transport silently sends HTTP/1.1 to a custom DialContext and fails.
func TestLanternTransportUsesH2CPriorKnowledge(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "lantern.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	var protocols http.Protocols
	protocols.SetUnencryptedHTTP2(true)
	server := &http.Server{Protocols: &protocols, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.ProtoMajor != 2 {
			t.Errorf("got %s, want HTTP/2", r.Proto)
		}
		_ = json.NewEncoder(w).Encode("disconnected")
	})}
	go func() { _ = server.Serve(listener) }()
	defer server.Close()
	transport := newLanternTransport(func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "unix", socket)
	})
	defer transport.CloseIdleConnections()
	client := http.Client{Transport: transport, Timeout: 5 * time.Second}
	resp, err := client.Get("http://pipe/vpn/status")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var state string
	if err := json.NewDecoder(resp.Body).Decode(&state); err != nil {
		t.Fatal(err)
	}
	if resp.ProtoMajor != 2 || state != "disconnected" {
		t.Fatalf("got %s, %q", resp.Proto, state)
	}
}
