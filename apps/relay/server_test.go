package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"github.com/coder/websocket"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func testConfig() Config {
	return Config{Origin: "http://127.0.0.1", Auth: "anonymous", Salt: make([]byte, 32), TicketKey: bytes.Repeat([]byte{7}, 32), ClientOrigins: []string{"http://client.test"}, Rooms: 64, Connections: 512, Unauthenticated: 64, PerRoom: 32, FramesPerSecond: 64, BytesPerSecond: 1048576}
}
func signed(key ed25519.PrivateKey, domain string, v any) string {
	b, e := signingBytes(domain, v)
	if e != nil {
		panic(e)
	}
	return hex.EncodeToString(ed25519.Sign(key, b))
}
func invoke(t *testing.T, s *Server, method, path string, v any, status int, out any) {
	t.Helper()
	r := httptest.NewRequest(method, path, bytes.NewReader(wire(v)))
	r.RemoteAddr = "127.0.0.1:1234"
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != status {
		t.Fatalf("%s got %d: %s", path, w.Code, w.Body.String())
	}
	if out != nil {
		if e := json.Unmarshal(w.Body.Bytes(), out); e != nil {
			t.Fatal(e)
		}
	}
}
func allocateTest(t *testing.T, s *Server) (SignedDescriptor, ed25519.PrivateKey, ed25519.PrivateKey, SignedTicket, SignedTicket) {
	t.Helper()
	hp, h, _ := ed25519.GenerateKey(rand.Reader)
	tp, key, _ := ed25519.GenerateKey(rand.Reader)
	var c struct{ Challenge string }
	invoke(t, s, "POST", api+"room-challenges", map[string]any{}, 200, &c)
	options := json.RawMessage(`{"players":4,"identityMode":"mixed","factionCounts":null,"threshold":11}`)
	q := AllocationRequest{protocol, s.cfg.Origin, c.Challenge, randomHex(16), hex.EncodeToString(hp), hex.EncodeToString(tp), hash("romzo/lobby-options/v1", options), randomHex(16), options}
	proof := ""
	if s.cfg.Auth == "password" {
		proof = mac(s.cfg.Verifier, "romzo/relay-create/v1", q)
	}
	var d Descriptor
	body := map[string]any{"request": q, "proof": proof}
	invoke(t, s, "POST", api+"rooms", body, 200, &d)
	var again Descriptor
	invoke(t, s, "POST", api+"rooms", body, 200, &again)
	if d.Code != again.Code || d.Instance != again.Instance {
		t.Fatal("non-idempotent allocation")
	}
	invoke(t, s, "GET", api+"rooms/"+d.Code, nil, 404, nil)
	sdesc := SignedDescriptor{d, signed(h, "romzo/relay-descriptor/v1", d)}
	var tickets struct {
		Admission SignedTicket
		Recovery  SignedTicket
	}
	invoke(t, s, "POST", api+"rooms/"+d.Code+"/confirm", sdesc, 200, &tickets)
	return sdesc, h, key, tickets.Admission, tickets.Recovery
}
func TestAllocationLifecycleAndRestore(t *testing.T) {
	s := newServer(testConfig())
	now := time.Now()
	s.now = func() time.Time { return now }
	desc, _, key, _, recovery := allocateTest(t, s)
	if s.rooms[desc.Descriptor.Code].quotaSubject != "anonymous" {
		t.Fatal("authorization subject not retained")
	}
	code := desc.Descriptor.Code
	created := now
	invoke(t, s, "GET", api+"rooms/"+code, nil, 200, nil)
	now = now.Add(10 * time.Minute)
	s.mu.Lock()
	s.sweepLocked()
	s.mu.Unlock()
	if len(s.rooms) != 0 {
		t.Fatal("unused room not collected")
	}
	fresh := newServer(s.cfg)
	fresh.now = func() time.Time { return created.Add(5 * time.Minute) }
	body := map[string]any{"signed": desc, "recovery": recovery, "signature": signed(key, "romzo/relay-restore/v1", recovery)}
	invoke(t, fresh, "POST", api+"rooms/"+code+"/restore", body, 200, nil)
	if fresh.rooms[code].Signed.Descriptor.Instance != desc.Descriptor.Instance {
		t.Fatal("changed instance")
	}
	fresh.now = func() time.Time { return created.Add(11 * time.Minute) }
	invoke(t, fresh, "POST", api+"rooms/"+code+"/restore", body, 403, nil)
}
func TestPasswordFailClosedAndProof(t *testing.T) {
	t.Setenv("PUBLIC_ORIGIN", "http://127.0.0.1")
	t.Setenv("AUTH_SALT", strings.Repeat("ab", 32))
	t.Setenv("TICKET_KEY", strings.Repeat("cd", 32))
	t.Setenv("CREATE_AUTH", "password")
	t.Setenv("CREATE_PASSWORD", "")
	if _, e := config(); e == nil {
		t.Fatal("missing password opened server")
	}
	t.Setenv("CREATE_PASSWORD", "test-only-long-password")
	a, e := config()
	if e != nil {
		t.Fatal(e)
	}
	b, _ := config()
	if !bytes.Equal(a.Salt, b.Salt) || !bytes.Equal(a.Verifier, b.Verifier) {
		t.Fatal("restart rotated salt")
	}
	s := newServer(a)
	allocateTest(t, s)
	q := AllocationRequest{Protocol: protocol, Origin: a.Origin}
	proof := mac(a.Verifier, "romzo/relay-create/v1", q)
	if _, e := s.auth.Authorize(q, proof); e != nil {
		t.Fatal(e)
	}
	q.Origin = "https://other.test"
	if _, e := s.auth.Authorize(q, proof); e == nil {
		t.Fatal("cross-origin proof accepted")
	}
	other, _ := pbkdf2.Key(sha256.New, "different", a.Salt, 600000, 32)
	if _, e := (passwordAuthorizer{other}).Authorize(q, proof); e == nil {
		t.Fatal("wrong verifier accepted")
	}
}
func TestTamperAndExpiredChallenge(t *testing.T) {
	s := newServer(testConfig())
	desc, _, key, _, recovery := allocateTest(t, s)
	desc.Descriptor.Instance = randomHex(16)
	invoke(t, s, "POST", api+"rooms/"+desc.Descriptor.Code+"/restore", map[string]any{"signed": desc, "recovery": recovery, "signature": signed(key, "romzo/relay-restore/v1", recovery)}, 403, nil)
	if s.validTicket(recovery, "creator") {
		t.Fatal("ticket purpose escalation")
	}
	now := time.Now()
	s.now = func() time.Time { return now }
	s.challenges["old"] = Challenge{now.Add(-time.Second)}
	s.sweepLocked()
	if _, ok := s.challenges["old"]; ok {
		t.Fatal("expired nonce retained")
	}
}
func connectTest(t *testing.T, url string, ticket SignedTicket, key ed25519.PrivateKey) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	c, _, e := websocket.Dial(ctx, strings.Replace(url, "http", "ws", 1)+wsPath, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{"http://client.test"}}})
	if e != nil {
		t.Fatal(e)
	}
	c.SetReadLimit(frameLimit)
	writeTest(t, c, map[string]any{"v": protocol, "kind": "authenticate", "admission": ticket})
	f := readTest(t, c)
	writeTest(t, c, map[string]any{"v": protocol, "kind": "proof", "signature": signed(key, "romzo/relay-connect/v1", f["value"])})
	if readTest(t, c)["kind"] != "authenticated" {
		t.Fatal("no authentication")
	}
	return c
}
func writeTest(t *testing.T, c *websocket.Conn, v any) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if e := c.Write(ctx, websocket.MessageText, wire(v)); e != nil {
		t.Fatal(e)
	}
}
func readTest(t *testing.T, c *websocket.Conn) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, b, e := c.Read(ctx)
	if e != nil {
		t.Fatal(e)
	}
	var v map[string]any
	if e = decode(b, &v); e != nil {
		t.Fatal(e)
	}
	return v
}
func TestWebsocketAuthenticatedRouting(t *testing.T) {
	s := newServer(testConfig())
	d, _, key, ticket, _ := allocateTest(t, s)
	httpServer := httptest.NewServer(s)
	defer httpServer.Close()
	a := connectTest(t, httpServer.URL, ticket, key)
	defer a.CloseNow()
	_, guest, _ := ed25519.GenerateKey(rand.Reader)
	var admission struct{ Admission SignedTicket }
	invoke(t, s, "POST", api+"rooms/"+d.Descriptor.Code+"/admissions", map[string]string{"key": hex.EncodeToString(guest.Public().(ed25519.PublicKey))}, 200, &admission)
	b := connectTest(t, httpServer.URL, admission.Admission, guest)
	defer b.CloseNow()
	writeTest(t, a, map[string]any{"v": protocol, "kind": "subscribe", "channel": "game", "id": "1"})
	if readTest(t, a)["kind"] != "ack" {
		t.Fatal("subscribe failed")
	}
	writeTest(t, b, map[string]any{"v": protocol, "kind": "subscribe", "channel": "game", "id": "2"})
	joinB := readTest(t, b)
	_ = readTest(t, b)
	joinA := readTest(t, a)
	if joinA["kind"] != "join" || joinB["kind"] != "join" {
		t.Fatal("presence missing")
	}
	for i := 0; i < 10; i++ {
		writeTest(t, a, map[string]any{"v": protocol, "kind": "send", "channel": "game", "target": joinA["peer"], "id": "s", "value": map[string]any{"seq": i}})
		_ = readTest(t, a)
		got := readTest(t, b)["value"].(map[string]any)
		if got["seq"] != json.Number(string(rune('0'+i))) {
			t.Fatal("order violated")
		}
	}
	writeTest(t, a, map[string]any{"v": protocol, "kind": "send", "channel": "game", "target": "missing", "id": "x", "value": 1})
	if readTest(t, a)["kind"] != "error" {
		t.Fatal("invalid target became broadcast")
	}
	writeTest(t, b, map[string]any{"v": protocol, "kind": "keepalive", "id": "k"})
	if readTest(t, b)["recovery"] == nil {
		t.Fatal("no recovery ticket")
	}
	// An explicitly empty destination is invalid, never a broadcast.
	writeTest(t, a, map[string]any{"v": protocol, "kind": "send", "channel": "game", "target": "", "id": "empty", "value": 1})
	termination := readTest(t, a)
	if termination["kind"] != "error" || termination["error"] != "invalid_target_encoding" {
		t.Fatalf("terminal error frame missing, got %v", termination)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, _, e := a.Read(ctx); e == nil {
		t.Fatal("empty destination accepted")
	}
	writeTest(t, b, map[string]any{"v": protocol, "kind": "keepalive", "id": "after-empty"})
	for {
		f := readTest(t, b)
		if f["kind"] == "receive" {
			t.Fatal("invalid destination became broadcast")
		}
		if f["kind"] == "ack" {
			break
		}
	}
}

func TestTerminalErrorFramePrecedesDisconnect(t *testing.T) {
	cases := map[string]struct {
		frame map[string]any
		code  string
	}{
		"keepalive_without_subscription": {map[string]any{"v": protocol, "kind": "keepalive", "id": "k"}, "keepalive_without_subscription"},
		"invalid_channel":                {map[string]any{"v": protocol, "kind": "subscribe", "channel": "evil", "id": "s"}, "invalid_channel"},
		"invalid_frame_fields":           {map[string]any{"v": protocol, "kind": "keepalive", "id": ""}, "invalid_frame_fields"},
		"unknown_frame_kind":             {map[string]any{"v": protocol, "kind": "frobnicate", "id": "u"}, "unknown_frame_kind"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			s := newServer(testConfig())
			_, _, key, ticket, _ := allocateTest(t, s)
			h := httptest.NewServer(s)
			defer h.Close()
			c := connectTest(t, h.URL, ticket, key)
			defer c.CloseNow()
			writeTest(t, c, tc.frame)
			f := readTest(t, c)
			if f["kind"] != "error" || f["error"] != tc.code {
				t.Fatalf("terminal frame missing, got %v", f)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if _, _, e := c.Read(ctx); e == nil {
				t.Fatal("connection not closed after terminal error")
			}
		})
	}
}

func TestUnsubscribedTrafficCannotHoldExpiredRoom(t *testing.T) {
	s := newServer(testConfig())
	now := time.Now()
	s.now = func() time.Time { return now }
	d, _, _, _, _ := allocateTest(t, s)
	r := s.rooms[d.Descriptor.Code]
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r.Peers["idle"] = &Peer{lastSeen: now, channels: map[string]bool{}, cancel: cancel}
	now = now.Add(10 * time.Minute)
	s.sweepLocked()
	if s.rooms[d.Descriptor.Code] != nil {
		t.Fatal("unsubscribed connection held expired room")
	}
	select {
	case <-ctx.Done():
	default:
		t.Fatal("idle socket not cancelled")
	}
}
func TestRealAuthenticationDeadline(t *testing.T) {
	s := newServer(testConfig())
	h := httptest.NewServer(s)
	defer h.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	c, _, e := websocket.Dial(ctx, strings.Replace(h.URL, "http", "ws", 1)+wsPath, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{"http://client.test"}}})
	if e != nil {
		t.Fatal(e)
	}
	defer c.CloseNow()
	start := time.Now()
	if _, _, e = c.Read(ctx); e == nil {
		t.Fatal("unauthenticated connection kept alive")
	}
	elapsed := time.Since(start)
	if elapsed < 4*time.Second || elapsed > 7*time.Second {
		t.Fatalf("authentication deadline: %s", elapsed)
	}
}
func TestHTTPConfirmationAndRestoreDoNotExtendLease(t *testing.T) {
	s := newServer(testConfig())
	now := time.Now()
	s.now = func() time.Time { return now }
	d, _, key, _, original := allocateTest(t, s)
	deadline := original.Ticket.Expires
	now = now.Add(9 * time.Minute)
	var confirmation struct {
		Recovery SignedTicket `json:"recovery"`
	}
	invoke(t, s, "POST", api+"rooms/"+d.Descriptor.Code+"/confirm", d, 200, &confirmation)
	if confirmation.Recovery.Ticket.Expires != deadline {
		t.Fatal("HTTP confirmation renewed unused lease")
	}
	fresh := newServer(s.cfg)
	fresh.now = func() time.Time { return now }
	body := map[string]any{"signed": d, "recovery": confirmation.Recovery, "signature": signed(key, "romzo/relay-restore/v1", confirmation.Recovery)}
	invoke(t, fresh, "POST", api+"rooms/"+d.Descriptor.Code+"/restore", body, 200, nil)
	if fresh.rooms[d.Descriptor.Code].Active.Add(30*time.Minute).UnixMilli() != deadline {
		t.Fatal("restore extended lease without authenticated keepalive")
	}
	now = now.Add(2 * time.Minute)
	invoke(t, fresh, "POST", api+"rooms/"+d.Descriptor.Code+"/restore", body, 403, nil)
}
func TestRestartRestorationAuthenticatesOriginalSocketKey(t *testing.T) {
	original := newServer(testConfig())
	d, _, key, ticket, _ := allocateTest(t, original)
	first := httptest.NewServer(original)
	defer first.Close()
	c := connectTest(t, first.URL, ticket, key)
	defer c.CloseNow()
	writeTest(t, c, map[string]any{"v": protocol, "kind": "subscribe", "channel": "game", "id": "s"})
	_ = readTest(t, c)
	writeTest(t, c, map[string]any{"v": protocol, "kind": "keepalive", "id": "k"})
	raw, _ := json.Marshal(readTest(t, c)["recovery"])
	var recovery SignedTicket
	if json.Unmarshal(raw, &recovery) != nil {
		t.Fatal("invalid renewal ticket")
	}
	fresh := newServer(original.cfg)
	second := httptest.NewServer(fresh)
	defer second.Close()
	var admission struct {
		Admission SignedTicket `json:"admission"`
	}
	invoke(t, fresh, "POST", api+"rooms/"+d.Descriptor.Code+"/restore", map[string]any{"signed": d, "recovery": recovery, "signature": signed(key, "romzo/relay-restore/v1", recovery)}, 200, &admission)
	restored := connectTest(t, second.URL, admission.Admission, key)
	defer restored.CloseNow()
	writeTest(t, restored, map[string]any{"v": protocol, "kind": "subscribe", "channel": "game", "id": "s"})
	if readTest(t, restored)["kind"] != "ack" || fresh.rooms[d.Descriptor.Code].Signed.Descriptor.Instance != d.Descriptor.Instance {
		t.Fatal("original socket identity or instance not restored")
	}
}
