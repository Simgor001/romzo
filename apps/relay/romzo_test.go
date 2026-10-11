package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"github.com/coder/websocket"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestOpaqueOptionsAreBoundedCanonicalJSON(t *testing.T) {
	for _, value := range []string{`null`, `true`, `42`, `"another game"`, `[1,{"expansion":"forest"}]`, `{"players":2,"rules":{"dice":6},"lifecycle":"custom"}`} {
		if !validOptions([]byte(value)) {
			t.Fatalf("generic options rejected: %s", value)
		}
	}
	for _, value := range []string{"", "{} trailing", `{"n":1.5}`, `{"n":9007199254740992}`, `"` + strings.Repeat("x", 4095) + `"`} {
		if validOptions([]byte(value)) {
			t.Fatal("invalid or oversized options accepted")
		}
	}
	if !validOptions([]byte(`"` + strings.Repeat("x", 4094) + `"`)) {
		t.Fatal("4096-byte boundary rejected")
	}
}

func TestRomzoConfiguredLimits(t *testing.T) {
	t.Setenv("PUBLIC_ORIGIN", "http://127.0.0.1")
	t.Setenv("AUTH_SALT", strings.Repeat("ab", 32))
	t.Setenv("TICKET_KEY", strings.Repeat("cd", 32))
	t.Setenv("CREATE_AUTH", "anonymous")
	t.Setenv("BYTES_PER_SECOND", "262144")
	t.Setenv("IP_BYTES_PER_SECOND", "262144")
	t.Setenv("MAX_OPTIONS_BYTES", "4096")
	c, err := config()
	if err != nil || c.BytesPerSecond != 262144 || c.IPBytesPerSecond != 262144 || c.OptionsBytes != 4096 {
		t.Fatalf("capped demo configuration rejected: %v", err)
	}
	for _, pair := range [][2]string{{"IP_BYTES_PER_SECOND", "1"}, {"MAX_OPTIONS_BYTES", "4097"}, {"MAX_OPTIONS_BYTES", "0"}} {
		t.Run(pair[0]+pair[1], func(t *testing.T) {
			t.Setenv(pair[0], pair[1])
			if _, err := config(); err == nil {
				t.Fatal("invalid resource bound accepted")
			}
		})
	}
}

func TestGenericRoomAllocationAndConfiguredOptionsBound(t *testing.T) {
	cfg := testConfig()
	cfg.OptionsBytes = 64
	s := newServer(cfg)
	host, _, _ := ed25519.GenerateKey(rand.Reader)
	transport, _, _ := ed25519.GenerateKey(rand.Reader)
	var challenge struct{ Challenge string }
	invoke(t, s, "POST", api+"room-challenges", map[string]any{}, 200, &challenge)
	options := json.RawMessage(`{"game":"other","players":2,"rules":["custom"]}`)
	q := AllocationRequest{protocol, s.cfg.Origin, challenge.Challenge, randomHex(16), hex.EncodeToString(host), hex.EncodeToString(transport), hash("ru/lobby-options/v1", options), randomHex(16), options}
	invoke(t, s, "POST", api+"rooms", map[string]any{"request": q, "proof": ""}, 200, nil)
	q.RequestID = randomHex(16)
	q.Options = json.RawMessage(`"` + strings.Repeat("x", 63) + `"`)
	q.ConfigHash = hash("ru/lobby-options/v1", q.Options)
	invoke(t, s, "POST", api+"rooms", map[string]any{"request": q, "proof": ""}, 400, nil)
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

func TestConfiguredOptionsBoundAppliesToRestore(t *testing.T) {
	cfg := testConfig()
	descriptor, _, key, _, recovery := allocateTest(t, newServer(cfg))
	body := map[string]any{"signed": descriptor, "recovery": recovery, "signature": signed(key, "ru/relay-restore/v1", recovery)}
	path := api + "rooms/" + descriptor.Descriptor.Code + "/restore"
	invoke(t, newServer(cfg), "POST", path, body, 200, nil)
	// A deployment lowering its bound cannot be bypassed with an old ticket.
	cfg.OptionsBytes = 32
	limited := newServer(cfg)
	invoke(t, limited, "POST", path, body, 403, nil)
	if len(limited.rooms) != 0 {
		t.Fatal("oversized restore allocated a room")
	}
}
