package main

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/coder/websocket"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func monitoredTestRoom(s *Server) *Room {
	r := &Room{Signed: SignedDescriptor{Descriptor: Descriptor{Origin: s.cfg.Origin, Code: randomCode(), Instance: randomHex(16)}}, Confirmed: true, Active: s.now(), Peers: map[string]*Peer{}, Channels: map[string]int{"private-channel": 100}}
	s.attachRoomRecordLocked(r)
	s.rooms[r.Signed.Descriptor.Code] = r
	return r
}
func TestRoomRankingsMetadataAndHistory(t *testing.T) {
	s := newServer(testConfig())
	now := time.Now()
	s.now = func() time.Time { return now }
	for i := 0; i < 12; i++ {
		r := monitoredTestRoom(s)
		record := s.monitor.records[r.MonitorID]
		record.ReceivedBytes = int64(i * 100)
		record.SentBytes = int64(i * 200)
		record.ObservedAt = now.Add(-time.Hour).UnixMilli()
		record.OnlineMillis = int64(i * 1000)
		r.Peers["fixture"] = &Peer{}
		s.sampleRoomLocked(r)
	}
	now = now.Add(5 * time.Second)
	view := s.roomHistoryLocked()
	if len(view.TrafficTop) != 10 || len(view.OnlineTop) != 10 || view.TrafficTop[0].ReceivedBytes != 1100 || view.OnlineTop[0].OnlineSeconds != 16 {
		t.Fatal("incorrect rankings or online accounting")
	}
	encoded, _ := json.Marshal(view)
	if strings.Contains(string(encoded), "private-channel") || strings.Contains(string(encoded), "http://") {
		t.Fatal("private room metadata exposed")
	}
	for _, row := range view.TrafficTop {
		if row.Code == "" || row.CreatorIP != "" {
			t.Fatal("code missing or unrequested IP exposed")
		}
	}

	s.cfg.MetricsHistoryFile = filepath.Join(t.TempDir(), "history.json")
	if err := s.saveHistory(); err != nil {
		t.Fatal(err)
	}
	if err := s.saveHistory(); err != nil {
		t.Fatal(err)
	}
	restored := newServer(s.cfg)
	restored.now = s.now
	if err := restored.loadHistory(); err != nil {
		t.Fatal(err)
	}
	if len(restored.monitor.records) != 12 {
		t.Fatal("history missing after restart")
	}
	for _, r := range restored.monitor.records {
		if r.online {
			t.Fatal("offline time counted online")
		}
	}
	now = now.Add(25 * time.Hour)
	restored.pruneHistoryLocked()
	if len(restored.monitor.records) != 0 {
		t.Fatal("expired history retained")
	}
}
func TestRoomQuotaPersistsAndCancels(t *testing.T) {
	s := newServer(testConfig())
	now := time.Now()
	s.now = func() time.Time { return now }
	r := monitoredTestRoom(s)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r.Peers["peer"] = &Peer{cancel: cancel}
	s.sampleRoomLocked(r)
	s.cfg.MaxRoomBytes = 100
	s.monitor.records[r.MonitorID].ReceivedBytes = 80
	if s.roomLimitLocked(r, 20) {
		t.Fatal("exact budget should fit")
	}
	if !s.roomLimitLocked(r, 21) {
		t.Fatal("budget exceeded without stopping")
	}
	select {
	case <-ctx.Done():
	default:
		t.Fatal("peer not cancelled")
	}
	if s.monitor.records[r.MonitorID].StopReason != "room_traffic_limit" {
		t.Fatal("missing limit reason")
	}
	s.cfg.MetricsHistoryFile = filepath.Join(t.TempDir(), "history.json")
	if err := s.saveHistory(); err != nil {
		t.Fatal(err)
	}
	restarted := newServer(s.cfg)
	restarted.now = s.now
	if err := restarted.loadHistory(); err != nil {
		t.Fatal(err)
	}
	copyRoom := &Room{Signed: r.Signed, Peers: map[string]*Peer{}}
	restarted.attachRoomRecordLocked(copyRoom)
	if !restarted.roomLimitLocked(copyRoom, 0) {
		t.Fatal("restart bypassed stopped-room record")
	}
	aged := monitoredTestRoom(s)
	s.cfg.MaxRoomBytes = 0
	s.cfg.MaxRoomSeconds = 60
	now = now.Add(time.Minute)
	if !s.roomLimitLocked(aged, 0) || s.monitor.records[aged.MonitorID].StopReason != "room_lifetime_limit" {
		t.Fatal("keepalive bypassed maximum age")
	}
}
func TestHistoryLoadFailsClosed(t *testing.T) {
	c := testConfig()
	c.MetricsHistoryFile = filepath.Join(t.TempDir(), "history.json")
	if err := os.WriteFile(c.MetricsHistoryFile, []byte(`[{}]`), 0600); err != nil {
		t.Fatal(err)
	}
	if newServer(c).loadHistory() == nil {
		t.Fatal("invalid history accepted")
	}
	c.MetricsHistoryFile = filepath.Join(t.TempDir(), "missing", "history.json")
	if newServer(c).loadHistory() != nil {
		t.Fatal("first startup must allow missing history")
	}
}
func TestRoomHistoryRequiresMetricsKey(t *testing.T) {
	c := testConfig()
	c.MetricsKey = strings.Repeat("m", 64)
	s := newServer(c)
	monitoredTestRoom(s)
	req := httptest.NewRequest("GET", api+"metrics", nil)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, req)
	if w.Code != 401 || strings.Contains(w.Body.String(), "trafficTop") {
		t.Fatal("history exposed without key")
	}
	req.Header.Set("Authorization", "Bearer "+c.MetricsKey)
	w = httptest.NewRecorder()
	s.ServeHTTP(w, req)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "trafficTop") {
		t.Fatal("authenticated history missing")
	}
}

