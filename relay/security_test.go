package main

import (
	"bytes"
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
	q := AllocationRequest{protocol, c.Origin, challenge.Challenge, randomHex(16), randomHex(32), randomHex(32), hash("romzo/lobby-options/v1", options), randomHex(16), options}
	wrong := map[string]any{"request": q, "proof": strings.Repeat("ff", 32)}
	invoke(t, s, "POST", api+"rooms", wrong, 401, nil)
	correct := map[string]any{"request": q, "proof": mac(c.Verifier, "romzo/relay-create/v1", q)}
	invoke(t, s, "POST", api+"rooms", correct, 401, nil)
	invoke(t, s, "POST", api+"room-challenges", map[string]any{}, 200, &challenge)
	q.Challenge = challenge.Challenge
	now = now.Add(31 * time.Second)
	invoke(t, s, "POST", api+"rooms", map[string]any{"request": q, "proof": mac(c.Verifier, "romzo/relay-create/v1", q)}, 401, nil)
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
	c, _, e := websocket.Dial(ctx, strings.Replace(h.URL, "http", "ws", 1)+wsPath, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{"http://client.test"}}})
	if e != nil {
		t.Fatal(e)
	}
	defer c.CloseNow()
	writeTest(t, c, map[string]any{"v": protocol, "kind": "authenticate", "admission": ticket})
	challenge := readTest(t, c)
	_, attacker, _ := ed25519.GenerateKey(rand.Reader)
	writeTest(t, c, map[string]any{"v": protocol, "kind": "proof", "signature": signed(attacker, "romzo/relay-connect/v1", challenge["value"])})
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
	r := httptest.NewRequest("GET", wsPath, nil)
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

func turnstileHarness(t *testing.T, behavior string) (*Server, *httptest.Server, *int) {
	t.Helper()
	calls := 0
	verify := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if e := r.ParseForm(); e != nil {
			t.Error(e)
			return
		}
		if r.Form.Get("secret") != "test-turnstile-secret" {
			t.Error("siteverify secret mismatch")
		}
		if r.Form.Get("remoteip") == "" {
			t.Error("siteverify remoteip missing")
		}
		switch behavior {
		case "http500":
			w.WriteHeader(http.StatusInternalServerError)
		default:
			if r.Form.Get("response") == "good-token" {
				_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
			} else {
				_ = json.NewEncoder(w).Encode(map[string]any{"success": false, "error-codes": []string{"invalid-input-response"}})
			}
		}
	}))
	cfg := testConfig()
	cfg.TurnstileSecret = "test-turnstile-secret"
	cfg.TurnstileURL = verify.URL
	return newServer(cfg), verify, &calls
}

func allocateWithToken(t *testing.T, s *Server, token string, status int) Descriptor {
	t.Helper()
	hp, _, _ := ed25519.GenerateKey(rand.Reader)
	tp, _, _ := ed25519.GenerateKey(rand.Reader)
	var c struct{ Challenge string }
	invoke(t, s, "POST", api+"room-challenges", map[string]any{}, 200, &c)
	options := json.RawMessage(`{"players":4,"identityMode":"mixed","factionCounts":null,"threshold":11}`)
	q := AllocationRequest{protocol, s.cfg.Origin, c.Challenge, randomHex(16), hex.EncodeToString(hp), hex.EncodeToString(tp), hash("romzo/lobby-options/v1", options), randomHex(16), options}
	var d Descriptor
	invoke(t, s, "POST", api+"rooms", map[string]any{"request": q, "turnstile": token}, status, &d)
	return d
}

