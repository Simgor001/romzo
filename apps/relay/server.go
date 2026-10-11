package main

import (
	"crypto/hmac"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

type Challenge struct{ Expires time.Time }
type Room struct {
	quotaSubject             string
	Signed                   SignedDescriptor
	Request                  AllocationRequest
	RequestHash              string
	Expires                  time.Time
	Confirmed, EverConnected bool
	Active                   time.Time
	Peers                    map[string]*Peer
	Channels                 map[string]int
}
type bucket struct {
	tokens float64
	at     time.Time
}
type CreateAuthorizer interface {
	Authorize(AllocationRequest, string) (string, error)
}
type passwordAuthorizer struct{ key []byte }

func (a passwordAuthorizer) Authorize(r AllocationRequest, proof string) (string, error) {
	p, e := hex.DecodeString(proof)
	expected, _ := hex.DecodeString(mac(a.key, "romzo/relay-create/v1", r))
	if e != nil || !hmac.Equal(p, expected) {
		return "", errors.New("authorization_failed")
	}
	return "shared-password", nil
}

type anonymousAuthorizer struct{}

func (anonymousAuthorizer) Authorize(AllocationRequest, string) (string, error) {
	return "anonymous", nil
}

type Server struct {
	closeReasons                                                        map[string]int
	cfg                                                                 Config
	auth                                                                CreateAuthorizer
	client                                                              *http.Client
	now                                                                 func() time.Time
	mu                                                                  sync.Mutex
	rooms                                                               map[string]*Room
	requests                                                            map[string]string
	challenges                                                          map[string]Challenge
	limits                                                              map[string]bucket
	connections, unauthenticated, queued                                int
	receivedFrames, receivedBytes, sentFrames, sentBytes, queueRejected int64
}

func newServer(c Config) *Server {
	if c.IPBytesPerSecond == 0 {
		c.IPBytesPerSecond = c.BytesPerSecond
	}
	if c.OptionsBytes == 0 {
		c.OptionsBytes = 4096
	}
	s := &Server{cfg: c, now: time.Now, client: &http.Client{Timeout: 10 * time.Second}, rooms: map[string]*Room{}, requests: map[string]string{}, challenges: map[string]Challenge{}, limits: map[string]bucket{}, closeReasons: map[string]int{}}
	if c.Auth == "password" {
		s.auth = passwordAuthorizer{c.Verifier}
	} else {
		s.auth = anonymousAuthorizer{}
	}
	return s
}
func (s *Server) sweepLocked() {
	now := s.now()
	for k, c := range s.challenges {
		if !c.Expires.After(now) {
			delete(s.challenges, k)
		}
	}
	for code, r := range s.rooms {
		active := false
		for _, p := range r.Peers {
			if now.Sub(p.lastSeen) >= 45*time.Second {
				if p.cancel != nil {
					p.cancel()
				}
			} else if len(p.channels) > 0 {
				active = true
			}
		}
		ttl := 10 * time.Minute
		if r.EverConnected {
			ttl = 30 * time.Minute
		}
		if (!r.Confirmed && !r.Expires.After(now)) || (r.Confirmed && !active && !r.Active.Add(ttl).After(now)) {
			delete(s.rooms, code)
			delete(s.requests, r.Request.RequestID)
		}
	}
	for k, b := range s.limits {
		if now.Sub(b.at) > time.Minute*10 {
			delete(s.limits, k)
		}
	}
}
func (s *Server) allowLocked(key string, rate, burst float64) bool {
	return s.allowCostLocked(key, rate, burst, 1)
}
func (s *Server) allowCostLocked(key string, rate, burst, cost float64) bool {
	now := s.now()
	b, ok := s.limits[key]
	if !ok {
		if len(s.limits) >= 8192 {
			return false
		}
		b = bucket{burst, now}
	}
	b.tokens += now.Sub(b.at).Seconds() * rate
	if b.tokens > burst {
		b.tokens = burst
	}
	b.at = now
	allowed := b.tokens >= cost
	if allowed {
		b.tokens -= cost
	}
	s.limits[key] = b
	return allowed
}
func (s *Server) originAllowed(origin string) bool {
	for _, v := range s.cfg.ClientOrigins {
		if v == origin {
			return true
		}
	}
	return false
}
func result(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(wire(v))
}
func failure(w http.ResponseWriter, status int, code string) {
	result(w, status, map[string]string{"error": code})
}
func readBody(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, controlLimit)
	var data json.RawMessage
	d := json.NewDecoder(r.Body)
	if d.Decode(&data) != nil || decode(data, v) != nil {
		failure(w, 400, "invalid_request")
		return false
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		failure(w, 400, "invalid_request")
		return false
	}
	return true
}
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.RawQuery != "" {
		failure(w, 400, "query_not_allowed")
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		if !s.originAllowed(origin) {
			failure(w, 403, "origin_denied")
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Vary", "Origin")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	}
	if r.Method == "OPTIONS" {
		w.WriteHeader(204)
		return
	}
	if r.Method == "GET" && (r.URL.Path == "/healthz" || r.URL.Path == "/readyz") {
		result(w, 200, map[string]bool{"ready": true})
		return
	}
	if r.Method == "GET" && r.URL.Path == "/.well-known/romzo" {
		result(w, 200, map[string]any{"protocol": protocol, "version": version, "origin": s.cfg.Origin, "auth": s.cfg.Auth, "salt": hex.EncodeToString(s.cfg.Salt), "iterations": 600000, "algorithm": "PBKDF2-HMAC-SHA256", "turnstile": s.cfg.TurnstileSecret != "", "limits": map[string]int{"framesPerSecond": s.cfg.FramesPerSecond, "bytesPerSecond": s.cfg.BytesPerSecond}})
		return
	}
	ip := s.clientIP(r)
	limitKey, rate, burst := r.URL.Path, float64(2), float64(10)
	if r.URL.Path == wsPath {
		rate, burst = 8, 32
	}
	if strings.HasPrefix(r.URL.Path, api+"rooms/") {
		switch {
		case r.Method == "GET":
			limitKey = "room-query"
			rate, burst = 16, 64
		case strings.HasSuffix(r.URL.Path, "/admissions"):
			limitKey = "admissions"
			rate, burst = 8, 32
		case strings.HasSuffix(r.URL.Path, "/restore"):
			limitKey = "restore"
			rate, burst = 4, 16
		case strings.HasSuffix(r.URL.Path, "/confirm"):
			limitKey = "confirm"
		}
	}
	s.mu.Lock()
	s.sweepLocked()
	allowed := s.allowLocked(ip+"/"+limitKey, rate, burst)
	s.mu.Unlock()
	if !allowed {
		failure(w, 429, "rate_limited")
		return
	}
	if r.Method == "GET" && r.URL.Path == api+"metrics" {
		s.mu.Lock()
		defer s.mu.Unlock()
		result(w, 200, map[string]any{"rooms": len(s.rooms), "connections": s.connections, "unauthenticated": s.unauthenticated, "queueBytes": s.queued, "receivedFrames": s.receivedFrames, "receivedBytes": s.receivedBytes, "sentFrames": s.sentFrames, "sentBytes": s.sentBytes, "queueRejected": s.queueRejected, "closedReasons": s.closeReasons})
		return
	}
	if r.Method == "GET" && r.URL.Path == wsPath {
		s.websocket(w, r)
		return
	}
	if r.Method == "POST" && r.URL.Path == api+"room-challenges" {
		s.mu.Lock()
		defer s.mu.Unlock()
		if len(s.challenges) >= 2048 {
			failure(w, 503, "challenge_capacity")
			return
		}
		id := randomHex(32)
		s.challenges[id] = Challenge{s.now().Add(30 * time.Second)}
		result(w, 200, map[string]any{"challenge": id, "expires": s.challenges[id].Expires.UnixMilli()})
		return
	}
	if r.Method == "POST" && r.URL.Path == api+"rooms" {
		s.allocate(w, r)
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, api+"rooms/"), "/")
	if !strings.HasPrefix(r.URL.Path, api+"rooms/") || len(parts) > 2 {
		failure(w, 404, "not_found")
		return
	}
	code := parts[0]
	if len(parts) == 1 && r.Method == "GET" {
		s.mu.Lock()
		defer s.mu.Unlock()
		room := s.rooms[code]
		if room == nil || !room.Confirmed {
			failure(w, 404, "room_not_found")
			return
		}
		result(w, 200, room.Signed)
		return
	}
	if r.Method == "POST" && len(parts) == 2 {
		switch parts[1] {
		case "confirm":
			s.confirm(w, r, code)
			return
		case "admissions":
			s.admit(w, r, code)
			return
		case "restore":
			s.restore(w, r, code)
			return
		}
	}
	failure(w, 404, "not_found")
}
func (s *Server) clientIP(r *http.Request) string {
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	current := net.ParseIP(host)
	trusted := func(ip net.IP) bool {
		for _, network := range s.cfg.TrustedProxies {
			if network.Contains(ip) {
				return true
			}
		}
		return false
	}
	if current == nil || !trusted(current) {
		return host
	}
	chain := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
	for i := len(chain) - 1; i >= 0 && trusted(current); i-- {
		next := net.ParseIP(strings.TrimSpace(chain[i]))
		if next == nil {
			return host
		}
		current = next
	}
	return current.String()
}
func validOptions(data json.RawMessage) bool {
	if len(data) == 0 || len(data) > 4096 || !json.Valid(data) {
		return false
	}
	var value any
	if decode(data, &value) != nil {
		return false
	}
	_, err := canonical(value)
	return err == nil
}

var channelNamePattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)

func defaultChannelSet() map[string]int {
	channels := make(map[string]int, len(defaultChannels))
	for name, limit := range defaultChannels {
		channels[name] = limit
	}
	return channels
}

// channelsFromOptions extracts the declared channel set from opaque room
// options; options without a "channels" key keep the compatibility defaults.
// The relay only validates name syntax and numeric bounds — channel meaning
// is application policy, and configHash binds every peer of a room to the
// same declaration.
func channelsFromOptions(data json.RawMessage) (map[string]int, error) {
	var root any
	if err := decode(data, &root); err != nil {
		return nil, err
	}
	object, ok := root.(map[string]any)
	if !ok {
		return defaultChannelSet(), nil
	}
	raw, present := object["channels"]
	if !present || raw == nil {
		return defaultChannelSet(), nil
	}
	blob, err := json.Marshal(raw)
	if err != nil {
		return nil, err
	}
	var declared []struct {
		Name          string `json:"name"`
		MaxFrameBytes int    `json:"maxFrameBytes"`
	}
	if err := decode(blob, &declared); err != nil {
		return nil, err
	}
	if len(declared) > 8 {
		return nil, errors.New("too many channels")
	}
	channels := make(map[string]int, len(declared))
	for _, c := range declared {
		if !channelNamePattern.MatchString(c.Name) {
			return nil, errors.New("invalid channel name")
		}
		if c.MaxFrameBytes < 256 || c.MaxFrameBytes > payloadLimit {
			return nil, errors.New("channel frame limit out of range")
		}
		if _, duplicate := channels[c.Name]; duplicate {
			return nil, errors.New("duplicate channel")
		}
		channels[c.Name] = c.MaxFrameBytes
	}
	return channels, nil
}
func (s *Server) allocate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Request   AllocationRequest `json:"request"`
		Proof     string            `json:"proof"`
		Turnstile string            `json:"turnstile"`
	}
	if !readBody(w, r, &body) {
		return
	}
	q := body.Request
	if q.Protocol != protocol || q.Origin != s.cfg.Origin || !validHex(q.RequestID, 16) || !validHex(q.Host, 32) || !validHex(q.Transport, 32) || !validHex(q.Capability, 16) || len(q.Options) > s.cfg.OptionsBytes || !validOptions(q.Options) || hash("romzo/lobby-options/v1", q.Options) != q.ConfigHash {
		failure(w, 400, "invalid_allocation")
		return
	}
	channels, err := channelsFromOptions(q.Options)
	if err != nil {
		failure(w, 400, "invalid_allocation")
		return
	}
	h := hash("romzo/relay-request/v1", q)
	s.mu.Lock()
	if code := s.requests[q.RequestID]; code != "" {
		room := s.rooms[code]
		s.mu.Unlock()
		if room != nil && room.RequestHash == h {
			result(w, 200, room.Signed.Descriptor)
			return
		}
		failure(w, 409, "request_conflict")
		return
	}
	s.mu.Unlock()
	// Turnstile verification is a blocking network call. It runs before the
	// single-use challenge is consumed and must stay outside the server lock;
	// idempotent replays above never re-verify an already spent token.
	if s.cfg.TurnstileSecret != "" {
		if body.Turnstile == "" {
			failure(w, 403, "turnstile_required")
			return
		}
		if status, code := s.verifyTurnstile(r, body.Turnstile); code != "" {
			failure(w, status, code)
			return
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	challenge, ok := s.challenges[q.Challenge]
	if !ok || !challenge.Expires.After(s.now()) {
		failure(w, 401, "challenge_expired")
		return
	}
	delete(s.challenges, q.Challenge) // Failed proofs also consume the single-use challenge.
	subject, authError := s.auth.Authorize(q, body.Proof)
	if authError != nil || subject == "" || len(subject) > 200 {
		failure(w, 401, "authorization_failed")
		return
	}
	if len(s.rooms) >= s.cfg.Rooms {
		failure(w, 503, "room_capacity")
		return
	}
	code := randomCode()
	for s.rooms[code] != nil {
		code = randomCode()
	}
	d := Descriptor{protocol, s.cfg.Origin, code, randomHex(16), q.Host, q.Transport, q.Capability, q.ConfigHash, q.Options}
	room := &Room{quotaSubject: subject, Signed: SignedDescriptor{Descriptor: d}, Request: q, RequestHash: h, Expires: s.now().Add(30 * time.Second), Active: s.now(), Peers: map[string]*Peer{}, Channels: channels}
	s.rooms[code] = room
	s.requests[q.RequestID] = code
	result(w, 200, d)
}

// verifyTurnstile checks a Cloudflare Turnstile token against the configured
// siteverify endpoint. A non-OK or undecodable response is unavailable, not a
// failed token; the feature fails closed either way while it is enabled.
func (s *Server) verifyTurnstile(r *http.Request, token string) (int, string) {
	form := url.Values{"secret": {s.cfg.TurnstileSecret}, "response": {token}, "remoteip": {s.clientIP(r)}}
	req, e := http.NewRequestWithContext(r.Context(), http.MethodPost, s.cfg.TurnstileURL, strings.NewReader(form.Encode()))
	if e != nil {
		return 503, "turnstile_unavailable"
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, e := s.client.Do(req)
	if e != nil {
		return 503, "turnstile_unavailable"
	}
	defer resp.Body.Close()
	var v struct {
		Success bool `json:"success"`
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&v) != nil {
		return 503, "turnstile_unavailable"
	}
	if !v.Success {
		return 403, "turnstile_failed"
	}
	return 0, ""
}
func (s *Server) confirm(w http.ResponseWriter, r *http.Request, code string) {
	var d SignedDescriptor
	if !readBody(w, r, &d) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	room := s.rooms[code]
	if room == nil || hash("romzo/relay-descriptor-body/v1", room.Signed.Descriptor) != hash("romzo/relay-descriptor-body/v1", d.Descriptor) || !verifySignature(d.Descriptor.Host, d.Signature, "romzo/relay-descriptor/v1", d.Descriptor) {
		failure(w, 403, "confirmation_failed")
		return
	}
	if !room.Confirmed && !room.Expires.After(s.now()) {
		failure(w, 410, "reservation_expired")
		return
	}
	if !room.Confirmed {
		room.Active = s.now()
	}
	room.Signed = d
	room.Confirmed = true
	lease := 10 * time.Minute
	if room.EverConnected {
		lease = 30 * time.Minute
	}
	remaining := room.Active.Add(lease).Sub(s.now())
	if remaining <= 0 {
		failure(w, 410, "room_expired")
		return
	}
	result(w, 200, map[string]any{"admission": s.ticket(room, d.Descriptor.Transport, "creator", 60*time.Second), "recovery": s.ticket(room, d.Descriptor.Transport, "recovery", remaining)})
}
func (s *Server) admit(w http.ResponseWriter, r *http.Request, code string) {
	var b struct {
		Key string `json:"key"`
	}
	if !readBody(w, r, &b) {
		return
	}
	if !validHex(b.Key, 32) {
		failure(w, 400, "invalid_key")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	room := s.rooms[code]
	if room == nil || !room.Confirmed {
		failure(w, 404, "room_not_found")
		return
	}
	result(w, 200, map[string]any{"admission": s.ticket(room, b.Key, "guest", 60*time.Second)})
}
func (s *Server) restore(w http.ResponseWriter, r *http.Request, code string) {
	var b struct {
		Signed    SignedDescriptor `json:"signed"`
		Recovery  SignedTicket     `json:"recovery"`
		Signature string           `json:"signature"`
	}
	if !readBody(w, r, &b) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	t := b.Recovery.Ticket
	d := b.Signed.Descriptor
	if len(d.Options) > s.cfg.OptionsBytes || !validOptions(d.Options) || !s.validTicket(b.Recovery, "recovery") || t.Code != code || t.Instance != d.Instance || t.Code != d.Code || d.Origin != s.cfg.Origin || t.Digest != hash("romzo/relay-descriptor/v1", b.Signed) || !verifySignature(d.Host, b.Signed.Signature, "romzo/relay-descriptor/v1", d) || !verifySignature(t.Key, b.Signature, "romzo/relay-restore/v1", b.Recovery) {
		failure(w, 403, "restore_failed")
		return
	}
	channels, err := channelsFromOptions(d.Options)
	if err != nil {
		failure(w, 403, "restore_failed")
		return
	}
	room := s.rooms[code]
	if room != nil && hash("romzo/relay-descriptor/v1", room.Signed) != t.Digest {
		failure(w, 409, "room_identity_conflict")
		return
	}
	if room == nil {
		if len(s.rooms) >= s.cfg.Rooms {
			failure(w, 503, "room_capacity")
			return
		}
		// Recovery reinstates the existing lease. Only authenticated subscription
		// and keepalive may renew it; HTTP replay cannot mint extra lifetime.
		room = &Room{Signed: b.Signed, Confirmed: true, EverConnected: true, Active: time.UnixMilli(t.Expires).Add(-30 * time.Minute), Peers: map[string]*Peer{}, Channels: channels}
		s.rooms[code] = room
	}
	purpose := "guest"
	if t.Key == d.Transport {
		purpose = "creator"
	}
	result(w, 200, map[string]any{"admission": s.ticket(room, t.Key, purpose, 60*time.Second)})
}
