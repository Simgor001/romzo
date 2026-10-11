package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/coder/websocket"
	"net/http/httptest"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// Opt-in real sockets with bounded retention. This is relay load, not a gameplay proof.
func TestLoad(t *testing.T) {
	durationText := os.Getenv("RU_LOAD_DURATION")
	if durationText == "" {
		t.Skip("set RU_LOAD_DURATION=30m for deployment-budget acceptance")
	}
	duration, e := time.ParseDuration(durationText)
	if e != nil {
		t.Fatal(e)
	}
	s := newServer(testConfig())
	httpServer := httptest.NewServer(s)
	defer httpServer.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var clients []*websocket.Conn
	var wg sync.WaitGroup
	var mu sync.Mutex
	var samples []int64
	var deliveries int64
	var errorsCount int
	maxRSS := 0
	for roomNumber := 0; roomNumber < 20; roomNumber++ {
		d, _, _, _, _ := allocateTest(t, s)
		for player := 0; player < 8; player++ {
			public, key, _ := ed25519.GenerateKey(rand.Reader)
			s.mu.Lock()
			ticket := s.ticket(s.rooms[d.Descriptor.Code], hex.EncodeToString(public), "guest", 60*time.Second)
			s.mu.Unlock()
			c := connectTest(t, httpServer.URL, ticket, key)
			clients = append(clients, c)
			wg.Add(1)
			go func(c *websocket.Conn) {
				defer wg.Done()
				for {
					_, b, e := c.Read(ctx)
					if e != nil {
						if ctx.Err() == nil {
							mu.Lock()
							errorsCount++
							mu.Unlock()
						}
						return
					}
					var f struct {
						Kind  string `json:"kind"`
						Value struct {
							Sent int64 `json:"sent"`
						} `json:"value"`
					}
					if json.Unmarshal(b, &f) == nil && f.Kind == "receive" && f.Value.Sent > 0 {
						ms := time.Now().UnixMicro() - f.Value.Sent
						mu.Lock()
						deliveries++
						if len(samples) < 1000000 {
							samples = append(samples, ms)
						} else {
							samples[deliveries%1000000] = ms
						}
						mu.Unlock()
					}
				}
			}(c)
			writeTest(t, c, map[string]any{"v": protocol, "kind": "subscribe", "channel": "table", "id": "subscribe"})
			wg.Add(1)
			go func(c *websocket.Conn) {
				defer wg.Done()
				tick := time.NewTicker(10 * time.Second)
				defer tick.Stop()
				for {
					select {
					case <-ctx.Done():
						return
					case <-tick.C:
						writeCtx, done := context.WithTimeout(ctx, 5*time.Second)
						err := c.Write(writeCtx, websocket.MessageText, wire(map[string]any{"v": protocol, "kind": "keepalive", "id": "keepalive"}))
						done()
						if err != nil && ctx.Err() == nil {
							mu.Lock()
							errorsCount++
							mu.Unlock()
							return
						}
					}
				}
			}(c)
			time.Sleep(510 * time.Millisecond)
		}
	}
	start := time.Now()
	s.mu.Lock()
	activeAtStart := s.connections
	s.mu.Unlock()
	if activeAtStart != 160 {
		t.Fatalf("load warmup lost clients: %d/160", activeAtStart)
	}
	cpuStart := processCPUSeconds()
	end := start.Add(duration)
	for index, c := range clients {
		wg.Add(1)
		go func(c *websocket.Conn, offset int) {
			defer wg.Done()
			tick := time.NewTicker(time.Second)
			defer tick.Stop()
			n := 0
			for {
				select {
				case <-ctx.Done():
					return
				case <-tick.C:
					n++
					payload := strings.Repeat("g", 1024)
					if n%60 == offset {
						payload = strings.Repeat("h", 64*1024)
					}
					writeCtx, done := context.WithTimeout(ctx, 5*time.Second)
					kind := "send"
					v := map[string]any{"v": protocol, "kind": kind, "channel": "table", "id": "load", "value": map[string]any{"sent": time.Now().UnixMicro(), "opaque": payload}}
					e := c.Write(writeCtx, websocket.MessageText, wire(v))
					done()
					if e != nil && ctx.Err() == nil {
						mu.Lock()
						errorsCount++
						mu.Unlock()
						return
					}
				}
			}
		}(c, index%60)
	}
	var rss []int
	for time.Now().Before(end) {
		b, _ := os.ReadFile("/proc/self/status")
		for _, line := range strings.Split(string(b), "\n") {
			if strings.HasPrefix(line, "VmRSS:") {
				fields := strings.Fields(line)
				value, _ := strconv.Atoi(fields[1])
				rss = append(rss, value)
				if value > maxRSS {
					maxRSS = value
				}
			}
		}
		time.Sleep(5 * time.Second)
	}
	cancel()
	for _, c := range clients {
		_ = c.CloseNow()
	}
	wg.Wait()
	time.Sleep(time.Second)
	s.mu.Lock()
	connections, queued := s.connections, s.queued
	s.mu.Unlock()
	mu.Lock()
	sort.Slice(samples, func(i, j int) bool { return samples[i] < samples[j] })
	p95 := int64(0)
	if len(samples) > 0 {
		p95 = samples[len(samples)*95/100]
	}
	mu.Unlock()
	cpuSeconds := processCPUSeconds() - cpuStart
	report := map[string]any{"environment": "Go real WebSocket sockets, synthetic payloads; no gameplay or public-network proof", "rooms": 20, "clients": 160, "durationSeconds": time.Since(start).Seconds(), "deliveries": deliveries, "sampleCount": len(samples), "deliveryP95Ms": float64(p95) / 1000, "rssMaxKiB": maxRSS, "rssSamplesKiB": rss, "unexpectedErrors": errorsCount, "remainingConnections": connections, "remainingQueueBytes": queued, "payload": "1KiB each second, 64KiB history burst each minute staggered across clients, keepalive every 10 seconds", "cpuBudget": "Docker --cpus=2 --memory=2g", "byteLimit": s.cfg.BytesPerSecond, "frameLimit": s.cfg.FramesPerSecond}
	report["queueRejected"] = s.queueRejected
	report["authenticatedAtStart"] = activeAtStart
	report["cpuSeconds"] = cpuSeconds
	report["cpuAverageCores"] = cpuSeconds / time.Since(start).Seconds()
	report["receivedApplicationBytes"] = s.receivedBytes
	report["sentApplicationBytes"] = s.sentBytes
	output := os.Getenv("RU_LOAD_REPORT")
	if output == "" {
		output = "/tmp/relay-load.json"
	}
	if e = os.WriteFile(output, wire(report), 0600); e != nil {
		t.Fatal(e)
	}
	fmt.Printf("relay load: %.2fms P95, %dKiB max RSS, %d errors\n", float64(p95)/1000, maxRSS, errorsCount)
	if errorsCount != 0 || p95 > 100000 || maxRSS > 256*1024 || connections != 0 || queued != 0 {
		t.Fatal("relay load budget failed")
	}
}

// Linux image CLK_TCK is 100; CPU includes both the server and load clients.
func processCPUSeconds() float64 {
	b, e := os.ReadFile("/proc/self/stat")
	if e != nil {
		return 0
	}
	text := string(b)
	end := strings.LastIndex(text, ")")
	if end < 0 {
		return 0
	}
	fields := strings.Fields(text[end+1:])
	if len(fields) < 13 {
		return 0
	}
	user, _ := strconv.ParseFloat(fields[11], 64)
	system, _ := strconv.ParseFloat(fields[12], 64)
	return (user + system) / 100
}
