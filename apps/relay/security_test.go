package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"github.com/coder/websocket"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestChallengeConsumeReplayAndExpiry(t *testing.T) {
	c := testConfig()
	c.Auth = "password"
	c.Verifier = make([]byte, 32)
	s := newServer(c)
	now := time.Now()
	s.now = func() time.Time { return now }
	var challenge struct{ Challenge string }
	invoke(t, s, "POST", api+"room-challenges", map[string]any{}, 200, &challenge)
	options := json.RawMessage(`{"players":4,"identityMode":"mixed","factionCounts":null,"threshold":11}`)
	q := AllocationRequest{protocol, c.Origin, challenge.Challenge, randomHex(16), randomHex(32), randomHex(32), hash("ru/lobby-options/v1", options), randomHex(16), options}
	wrong := map[string]any{"request": q, "proof": strings.Repeat("ff", 32)}
	invoke(t, s, "POST", api+"rooms", wrong, 401, nil)
	correct := map[string]any{"request": q, "proof": mac(c.Verifier, "ru/relay-create/v1", q)}
	invoke(t, s, "POST", api+"rooms", correct, 401, nil)
	invoke(t, s, "POST", api+"room-challenges", map[string]any{}, 200, &challenge)
	q.Challenge = challenge.Challenge
	now = now.Add(31 * time.Second)
	invoke(t, s, "POST", api+"rooms", map[string]any{"request": q, "proof": mac(c.Verifier, "ru/relay-create/v1", q)}, 401, nil)
}
func TestTrustedProxyChain(t *testing.T) {
	c := testConfig()
	_, cidr, _ := net.ParseCIDR("127.0.0.1/32")
	c.TrustedProxies = []*net.IPNet{cidr}
	s := newServer(c)
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "127.0.0.1:12"
	r.Header.Set("X-Forwarded-For", "198.51.100.100, 203.0.113.10")
	if got := s.clientIP(r); got != "203.0.113.10" {
		t.Fatal("trusted proxy chain selected spoofed left address")
	}
	r.RemoteAddr = "192.0.2.1:12"
	if got := s.clientIP(r); got != "192.0.2.1" {
		t.Fatal("untrusted proxy accepted headers")
	}
}
func TestSecretFileFailClosed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "password")
	if e := os.WriteFile(path, []byte("public-test-password\n"), 0600); e != nil {
		t.Fatal(e)
	}
	t.Setenv("CREATE_PASSWORD", "")
	t.Setenv("CREATE_PASSWORD_FILE", path)
	value, e := secretEnv("CREATE_PASSWORD")
	if e != nil || value != "public-test-password" {
		t.Fatal("secret file not read")
	}
	t.Setenv("CREATE_PASSWORD", "ambiguous-test-value")
	if _, e = secretEnv("CREATE_PASSWORD"); e == nil {
		t.Fatal("ambiguous secret accepted")
	}
	t.Setenv("CREATE_PASSWORD", "")
	t.Setenv("CREATE_PASSWORD_FILE", path+".missing")
	if _, e = secretEnv("CREATE_PASSWORD"); e == nil {
		t.Fatal("missing secret accepted")
	}
}
func TestStolenAdmissionDoesNotAuthenticate(t *testing.T) {
	s := newServer(testConfig())
	_, _, _, ticket, _ := allocateTest(t, s)
	h := httptest.NewServer(s)
	defer h.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	c, _, e := websocket.Dial(ctx, strings.Replace(h.URL, "http", "ws", 1)+api+"ws", &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{"http://client.test"}}})
	if e != nil {
		t.Fatal(e)
	}
	defer c.CloseNow()
	writeTest(t, c, map[string]any{"v": protocol, "kind": "authenticate", "admission": ticket})
	challenge := readTest(t, c)
	_, attacker, _ := ed25519.GenerateKey(rand.Reader)
	writeTest(t, c, map[string]any{"v": protocol, "kind": "proof", "signature": signed(attacker, "ru/relay-connect/v1", challenge["value"])})
	if _, _, e = c.Read(ctx); e == nil {
		t.Fatal("stolen ticket authenticated")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.rooms[ticket.Ticket.Code].Peers) != 0 {
		t.Fatal("unauthorized member allocated")
	}
}
func TestOriginAndForgedProxyHeaders(t *testing.T) {
	s := newServer(testConfig())
	for i := 0; i < 11; i++ {
		r := httptest.NewRequest("POST", api+"room-challenges", strings.NewReader("{}"))
		r.RemoteAddr = "127.0.0.1:123"
		r.Header.Set("X-Forwarded-For", hex.EncodeToString([]byte{byte(i)}))
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if i == 10 && w.Code != 429 {
			t.Fatal("spoofed proxy header bypassed limit")
		}
	}
	r := httptest.NewRequest("GET", api+"ws", nil)
	r.Header.Set("Origin", "https://evil.example")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("WS origin not rejected")
	}
}
func TestInactiveRoomNotRenewedByQueries(t *testing.T) {
	s := newServer(testConfig())
	now := time.Now()
	s.now = func() time.Time { return now }
	d, _, _, _, _ := allocateTest(t, s)
	room := s.rooms[d.Descriptor.Code]
	room.EverConnected = true
	now = now.Add(29 * time.Minute)
	invoke(t, s, "GET", api+"rooms/"+d.Descriptor.Code, nil, 200, nil)
	now = now.Add(time.Minute)
	s.sweepLocked()
	if len(s.rooms) != 0 {
		t.Fatal("query renewed room")
	}
}
func TestBoundedQueueDoesNotBlockOtherRooms(t *testing.T) {
	s := newServer(testConfig())
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	p := &Peer{queue: make(chan []byte, 128), cancel: cancel}
	s.mu.Lock()
	for i := 0; i < 128; i++ {
		if !s.enqueueLocked(p, map[string]any{"kind": "test"}) {
			t.Fatal("premature limit")
		}
	}
	if s.enqueueLocked(p, map[string]any{"kind": "overflow"}) {
		t.Fatal("unbounded queue")
	}
	s.mu.Unlock()
	select {
	case <-ctx.Done():
	default:
		t.Fatal("slow connection not cancelled")
	}
}
func TestOversizeAndFloodDisconnectReleaseResources(t *testing.T) {
	for _, mode := range []string{"oversize", "flood"} {
		t.Run(mode, func(t *testing.T) {
			s := newServer(testConfig())
			_, _, key, ticket, _ := allocateTest(t, s)
			h := httptest.NewServer(s)
			defer h.Close()
			c := connectTest(t, h.URL, ticket, key)
			defer c.CloseNow()
			writeTest(t, c, map[string]any{"v": protocol, "kind": "subscribe", "channel": "game", "id": "subscribe"})
			_ = readTest(t, c)
			ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
			defer cancel()
			if mode == "oversize" {
				_ = c.Write(ctx, websocket.MessageText, wire(map[string]any{"v": protocol, "kind": "send", "channel": "game", "id": "large", "value": strings.Repeat("x", frameLimit)}))
			} else {
				for i := 0; i < 300; i++ {
					if c.Write(ctx, websocket.MessageText, wire(map[string]any{"v": protocol, "kind": "keepalive", "id": "flood"})) != nil {
						break
					}
				}
			}
			for {
				if _, _, e := c.Read(ctx); e != nil {
					break
				}
			}
			if ctx.Err() != nil {
				t.Fatal("abusive connection did not close within deadline")
			}
			deadline := time.Now().Add(time.Second)
			for time.Now().Before(deadline) {
				s.mu.Lock()
				released := s.connections == 0 && s.queued == 0
				s.mu.Unlock()
				if released {
					invoke(t, s, "GET", "/healthz", nil, 200, nil)
					return
				}
				time.Sleep(time.Millisecond)
			}
			t.Fatal("connection or queued resources retained")
		})
	}
}
