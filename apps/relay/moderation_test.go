package main

import (
	"context"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func adminAction(s *Server, path, body, key string) int {
	r := httptest.NewRequest("POST", api+"admin/"+path, strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+key)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w.Code
}
func TestRoomStopAuthorizationPersistence(t *testing.T) {
	c := testConfig()
	c.MetricsKey = strings.Repeat("m", 64)
	c.MetricsHistoryFile = filepath.Join(t.TempDir(), "history.json")
	c.RecordCreatorIP = true
	s := newServer(c)
	room := monitoredTestRoom(s)
	s.monitor.records[room.MonitorID].CreatorIP = "192.0.2.1"
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	room.Peers["test"] = &Peer{cancel: cancel}
	body := `{"id":"` + room.MonitorID + `"}`
	if adminAction(s, "rooms/stop", body, "bad") != 401 || s.rooms[room.Signed.Descriptor.Code] == nil {
		t.Fatal("unauthorized mutation")
	}
	if adminAction(s, "rooms/stop", body, c.MetricsKey) != 200 {
		t.Fatal("stop failed")
	}
	select {
	case <-ctx.Done():
	default:
		t.Fatal("peer not disconnected")
	}
	if s.rooms[room.Signed.Descriptor.Code] != nil {
		t.Fatal("room still present")
	}
	restored := newServer(c)
	if err := restored.loadHistory(); err != nil {
		t.Fatal(err)
	}
	resurrected := &Room{Signed: room.Signed, Peers: map[string]*Peer{}}
	restored.attachRoomRecordLocked(resurrected)
	if !restored.roomLimitLocked(resurrected, 0) {
		t.Fatal("stopped room could restore")
	}
	if restored.monitor.records[room.MonitorID].CreatorIP != "192.0.2.1" {
		t.Fatal("creator IP lost")
	}
	restored.cfg.RecordCreatorIP = false
	if err := restored.loadHistory(); err != nil {
		t.Fatal(err)
	}
	if restored.monitor.records[room.MonitorID].CreatorIP != "" {
		t.Fatal("IP retained despite opt-out")
	}
}

func TestRoomStopSaveFailureAndRequestBoundaries(t *testing.T) {
	c := testConfig()
	c.MetricsKey = strings.Repeat("m", 64)
	s := newServer(c)
	room := monitoredTestRoom(s)
	if adminAction(s, "rooms/stop", `{"id":"`+room.MonitorID+`","extra":true}`, c.MetricsKey) != 400 {
		t.Fatal("extra field accepted")
	}
	r := httptest.NewRequest("GET", api+"admin/rooms/stop", nil)
	r.Header.Set("Authorization", "Bearer "+c.MetricsKey)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 405 || w.Header().Get("Allow") != "POST" {
		t.Fatal("wrong method accepted")
	}
	r = httptest.NewRequest("POST", api+"admin/rooms/stop", strings.NewReader(`{"id":"`+room.MonitorID+`"}`))
	r.Header.Set("Authorization", "Bearer "+c.MetricsKey)
	r.Header.Set("Origin", "https://untrusted.example")
	w = httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("untrusted origin accepted")
	}
	s.cfg.MetricsHistoryFile = filepath.Join(t.TempDir(), "directory")
	if err := os.Mkdir(s.cfg.MetricsHistoryFile, 0700); err != nil {
		t.Fatal(err)
	}
	if adminAction(s, "rooms/stop", `{"id":"`+room.MonitorID+`"}`, c.MetricsKey) != 500 || s.rooms[room.Signed.Descriptor.Code] != nil {
		t.Fatal("save failure hid shutdown result")
	}
}
