package main

import (
	"context"
	"encoding/json"
	"github.com/coder/websocket"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

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
	c, _, e := websocket.Dial(ctx, strings.Replace(h.URL, "http", "ws", 1)+api+"ws", &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{"http://client.test"}}})
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
	body := map[string]any{"signed": d, "recovery": confirmation.Recovery, "signature": signed(key, "ru/relay-restore/v1", confirmation.Recovery)}
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
	invoke(t, fresh, "POST", api+"rooms/"+d.Descriptor.Code+"/restore", map[string]any{"signed": d, "recovery": recovery, "signature": signed(key, "ru/relay-restore/v1", recovery)}, 200, &admission)
	restored := connectTest(t, second.URL, admission.Admission, key)
	defer restored.CloseNow()
	writeTest(t, restored, map[string]any{"v": protocol, "kind": "subscribe", "channel": "game", "id": "s"})
	if readTest(t, restored)["kind"] != "ack" || fresh.rooms[d.Descriptor.Code].Signed.Descriptor.Instance != d.Descriptor.Instance {
		t.Fatal("original socket identity or instance not restored")
	}
}
