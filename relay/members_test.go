package main

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func memberServer(t *testing.T) *Server {
	t.Helper()
	c := testConfig()
	c.MemberStateFile = filepath.Join(t.TempDir(), "members.json")
	s := newServer(c)
	if err := s.loadMembers(); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestMemberOrderConcurrencyPersistenceAndIsolation(t *testing.T) {
	s := memberServer(t)
	d, _, _, _, _ := allocateTest(t, s)
	room := s.rooms[d.Descriptor.Code]
	var wg sync.WaitGroup
	results := make(chan int, 24)
	for i := 0; i < 24; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			s.mu.Lock()
			defer s.mu.Unlock()
			seq, err := s.registerMemberLocked(room, fmt.Sprintf("%064x", i+1))
			if err != nil {
				t.Error(err)
			}
			results <- seq
		}(i)
	}
	wg.Wait()
	close(results)
	seen := map[int]bool{}
	for seq := range results {
		if seq < 1 || seq > 24 || seen[seq] {
			t.Fatal("duplicate order")
		}
		seen[seq] = true
	}
	s.mu.Lock()
	original, _ := s.registerMemberLocked(room, fmt.Sprintf("%064x", 1))
	again, _ := s.registerMemberLocked(room, fmt.Sprintf("%064x", 1))
	s.mu.Unlock()
	if again != original {
		t.Fatal("identity changed order")
	}
	fresh := newServer(s.cfg)
	if err := fresh.loadMembers(); err != nil {
		t.Fatal(err)
	}
	seq, err := fresh.registerMemberLocked(room, fmt.Sprintf("%064x", 1))
	if err != nil || seq != original {
		t.Fatal("restart lost order", err)
	}
	d2, _, _, _, _ := allocateTest(t, fresh)
	seq, err = fresh.registerMemberLocked(fresh.rooms[d2.Descriptor.Code], fmt.Sprintf("%064x", 1))
	if err != nil || seq != 1 {
		t.Fatal("room instance shared order", err)
	}
}

func TestMemberDurableExpiryAndWriteFailure(t *testing.T) {
	s := memberServer(t)
	d, _, key, _, recovery := allocateTest(t, s)
	room := s.rooms[d.Descriptor.Code]
	if _, err := s.registerMemberLocked(room, d.Descriptor.Transport); err != nil {
		t.Fatal(err)
	}
	expires := s.now().Add(time.Hour).UnixMilli()
	if err := s.prepareMembersLocked(room, expires); err != nil {
		t.Fatal(err)
	}
	fresh := newServer(s.cfg)
	if err := fresh.loadMembers(); err != nil {
		t.Fatal(err)
	}
	if fresh.memberRecords[d.Descriptor.Instance].Expires != expires {
		t.Fatal("renewal not durable")
	}
	body := map[string]any{"signed": d, "recovery": recovery, "signature": signed(key, "romzo/relay-restore/v1", recovery)}
	invoke(t, fresh, "POST", api+"rooms/"+d.Descriptor.Code+"/restore", body, 200, nil)
	delete(fresh.memberRecords, d.Descriptor.Instance)
	invoke(t, fresh, "POST", api+"rooms/"+d.Descriptor.Code+"/restore", body, 409, nil)
	// Rename over a directory fails on both Windows and Unix.
	blocked := filepath.Join(t.TempDir(), "directory")
	if err := os.Mkdir(blocked, 0700); err != nil {
		t.Fatal(err)
	}
	s.cfg.MemberStateFile = blocked
	r := s.memberRecords[d.Descriptor.Instance]
	before := r.Next
	if _, err := s.registerMemberLocked(room, fmt.Sprintf("%064x", 99)); err == nil {
		t.Fatal("failed write exposed a number")
	}
	if r.Next != before || r.Members[fmt.Sprintf("%064x", 99)] != 0 {
		t.Fatal("failed write consumed order")
	}
	oldExpiry := r.Expires
	if err := s.prepareMembersLocked(room, expires+1); err == nil || r.Expires != oldExpiry {
		t.Fatal("failed renewal changed expiry")
	}
	s.cfg.MemberStateFile = filepath.Join(t.TempDir(), "good.json")
	delete(s.rooms, d.Descriptor.Code)
	s.now = func() time.Time { return time.UnixMilli(expires - 1) }
	s.pruneMembersLocked()
	if s.memberRecords[d.Descriptor.Instance] == nil {
		t.Fatal("unexpired recovery discarded")
	}
	s.now = func() time.Time { return time.UnixMilli(expires) }
	s.pruneMembersLocked()
	if s.memberRecords[d.Descriptor.Instance] != nil {
		t.Fatal("expired state retained")
	}
}

