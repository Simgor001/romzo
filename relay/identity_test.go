package main

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/coder/websocket"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestIdentityExpiryCapacityAndRestart(t *testing.T) {
	s := memberServer(t)
	s.cfg.PerRoom = 2
	now := time.Now()
	s.now = func() time.Time { return now }
	d, _, _, _, _ := allocateOptionsTest(t, s, json.RawMessage(`{"identityPolicy":{"exclusive":true,"ttlMs":30000}}`))
	room := s.rooms[d.Descriptor.Code]
	for i := 1; i <= 3; i++ {
		if _, err := s.registerMemberLocked(room, fmt.Sprintf("%064x", i)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.registerMemberLocked(room, fmt.Sprintf("%064x", 5)); err == nil {
		t.Fatal("unbounded identity table")
	}
	r := s.memberRecords[d.Descriptor.Instance]
	room.Peers["active"] = &Peer{key: fmt.Sprintf("%064x", 1)}
	now = now.Add(31 * time.Second)
	if seq, err := s.registerMemberLocked(room, fmt.Sprintf("%064x", 5)); err != nil || seq != 5 {
		t.Fatal("expired capacity not reclaimed", seq, err)
	}
	if len(r.Members) != 2 || r.Members[fmt.Sprintf("%064x", 1)] != 2 {
		t.Fatal("active identity pruned")
	}
	fresh := newServer(s.cfg)
	if err := fresh.loadMembers(); err != nil {
		t.Fatal(err)
	}
	if fresh.memberRecords[d.Descriptor.Instance].Next != 6 {
		t.Fatal("restart reused member numbers")
	}
}

func TestExclusiveIdentityHandshakeAndRelease(t *testing.T) {
	s := memberServer(t)
	_, _, key, admission, _ := allocateOptionsTest(t, s, json.RawMessage(`{"identityPolicy":{"exclusive":true,"ttlMs":1800000}}`))
	server := httptest.NewServer(s)
	defer server.Close()
	first := connectTest(t, server.URL, admission, key)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	second, _, err := websocket.Dial(ctx, strings.Replace(server.URL, "http", "ws", 1)+wsPath, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{"http://client.test"}}})
	if err != nil {
		t.Fatal(err)
	}
	defer second.CloseNow()
	writeTest(t, second, map[string]any{"v": protocol, "kind": "authenticate", "admission": admission})
	challenge := readTest(t, second)
	writeTest(t, second, map[string]any{"v": protocol, "kind": "proof", "signature": signed(key, "romzo/relay-connect/v1", challenge["value"])})
	if readTest(t, second)["error"] != "identity_in_use" {
		t.Fatal("duplicate identity accepted")
	}
	first.CloseNow()
	deadline := time.Now().Add(2 * time.Second)
	for {
		s.mu.Lock()
		n := len(s.rooms[admission.Ticket.Code].Peers)
		s.mu.Unlock()
		if n == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("identity not released")
		}
		time.Sleep(time.Millisecond)
	}
	restored := connectTest(t, server.URL, admission, key)
	restored.CloseNow()
}

func TestHostedVerificationPageOriginAndCSP(t *testing.T) {
	s := newServer(grantTestConfig())
	s.cfg.TurnstileSecret = "fixture"
	s.cfg.TurnstileSiteKey = "fixture"
	s.cfg.TurnstileAction = "create-room"
	target := api + "auth/turnstile?parent=http%3A%2F%2Fclient.test&host=" + strings.Repeat("a", 64) + "&request=" + strings.Repeat("b", 32)
	w := rawRequest(t, s, "GET", target, nil)
	if w.Code != 200 || !strings.Contains(w.Header().Get("Content-Security-Policy"), "frame-ancestors") || !strings.Contains(w.Body.String(), "create-room") {
		t.Fatal("invalid hosted verification page", w.Code)
	}
	w = rawRequest(t, s, "GET", strings.Replace(target, "client.test", "evil.test", 1), nil)
	if w.Code != 400 {
		t.Fatal("unapproved embedder accepted")
	}
	for _, options := range []string{`{"identityPolicy":null}`, `{"identityPolicy":{"exclusive":false,"ttlMs":1000}}`, `{"identityPolicy":{"exclusive":true,"ttlMs":0}}`} {
		if _, err := readIdentityPolicy(json.RawMessage(options)); err == nil {
			t.Fatal("invalid policy accepted")
		}
	}
}

func TestRecoveryGraceCannotExtendIdentityDeadline(t *testing.T) {
	s := memberServer(t)
	now := time.Now()
	s.now = func() time.Time { return now }
	signedRoom, _, key, _, recovery := allocateOptionsTest(t, s, json.RawMessage(`{"identityPolicy":{"exclusive":true,"ttlMs":30000}}`))
	room := s.rooms[signedRoom.Descriptor.Code]
	now = now.Add(20 * time.Second)
	if err := s.touchIdentityLocked(room, signedRoom.Descriptor.Transport); err != nil {
		t.Fatal(err)
	}
	delete(s.rooms, signedRoom.Descriptor.Code)
	now = now.Add(15 * time.Second)
	body := map[string]any{"signed": signedRoom, "recovery": recovery, "signature": signed(key, "romzo/relay-restore/v1", recovery)}
	invoke(t, s, "POST", api+"rooms/"+signedRoom.Descriptor.Code+"/restore", body, 200, nil)
	deadline := s.memberRecords[signedRoom.Descriptor.Instance].KeyExpires[signedRoom.Descriptor.Transport]
	if s.rooms[signedRoom.Descriptor.Code].Active.Add(identityTTL(room)).UnixMilli() != deadline {
		t.Fatal("ticket grace extended room lease")
	}
	now = now.Add(16 * time.Second)
	if response := rawRequest(t, s, "POST", api+"rooms/"+signedRoom.Descriptor.Code+"/restore", body); response.Code < 400 {
		t.Fatal("expired identity restored with grace ticket")
	}
}