func TestRoomLimitRejectsSignedRestore(t *testing.T) {
	s := newServer(testConfig())
	desc, _, key, _, recovery := allocateTest(t, s)
	room := s.rooms[desc.Descriptor.Code]
	s.stopRoomLocked(room, "room_traffic_limit")
	s.cfg.MetricsHistoryFile = filepath.Join(t.TempDir(), "history.json")
	if err := s.saveHistory(); err != nil {
		t.Fatal(err)
	}
	fresh := newServer(s.cfg)
	if err := fresh.loadHistory(); err != nil {
		t.Fatal(err)
	}
	body := map[string]any{"signed": desc, "recovery": recovery, "signature": signed(key, "romzo/relay-restore/v1", recovery)}
	invoke(t, fresh, "POST", api+"rooms/"+desc.Descriptor.Code+"/restore", body, 410, nil)
	if len(fresh.rooms) != 0 {
		t.Fatal("limited room restored")
	}
}
func TestSubMillisecondTrafficDoesNotHideOnlineTime(t *testing.T) {
	s := newServer(testConfig())
	now := time.Now()
	s.now = func() time.Time { return now }
	r := monitoredTestRoom(s)
	r.Peers["fixture"] = &Peer{}
	s.sampleRoomLocked(r)
	for i := 0; i < 10000; i++ {
		now = now.Add(100 * time.Microsecond)
		s.sampleRoomLocked(r)
	}
	if s.monitor.records[r.MonitorID].OnlineMillis != 1000 {
		t.Fatal("frequent frames suppressed online time")
	}
}
func TestHistoryCapacityCannotEraseQuotas(t *testing.T) {
	s := newServer(testConfig())
	now := time.Now()
	s.now = func() time.Time { return now }
	for i := 0; i < historyRecordLimit; i++ {
		id := randomHex(12)
		if s.monitor.records == nil {
			s.monitor.records = map[string]*roomRecord{}
		}
		s.monitor.records[id] = &roomRecord{ID: id, ObservedAt: now.UnixMilli(), UpdatedAt: now.UnixMilli(), EndedAt: now.UnixMilli(), StopReason: "room_traffic_limit"}
	}
	r := &Room{Signed: SignedDescriptor{Descriptor: Descriptor{Instance: randomHex(16)}}}
	if s.attachRoomRecordLocked(r) != nil {
		t.Fatal("history limit bypassed")
	}
	if len(s.monitor.records) != historyRecordLimit {
		t.Fatal("live quota records evicted")
	}
	now = now.Add(25 * time.Hour)
	if s.attachRoomRecordLocked(r) == nil {
		t.Fatal("expired records failed to free capacity")
	}
}