func TestMemberCapacityAndChannelPrivacy(t *testing.T) {
	s := memberServer(t)
	d, _, _, _, _ := allocateTest(t, s)
	room := s.rooms[d.Descriptor.Code]
	r := s.memberRecords[d.Descriptor.Instance]
	for i := 1; i <= memberLimit; i++ {
		r.Members[fmt.Sprintf("%064x", i)] = i
	}
	r.Next = memberLimit + 1
	if _, err := s.registerMemberLocked(room, fmt.Sprintf("%064x", memberLimit+1)); err == nil {
		t.Fatal("identity cap bypassed")
	}
	if seq, err := s.registerMemberLocked(room, fmt.Sprintf("%064x", 1)); err != nil || seq != 1 {
		t.Fatal("existing member blocked")
	}
	room.Peers = map[string]*Peer{"one": {id: "one", key: "same", joinSeq: 1, channels: map[string]bool{"table": true}}, "two": {id: "two", key: "same", joinSeq: 1, channels: map[string]bool{"table": true}}, "hidden": {id: "hidden", key: "secret", joinSeq: 2, channels: map[string]bool{"chat": true}}}
	list := channelMembers(room, "table")
	if len(list) != 2 || list[0].JoinSeq != 1 || list[1].JoinSeq != 1 {
		t.Fatal("channel snapshot disclosed other channel or merged connections")
	}
}

func TestMemberStateCorruptionFailsClosed(t *testing.T) {
	s := memberServer(t)
	d, _, _, _, _ := allocateTest(t, s)
	if err := os.WriteFile(s.cfg.MemberStateFile, []byte(`{"version":1,"records":`), 0600); err != nil {
		t.Fatal(err)
	}
	if newServer(s.cfg).loadMembers() == nil {
		t.Fatal("corruption accepted")
	}
	r := s.memberRecords[d.Descriptor.Instance]
	r.Members = map[string]int{fmt.Sprintf("%064x", 1): 1, fmt.Sprintf("%064x", 2): 1}
	r.Next = 3
	b, _ := json.Marshal(memberFile{1, s.memberRecords})
	if err := os.WriteFile(s.cfg.MemberStateFile, b, 0600); err != nil {
		t.Fatal(err)
	}
	if newServer(s.cfg).loadMembers() == nil {
		t.Fatal("duplicate durable order accepted")
	}
}

func TestMemberWireIdentityAndChannelNotifications(t *testing.T) {
	s := memberServer(t)
	_, _, key, ticket, _ := allocateTest(t, s)
	h := httptest.NewServer(s)
	defer h.Close()
	// Exercise the actual authenticated wire path and channel notifications.
	first := connectTest(t, h.URL, ticket, key)
	defer first.CloseNow()
	writeTest(t, first, map[string]any{"v": protocol, "kind": "subscribe", "id": "one", "channel": "table"})
	ack := readTest(t, first)
	if ack["kind"] != "ack" {
		t.Fatal(ack)
	}
	snapshot := ack["value"].(map[string]any)["members"].([]any)
	if len(snapshot) != 1 || snapshot[0].(map[string]any)["joinSeq"] != json.Number("1") {
		t.Fatal("missing own stable order", ack)
	}
	second := connectTest(t, h.URL, ticket, key)
	defer second.CloseNow()
	writeTest(t, second, map[string]any{"v": protocol, "kind": "subscribe", "id": "two", "channel": "table"})
	joined := readTest(t, first)
	if joined["kind"] != "join" || joined["joinSeq"] != json.Number("1") {
		t.Fatal("same key changed number", joined)
	}
	oldJoin := readTest(t, second)
	if oldJoin["kind"] != "join" {
		t.Fatal(oldJoin)
	}
	ack = readTest(t, second)
	snapshot = ack["value"].(map[string]any)["members"].([]any)
	if len(snapshot) != 2 {
		t.Fatal("merged connection IDs", ack)
	}
	writeTest(t, first, map[string]any{"v": protocol, "kind": "send", "id": "message", "channel": "table", "value": map[string]any{"text": "same identity send"}})
	received := readTest(t, second)
	if received["kind"] != "receive" || received["joinSeq"] != json.Number("1") || received["key"] != ticket.Ticket.Key {
		t.Fatal(received)
	}
	if readTest(t, first)["kind"] != "ack" {
		t.Fatal("same identity sender did not receive ack")
	}
}

func TestPublicMemberFrameVectors(t *testing.T) {
	b, err := os.ReadFile("../protocol/member-order-v1-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors struct {
		Description string           `json:"description"`
		Frames      []map[string]any `json:"frames"`
	}
	if err = decode(b, &vectors); err != nil {
		t.Fatal(err)
	}
	receive := vectors.Frames[2]
	p := &Peer{id: receive["peer"].(string), key: receive["key"].(string), joinSeq: 2}
	f := presenceFrame("receive", "chat", p)
	f["value"] = receive["value"]
	if hash("fixture", f) != hash("fixture", receive) {
		t.Fatal("member receive vector mismatch")
	}
	if hash("fixture", presenceFrame("leave", "chat", p)) != hash("fixture", vectors.Frames[3]) {
		t.Fatal("member leave vector mismatch")
	}
}