func TestTurnstileEnforcedOnlyAtAllocation(t *testing.T) {
	s, verify, calls := turnstileHarness(t, "success")
	defer verify.Close()
	allocateWithToken(t, s, "", 403)          // turnstile_required
	allocateWithToken(t, s, "bad-token", 403) // turnstile_failed; challenge stays unconsumed
	if *calls != 1 {
		t.Fatal("missing or rejected token must not skip verification")
	}
	hostPub, hostPriv, _ := ed25519.GenerateKey(rand.Reader)
	tp, tpPriv, _ := ed25519.GenerateKey(rand.Reader)
	var c struct{ Challenge string }
	invoke(t, s, "POST", api+"room-challenges", map[string]any{}, 200, &c)
	options := json.RawMessage(`{"players":4,"identityMode":"mixed","factionCounts":null,"threshold":11}`)
	q := AllocationRequest{protocol, s.cfg.Origin, c.Challenge, randomHex(16), hex.EncodeToString(hostPub), hex.EncodeToString(tp), hash("romzo/lobby-options/v1", options), randomHex(16), options}
	body := map[string]any{"request": q, "turnstile": "good-token"}
	var d Descriptor
	invoke(t, s, "POST", api+"rooms", body, 200, &d)
	// Idempotent replay with the same requestId returns the descriptor without
	// re-verifying the (already spent) token.
	var again Descriptor
	invoke(t, s, "POST", api+"rooms", body, 200, &again)
	if d.Code != again.Code || *calls != 2 {
		t.Fatal("replay re-verified or changed room")
	}
	// Join and restore paths never ask for Turnstile.
	sdesc := SignedDescriptor{d, signed(hostPriv, "romzo/relay-descriptor/v1", d)}
	var tickets struct {
		Admission SignedTicket
		Recovery  SignedTicket
	}
	invoke(t, s, "POST", api+"rooms/"+d.Code+"/confirm", sdesc, 200, &tickets)
	_, guest, _ := ed25519.GenerateKey(rand.Reader)
	invoke(t, s, "POST", api+"rooms/"+d.Code+"/admissions", map[string]string{"key": hex.EncodeToString(guest.Public().(ed25519.PublicKey))}, 200, nil)
	fresh := newServer(s.cfg)
	invoke(t, fresh, "POST", api+"rooms/"+d.Code+"/restore", map[string]any{"signed": sdesc, "recovery": tickets.Recovery, "signature": signed(tpPriv, "romzo/relay-restore/v1", tickets.Recovery)}, 200, nil)
	if *calls != 2 {
		t.Fatal("non-allocation endpoint triggered verification")
	}
	var discovery struct {
		Turnstile bool   `json:"turnstile"`
		Version   string `json:"version"`
	}
	invoke(t, s, "GET", "/.well-known/romzo", nil, 200, &discovery)
	if !discovery.Turnstile {
		t.Fatal("discovery does not announce turnstile")
	}
	if discovery.Version != version {
		t.Fatal("discovery does not report relay version")
	}
}

func TestTurnstileFailClosedWhenVerifierDown(t *testing.T) {
	s, verify, _ := turnstileHarness(t, "http500")
	defer verify.Close()
	allocateWithToken(t, s, "good-token", 503)
}

func TestCreateAuthOffAndTurnstileConfig(t *testing.T) {
	t.Setenv("PUBLIC_ORIGIN", "http://127.0.0.1")
	t.Setenv("AUTH_SALT", strings.Repeat("ab", 32))
	t.Setenv("TICKET_KEY", strings.Repeat("cd", 32))
	t.Setenv("CREATE_AUTH", "off")
	c, e := config()
	if e != nil || c.Auth != "off" {
		t.Fatal("CREATE_AUTH=off rejected")
	}
	if len(c.Verifier) != 0 {
		t.Fatal("off mode derived a password verifier")
	}
	s := newServer(c)
	if _, ok := s.auth.(anonymousAuthorizer); !ok {
		t.Fatal("off mode installed a password authorizer")
	}
	t.Setenv("TURNSTILE_SECRET", "test-only-turnstile-secret")
	t.Setenv("TURNSTILE_VERIFY_URL", "://malformed")
	if _, e := config(); e == nil {
		t.Fatal("malformed TURNSTILE_VERIFY_URL accepted")
	}
	t.Setenv("TURNSTILE_VERIFY_URL", "")
	c, e = config()
	if e != nil || c.TurnstileURL != "https://challenges.cloudflare.com/turnstile/v0/siteverify" {
		t.Fatal("default siteverify URL not applied")
	}
}

func TestIPByteBudgetIsSharedAcrossRealSocketsAndCountsPadding(t *testing.T) {
	cfg := testConfig()
	cfg.IPBytesPerSecond = 160
	s := newServer(cfg)
	now := time.Now()
	s.now = func() time.Time { return now }
	_, _, firstKey, firstTicket, _ := allocateTest(t, s)
	// Different rooms and channels still share the same source-IP budget.
	_, _, secondKey, secondTicket, _ := allocateTest(t, s)
	httpServer := httptest.NewServer(s)
	defer httpServer.Close()
	first := connectTest(t, httpServer.URL, firstTicket, firstKey)
	defer first.CloseNow()
	second := connectTest(t, httpServer.URL, secondTicket, secondKey)
	defer second.CloseNow()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	frame := wire(map[string]any{"v": protocol, "kind": "subscribe", "channel": "game", "id": "a"})
	frame = append(frame, bytes.Repeat([]byte(" "), 200)...)
	if err := first.Write(ctx, websocket.MessageText, frame); err != nil {
		t.Fatal(err)
	}
	if readTest(t, first)["kind"] != "ack" {
		t.Fatal("first padded frame rejected")
	}
	writeTest(t, second, map[string]any{"v": protocol, "kind": "subscribe", "channel": "lobby", "id": "b"})
	terminal := readTest(t, second)
	if terminal["kind"] != "error" || terminal["error"] != "frame_or_byte_rate" {
		t.Fatal("second connection bypassed aggregate byte budget")
	}
	if _, _, err := second.Read(ctx); err == nil {
		t.Fatal("terminal error did not disconnect")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.allowCostLocked("ws-bytes/198.51.100.2", 64, 128, 100) {
		t.Fatal("another IP inherited exhausted bucket")
	}
	now = now.Add(time.Second)
	if !s.allowCostLocked("ws-bytes/127.0.0.1", 160, 320, 50) {
		t.Fatal("monotonic refill failed")
	}
}
