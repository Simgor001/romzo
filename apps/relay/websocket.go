package main

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
)

type Peer struct {
	id, key                 string
	conn                    *websocket.Conn
	queue                   chan []byte
	channels                map[string]bool
	bytes                   int
	room                    *Room
	cancel                  context.CancelFunc
	stop                    sync.Once
	lastSeen                time.Time
	frameTokens, byteTokens float64
	rateAt                  time.Time
}
type Frame struct {
	Version   string          `json:"v"`
	Kind      string          `json:"kind"`
	ID        string          `json:"id,omitempty"`
	Channel   string          `json:"channel,omitempty"`
	Target    json.RawMessage `json:"target,omitempty"`
	Value     json.RawMessage `json:"value,omitempty"`
	Admission *SignedTicket   `json:"admission,omitempty"`
	Signature string          `json:"signature,omitempty"`
}

func (s *Server) enqueueLocked(p *Peer, v any) bool {
	b := wire(v)
	if len(p.queue) >= 128 || p.bytes+len(b) > 1024*1024 || s.queued+len(b) > 64*1024*1024 {
		s.queueRejected++
		p.stop.Do(p.cancel)
		return false
	}
	p.bytes += len(b)
	s.queued += len(b)
	s.sentFrames++
	s.sentBytes += int64(len(b))
	p.queue <- b
	return true
}

// terminate enqueues a terminal error frame for the peer and briefly lets the
// writer flush it before the read loop returns and the connection tears down.
// Callers must not hold s.mu. Transport-level closures cannot deliver a frame.
func (s *Server) terminate(p *Peer, reason string) {
	s.mu.Lock()
	s.enqueueLocked(p, map[string]any{"v": protocol, "kind": "error", "error": reason})
	s.mu.Unlock()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		s.mu.Lock()
		empty := len(p.queue) == 0 && p.bytes == 0
		s.mu.Unlock()
		if empty {
			return
		}
		time.Sleep(time.Millisecond)
	}
}

