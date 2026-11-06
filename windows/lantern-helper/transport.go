// LML VPN: Lantern's IPC speaks cleartext HTTP/2 prior knowledge (h2c).
// The DialContext still authenticates the Windows named pipe before use.
package main

import (
	"context"
	"net"
	"net/http"
)

func newLanternTransport(dial func(context.Context, string, string) (net.Conn, error)) *http.Transport {
	var protocols http.Protocols
	protocols.SetUnencryptedHTTP2(true)
	return &http.Transport{DialContext: dial, Protocols: &protocols, ForceAttemptHTTP2: true}
}