func TestNodeOutboundRateSpansRooms(t *testing.T) {
	c := testConfig()
	c.NodeOutboundBytesPerSecond = 10
	s := newServer(c)
	now := time.Now()
	s.now = func() time.Time { return now }
	roomA, roomB := monitoredTestRoom(s), monitoredTestRoom(s)
	ctxA, cancelA := context.WithCancel(context.Background())
	defer cancelA()
	ctxB, cancelB := context.WithCancel(context.Background())
	defer cancelB()
	_ = ctxA
	a := &Peer{room: roomA, queue: make(chan []byte, 128), cancel: cancelA}
	b := &Peer{room: roomB, queue: make(chan []byte, 128), cancel: cancelB}
	s.mu.Lock()
	first := s.enqueueLocked(a, map[string]int{"x": 1})
	second := s.enqueueLocked(b, map[string]int{"x": 2})
	third := s.enqueueLocked(b, map[string]int{"x": 3})
	s.mu.Unlock()
	if !first || !second || third {
		t.Fatal("node rate was not shared across rooms")
	}
	select {
	case <-ctxB.Done():
	default:
		t.Fatal("over-limit connection not stopped")
	}
	if b.limitReason != "node_outbound_rate" || s.queueRejected != 1 {
		t.Fatal("node rate rejection not accounted")
	}
	now = now.Add(time.Second)
	other := &Peer{room: roomA, queue: make(chan []byte, 128), cancel: cancelA}
	if !s.enqueueLocked(other, map[string]int{"x": 4}) {
		t.Fatal("rate did not refill")
	}
}

func TestLiveRoomLimitsCloseAllConnections(t *testing.T) {
	for _, reason := range []string{"room_traffic_limit", "room_lifetime_limit", "admin_stopped"} {
		t.Run(reason, func(t *testing.T) {
			s := newServer(testConfig())
			desc, _, key, ticket, recovery := allocateTest(t, s)
			server := httptest.NewServer(s)
			defer server.Close()
			a := connectTest(t, server.URL, ticket, key)
			defer a.CloseNow()
			b := connectTest(t, server.URL, ticket, key)
			defer b.CloseNow()
			writeTest(t, a, map[string]any{"v": protocol, "kind": "subscribe", "id": "s", "channel": "table"})
			_ = readTest(t, a)
			s.mu.Lock()
			room := s.rooms[desc.Descriptor.Code]
			record := s.monitor.records[room.MonitorID]
			if reason == "room_lifetime_limit" {
				s.cfg.MaxRoomSeconds = 60
				record.ObservedAt = s.now().Add(-61 * time.Second).UnixMilli()
				s.sweepLocked()
			} else if reason == "room_traffic_limit" {
				s.cfg.MaxRoomBytes = record.ReceivedBytes + record.SentBytes + 32
			}
			s.mu.Unlock()
			if reason == "admin_stopped" {
				s.cfg.MetricsKey = strings.Repeat("m", 64)
				if adminAction(s, "rooms/stop", `{"id":"`+room.MonitorID+`"}`, s.cfg.MetricsKey) != 200 {
					t.Fatal("manual stop failed")
				}
			}
			if reason == "room_traffic_limit" {
				writeTest(t, a, map[string]any{"v": protocol, "kind": "send", "id": "over", "channel": "table", "value": strings.Repeat("x", 128)})
			}
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			for _, conn := range []*websocket.Conn{a, b} {
				if _, _, err := conn.Read(ctx); err == nil || errors.Is(err, context.DeadlineExceeded) {
					t.Fatal("limit did not close every live connection")
				}
			}
			s.mu.Lock()
			stopped := s.monitor.records[room.MonitorID].StopReason
			s.mu.Unlock()
			if stopped != reason {
				t.Fatal("incorrect room limit reason")
			}
			body := map[string]any{"signed": desc, "recovery": recovery, "signature": signed(key, "romzo/relay-restore/v1", recovery)}
			invoke(t, s, "POST", api+"rooms/"+desc.Descriptor.Code+"/restore", body, 410, nil)
		})
	}
}