func (s *Server) websocket(w http.ResponseWriter, r *http.Request) {
	if !s.originAllowed(r.Header.Get("Origin")) {
		failure(w, 403, "origin_denied")
		return
	}
	s.mu.Lock()
	if s.connections >= s.cfg.Connections || s.unauthenticated >= s.cfg.Unauthenticated {
		s.mu.Unlock()
		failure(w, 503, "connection_capacity")
		return
	}
	s.connections++
	s.unauthenticated++
	s.mu.Unlock()
	authenticated := false
	closeReason := "authentication_or_transport"
	defer func() {
		s.mu.Lock()
		s.connections--
		s.closeReasons[closeReason]++
		if !authenticated {
			s.unauthenticated--
		}
		s.mu.Unlock()
	}()
	c, e := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true, CompressionMode: websocket.CompressionDisabled})
	if e != nil {
		return
	}
	defer c.CloseNow()
	c.SetReadLimit(controlLimit)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	authCtx, authCancel := context.WithTimeout(ctx, 5*time.Second)
	defer authCancel()
	frameBytes := 0
	read := func(ctx context.Context) (Frame, bool) {
		var f Frame
		typ, b, e := c.Read(ctx)
		frameBytes = len(b)
		if e != nil || typ != websocket.MessageText || decode(b, &f) != nil || f.Version != protocol {
			return f, false
		}
		return f, true
	}
	f, ok := read(authCtx)
	if !ok || f.Kind != "authenticate" || f.Admission == nil {
		return
	}
	t := *f.Admission
	s.mu.Lock()
	room := s.rooms[t.Ticket.Code]
	valid := (t.Ticket.Purpose == "guest" || t.Ticket.Purpose == "creator") && s.validTicket(t, t.Ticket.Purpose) && room != nil && room.Confirmed && room.Signed.Descriptor.Instance == t.Ticket.Instance && hash("romzo/relay-descriptor/v1", room.Signed) == t.Ticket.Digest
	s.mu.Unlock()
	if !valid {
		return
	}
	challenge := map[string]any{"protocol": protocol, "origin": s.cfg.Origin, "ticket": hash("romzo/relay-admission/v1", t), "challenge": randomHex(32)}
	if c.Write(authCtx, websocket.MessageText, wire(map[string]any{"v": protocol, "kind": "challenge", "value": challenge})) != nil {
		return
	}
	f, ok = read(authCtx)
	if !ok || f.Kind != "proof" || !verifySignature(t.Ticket.Key, f.Signature, "romzo/relay-connect/v1", challenge) {
		return
	}
	p := &Peer{id: randomHex(16), key: t.Ticket.Key, conn: c, queue: make(chan []byte, 128), channels: map[string]bool{}, room: room, cancel: cancel, lastSeen: s.now(), rateAt: s.now(), frameTokens: 128, byteTokens: float64(s.cfg.BytesPerSecond * 2)}
	s.mu.Lock()
	s.sweepLocked()
	if s.rooms[t.Ticket.Code] != room || len(room.Peers) >= s.cfg.PerRoom {
		s.mu.Unlock()
		return
	}
	room.Peers[p.id] = p
	authenticated = true
	closeReason = "transport_closed_or_idle"
	s.unauthenticated--
	s.enqueueLocked(p, map[string]any{"v": protocol, "kind": "authenticated", "id": p.id})
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(room.Peers, p.id)
		for _, other := range room.Peers {
			for channel := range p.channels {
				if other.channels[channel] {
					s.enqueueLocked(other, map[string]any{"v": protocol, "kind": "leave", "channel": channel, "peer": p.id})
				}
			}
		}
		for len(p.queue) > 0 {
			b := <-p.queue
			p.bytes -= len(b)
			s.queued -= len(b)
		}
		s.mu.Unlock()
	}()
	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		for {
			select {
			case <-ctx.Done():
				return
			case b := <-p.queue:
				writeCtx, done := context.WithTimeout(ctx, 5*time.Second)
				err := c.Write(writeCtx, websocket.MessageText, b)
				done()
				s.mu.Lock()
				p.bytes -= len(b)
				s.queued -= len(b)
				s.mu.Unlock()
				if err != nil {
					cancel()
					return
				}
			}
		}
	}()
	defer func() { cancel(); <-writerDone }()
	c.SetReadLimit(frameLimit)
	for {
		readCtx, done := context.WithTimeout(ctx, 45*time.Second)
		f, ok = read(readCtx)
		done()
		if !ok {
			return
		}
		if len(f.ID) > 64 || f.ID == "" || f.Admission != nil || f.Signature != "" || len(f.Target) > 200 || (f.Kind != "send" && len(wire(f)) > controlLimit) {
			closeReason = "invalid_frame_fields"
			s.terminate(p, closeReason)
			return
		}
		target := ""
		if len(f.Target) > 0 && (json.Unmarshal(f.Target, &target) != nil || target == "") {
			closeReason = "invalid_target_encoding"
			s.terminate(p, closeReason)
			return
		}
		s.mu.Lock()
		now := s.now()
		elapsed := now.Sub(p.rateAt).Seconds()
		p.frameTokens = min(128, p.frameTokens+elapsed*float64(s.cfg.FramesPerSecond))
		p.byteTokens = min(float64(s.cfg.BytesPerSecond*2), p.byteTokens+elapsed*float64(s.cfg.BytesPerSecond))
		p.rateAt = now
		size := frameBytes
		s.receivedFrames++
		s.receivedBytes += int64(size)
		if p.frameTokens < 1 || p.byteTokens < float64(size) || !s.allowCostLocked("ws-bytes/"+s.clientIP(r), float64(s.cfg.IPBytesPerSecond), float64(s.cfg.IPBytesPerSecond*2), float64(size)) {
			closeReason = "frame_or_byte_rate"
			s.mu.Unlock()
			s.terminate(p, closeReason)
			return
		}
		p.frameTokens--
		p.byteTokens -= float64(size)
		response := map[string]any{"v": protocol, "kind": "ack", "id": f.ID}
		switch f.Kind {
		case "subscribe":
			if len(wire(f)) > controlLimit || (f.Channel != "discovery" && f.Channel != "lobby" && f.Channel != "game") {
				closeReason = "invalid_channel"
				s.mu.Unlock()
				s.terminate(p, closeReason)
				return
			}
			if !p.channels[f.Channel] {
				p.channels[f.Channel] = true
				for id, other := range room.Peers {
					if other != p && other.channels[f.Channel] {
						s.enqueueLocked(p, map[string]any{"v": protocol, "kind": "join", "channel": f.Channel, "peer": id, "key": other.key})
						s.enqueueLocked(other, map[string]any{"v": protocol, "kind": "join", "channel": f.Channel, "peer": p.id, "key": p.key})
					}
				}
			}
			room.Active = now
			p.lastSeen = now
			room.EverConnected = true
		case "unsubscribe":
			if p.channels[f.Channel] {
				delete(p.channels, f.Channel)
				for _, other := range room.Peers {
					if other != p && other.channels[f.Channel] {
						s.enqueueLocked(other, map[string]any{"v": protocol, "kind": "leave", "channel": f.Channel, "peer": p.id})
					}
				}
			}
		case "send":
			if !p.channels[f.Channel] || len(f.Value) == 0 || len(f.Value) > payloadLimit || (f.Channel != "game" && len(f.Value) > controlLimit) {
				closeReason = "message_bound_or_unsubscribed"
				s.mu.Unlock()
				s.terminate(p, closeReason)
				return
			}
			if target != "" && (room.Peers[target] == nil || target == p.id || !room.Peers[target].channels[f.Channel]) {
				response["kind"] = "error"
				response["error"] = "invalid_target"
				break
			}
			for id, other := range room.Peers {
				if other != p && other.channels[f.Channel] && (target == "" || target == id) {
					s.enqueueLocked(other, map[string]any{"v": protocol, "kind": "receive", "channel": f.Channel, "peer": p.id, "value": f.Value})
				}
			}
		case "keepalive":
			if len(p.channels) == 0 {
				closeReason = "keepalive_without_subscription"
				s.mu.Unlock()
				s.terminate(p, closeReason)
				return
			}
			room.Active = now
			p.lastSeen = now
			response["recovery"] = s.ticket(room, p.key, "recovery", 30*time.Minute)
		default:
			closeReason = "unknown_frame_kind"
			s.mu.Unlock()
			s.terminate(p, closeReason)
			return
		}
		s.enqueueLocked(p, response)
		s.mu.Unlock()
	}
}
