package main

import (
	"context"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// Advancing the server clock avoids a 3-minute sleep while exercising real WS
// reads/writes and the same sweep used by the container's maintenance goroutine.
func TestValidSendTrafficPreventsIdleSweep(t *testing.T) {
	s := newServer(testConfig())
	var clock atomic.Int64
	clock.Store(time.Now().UnixMilli())
	s.now = func() time.Time { return time.UnixMilli(clock.Load()) }
	_, _, key, ticket, _ := allocateTest(t, s)
	h := httptest.NewServer(s)
	defer h.Close()
	c := connectTest(t, h.URL, ticket, key)
	defer c.CloseNow()
	writeTest(t, c, map[string]any{"v": protocol, "kind": "subscribe", "channel": "table", "id": "subscribe"})
	if readTest(t, c)["kind"] != "ack" {
		t.Fatal("subscribe was not acknowledged")
	}
	for i := 0; i < 5; i++ {
		clock.Add(30000)
		s.mu.Lock()
		s.sweepLocked()
		s.mu.Unlock()
		writeTest(t, c, map[string]any{"v": protocol, "kind": "send", "channel": "table", "id": "send", "value": map[string]any{"sequence": i}})
		if readTest(t, c)["kind"] != "ack" {
			t.Fatal("active sender lost connection")
		}
	}
	clock.Add(46000)
	s.mu.Lock()
	s.sweepLocked()
	s.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, _, err := c.Read(ctx); err == nil {
		t.Fatal("truly idle connection was not closed")
	}
}
