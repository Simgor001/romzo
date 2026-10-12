package main

// Attestation layer: pluggable human-verification providers that all funnel
// into one relay-trusted credential — the SignedGrant. CREATE_AUTH selects
// which provider combinations allocate accepts; the verify and OAuth endpoints
// issue grants after the provider's own challenge succeeds.

import (
	"crypto/hmac"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// createMode is the parsed CREATE_AUTH matrix. allowAll covers anonymous/off.
type createMode struct {
	allowAll  bool
	password  bool
	turnstile bool
	oauth     bool
}

func parseCreateMode(auth string) (createMode, error) {
	auth = strings.ToLower(strings.TrimSpace(auth))
	switch auth {
	case "anonymous", "off":
		return createMode{allowAll: true}, nil
	case "password":
		return createMode{password: true}, nil
	}
	var m createMode
	seen := map[string]bool{}
	for _, token := range strings.Split(auth, "+") {
		token = strings.TrimSpace(token)
		if seen[token] {
			return m, errors.New("invalid CREATE_AUTH")
		}
		seen[token] = true
		switch token {
		case "turnstile":
			m.turnstile = true
		case "oauth", "oidc":
			m.oauth = true
		default:
			return m, errors.New("invalid CREATE_AUTH")
		}
	}
	if !m.turnstile && !m.oauth {
		return m, errors.New("invalid CREATE_AUTH")
	}
	return m, nil
}

// canonical string advertised in discovery; accepts both spellings but
// normalizes so clients see one vocabulary.
func (m createMode) String() string {
	switch {
	case m.allowAll:
		return "anonymous"
	case m.password:
		return "password"
	case m.turnstile && m.oauth:
		return "turnstile+oauth"
	case m.turnstile:
		return "turnstile"
	default:
		return "oauth"
	}
}

// acceptsProvider reports whether a grant from the given provider satisfies
// this mode. Strict on purpose: a turnstile-only node must not accept
// turnstile+oauth grants, or its OAuth half would be silently optional.
func (m createMode) acceptsProvider(provider string) bool {
	switch {
	case m.turnstile && m.oauth:
		return strings.HasPrefix(provider, "turnstile+oauth:")
	case m.turnstile:
		return provider == "turnstile"
	case m.oauth:
		return strings.HasPrefix(provider, "oauth:")
	}
	return false
}

// OAuthConfig is a generic OAuth2 client (covers GitHub, itch.io and most
// OIDC providers through their OAuth2-compatible endpoints).
type OAuthConfig struct {
	Provider   string // short display name used in grants, e.g. "github"
	ClientID   string
	ClientSecret string
	AuthorizeURL string
	TokenURL     string
	UserInfoURL  string
	Scopes       []string
	NameField    string // dot path into the userinfo JSON, e.g. "login" or "user.username"
}

func (c OAuthConfig) configured() bool { return c.ClientID != "" }

type oauthPending struct {
	Host    string
	Expires time.Time
}
type verifySession struct {
	Subject  string
	Provider string
	Host     string
	Expires  time.Time
}

// issueGrantLocked signs a grant bound to the creator host key.
func (s *Server) issueGrantLocked(provider, subject, host string, ttl time.Duration) SignedGrant {
	g := Grant{protocol, s.cfg.Origin, provider, subject, host, s.now().Add(ttl).UnixMilli(), randomHex(16)}
	return SignedGrant{g, mac(s.cfg.GrantKey, grantDomain, g)}
}

// consumeGrantLocked validates a presented grant against the mode and creator
// host key, and burns the nonce. Grants are single-use: a burned grant that
// fails a later check (e.g. room capacity) must be re-attested, mirroring the
// single-use challenge semantics.
func (s *Server) consumeGrantLocked(sg SignedGrant, host string, m createMode) (string, error) {
	if s.cfg.GrantKey == nil {
		return "", errors.New("grants disabled")
	}
	g := sg.Grant
	a, e := hex.DecodeString(sg.Signature)
	expected, _ := hex.DecodeString(mac(s.cfg.GrantKey, grantDomain, g))
	if e != nil || !hmac.Equal(a, expected) || g.Protocol != protocol || g.Origin != s.cfg.Origin ||
		g.Expires <= s.now().UnixMilli() || !validHex(g.Nonce, 16) || !validHex(g.Host, 32) {
		return "", errors.New("invalid grant")
	}
	if g.Host != host {
		return "", errors.New("grant host mismatch")
	}
	if !m.acceptsProvider(g.Provider) {
		return "", errors.New("grant provider not accepted")
	}
	if expires, used := s.grants[g.Nonce]; used && expires > s.now().UnixMilli() {
		return "", errors.New("grant replay")
	}
	s.grants[g.Nonce] = g.Expires
	if len(s.grants) > 8192 {
		s.sweepGrantsLocked()
		if len(s.grants) > 8192 {
			delete(s.grants, g.Nonce)
			return "", errors.New("grant capacity")
		}
	}
	if g.Subject == "" {
		return g.Provider, nil
	}
	return g.Subject, nil
}

func (s *Server) sweepGrantsLocked() {
	now := s.now().UnixMilli()
	for nonce, expires := range s.grants {
		if expires <= now {
			delete(s.grants, nonce)
		}
	}
	for state, pending := range s.oauthStates {
		if !pending.Expires.After(s.now()) {
			delete(s.oauthStates, state)
		}
	}
	for token, session := range s.verifySessions {
		if !session.Expires.After(s.now()) {
			delete(s.verifySessions, token)
		}
	}
}

// serveVerify exchanges a Turnstile token for a grant. With a session token
// (issued by the OAuth callback in combined mode) it additionally binds the
// OAuth identity, producing a turnstile+oauth grant.
func (s *Server) serveVerify(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || s.cfg.GrantKey == nil || s.cfg.TurnstileSecret == "" {
		failure(w, 404, "not_found")
		return
	}
	var body struct {
		Turnstile string `json:"turnstile"`
		Host      string `json:"host"`
		Session   string `json:"session"`
	}
	if !readBody(w, r, &body) {
		return
	}
	if !validHex(body.Host, 32) {
		failure(w, 400, "invalid_request")
		return
	}
	// Turnstile verification is a blocking network call; it runs outside the
	// lock, and a spent session/token cannot be replayed because issuance is
	// single-use under the lock below.
	if status, code := s.verifyTurnstile(r, body.Turnstile); code != "" {
		failure(w, status, code)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	provider, subject := "turnstile", ""
	if body.Session != "" {
		session, ok := s.verifySessions[body.Session]
		if !ok || !session.Expires.After(s.now()) || session.Host != body.Host {
			failure(w, 403, "session_expired")
			return
		}
		delete(s.verifySessions, body.Session)
		provider, subject = "turnstile+oauth:"+session.Provider, session.Subject
	}
	result(w, 200, map[string]any{"grant": s.issueGrantLocked(provider, subject, body.Host, grantTTL)})
}

// serveOAuthLogin starts the OAuth2 authorization-code flow. The creator host
// key travels in the state map so the resulting grant binds to it.
func (s *Server) serveOAuthLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet || !s.cfg.OAuth.configured() {
		failure(w, 404, "not_found")
		return
	}
	host := r.URL.Query().Get("host")
	if !validHex(host, 32) {
		failure(w, 400, "invalid_request")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.oauthStates) >= 2048 {
		failure(w, 503, "challenge_capacity")
		return
	}
	state := randomHex(16)
	s.oauthStates[state] = oauthPending{host, s.now().Add(10 * time.Minute)}
	target, _ := url.Parse(s.cfg.OAuth.AuthorizeURL)
	query := target.Query()
	query.Set("client_id", s.cfg.OAuth.ClientID)
	query.Set("redirect_uri", s.cfg.Origin+"/api/v1/auth/oauth/callback")
	query.Set("response_type", "code")
	query.Set("state", state)
	if len(s.cfg.OAuth.Scopes) > 0 {
		query.Set("scope", strings.Join(s.cfg.OAuth.Scopes, " "))
	}
	target.RawQuery = query.Encode()
	w.Header().Set("Location", target.String())
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(302)
}

// serveOAuthCallback completes the flow: exchanges the code, reads the
// identity, then either issues the grant immediately or renders the Turnstile
// gate that finishes a combined turnstile+oauth attestation.
func (s *Server) serveOAuthCallback(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet || !s.cfg.OAuth.configured() {
		failure(w, 404, "not_found")
		return
	}
	query := r.URL.Query()
	if query.Get("error") != "" {
		s.renderGrantError(w, "oauth_denied")
		return
	}
	code, state := query.Get("code"), query.Get("state")
	s.mu.Lock()
	pending, ok := s.oauthStates[state]
	if ok {
		delete(s.oauthStates, state)
	}
	s.mu.Unlock()
	if !ok || !pending.Expires.After(s.now()) || code == "" {
		s.renderGrantError(w, "oauth_state_expired")
		return
	}
	token, err := s.oauthToken(r, code)
	if err != nil {
		s.renderGrantError(w, "oauth_token_failed")
		return
	}
	subject, err := s.oauthSubject(r, token)
	if err != nil || subject == "" || len(subject) > 200 {
		s.renderGrantError(w, "oauth_userinfo_failed")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.mode.turnstile {
		if s.cfg.TurnstileSiteKey == "" {
			s.renderGrantError(w, "turnstile_sitekey_missing")
			return
		}
		if len(s.verifySessions) >= 2048 {
			s.renderGrantError(w, "challenge_capacity")
			return
		}
		session := randomHex(16)
		s.verifySessions[session] = verifySession{subject, s.cfg.OAuth.Provider, pending.Host, s.now().Add(10 * time.Minute)}
		s.renderTurnstileGate(w, session, pending.Host)
		return
	}
	grant := s.issueGrantLocked("oauth:"+s.cfg.OAuth.Provider, subject, pending.Host, grantTTL)
	s.renderGrantDone(w, grant)
}

func (s *Server) oauthToken(r *http.Request, code string) (string, error) {
	form := url.Values{"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {s.cfg.Origin + "/api/v1/auth/oauth/callback"}, "client_id": {s.cfg.OAuth.ClientID}, "client_secret": {s.cfg.OAuth.ClientSecret}}
	req, e := http.NewRequestWithContext(r.Context(), http.MethodPost, s.cfg.OAuth.TokenURL, strings.NewReader(form.Encode()))
	if e != nil {
		return "", e
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, e := s.client.Do(req)
	if e != nil {
		return "", e
	}
	defer resp.Body.Close()
	var v struct {
		AccessToken string `json:"access_token"`
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&v) != nil || v.AccessToken == "" {
		return "", errors.New("token exchange failed")
	}
	return v.AccessToken, nil
}

func (s *Server) oauthSubject(r *http.Request, token string) (string, error) {
	req, e := http.NewRequestWithContext(r.Context(), http.MethodGet, s.cfg.OAuth.UserInfoURL, nil)
	if e != nil {
		return "", e
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	resp, e := s.client.Do(req)
	if e != nil {
		return "", e
	}
	defer resp.Body.Close()
	var v map[string]any
	if resp.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&v) != nil {
		return "", errors.New("userinfo failed")
	}
	current := any(v)
	for _, part := range strings.Split(s.cfg.OAuth.NameField, ".") {
		object, ok := current.(map[string]any)
		if !ok {
			return "", errors.New("name field not found")
		}
		current, ok = object[part]
		if !ok {
			return "", errors.New("name field not found")
		}
	}
	name, ok := current.(string)
	if !ok {
		return "", errors.New("name field not a string")
	}
	return name, nil
}

// scriptJSON embeds a value into an inline <script> safely: "<" becomes
// \u003c so a hostile OAuth subject can never break out of the tag.
func scriptJSON(v any) string {
	return strings.ReplaceAll(string(wire(v)), "<", "\\u003c")
}

func (s *Server) grantTargetOrigin() string {
	if len(s.cfg.ClientOrigins) == 1 && s.cfg.ClientOrigins[0] != "*" {
		return s.cfg.ClientOrigins[0]
	}
	return "*"
}

func (s *Server) renderGrantDone(w http.ResponseWriter, grant SignedGrant) {
	payload := scriptJSON(map[string]any{"type": "romzo-grant", "grant": grant})
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	fmt.Fprintf(w, `<!doctype html><meta charset="utf-8"><title>Romzo</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1a1a2e}pre{white-space:pre-wrap;word-break:break-all;background:#f4f4f8;padding:1rem;border-radius:8px;font-size:.8rem}</style>
<p id="m">验证成功，正在返回游戏页面…</p>
<p id="g"></p>
<script>
const payload = %s;
try { if (window.opener) window.opener.postMessage(payload, %s); } catch (e) {}
document.getElementById('m').textContent = '验证成功，可以关闭此页面。';
document.getElementById('g').textContent = JSON.stringify(payload.grant);
</script>`, payload, jsonString(s.grantTargetOrigin()))
}

func (s *Server) renderGrantError(w http.ResponseWriter, code string) {
	payload := scriptJSON(map[string]any{"type": "romzo-grant-error", "error": code})
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(403)
	fmt.Fprintf(w, `<!doctype html><meta charset="utf-8"><title>Romzo</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1a1a2e}</style>
<p>验证失败（%s）。请关闭此页面并重试。</p>
<script>
try { if (window.opener) window.opener.postMessage(%s, %s); } catch (e) {}
</script>`, html.EscapeString(code), payload, jsonString(s.grantTargetOrigin()))
}

// turnstileActionOrDefault returns the action the relay's own widgets render
// with. Server-side enforcement is opt-in via TURNSTILE_ACTION.
func (c Config) turnstileActionOrDefault() string {
	if c.TurnstileAction != "" {
		return c.TurnstileAction
	}
	return "create-room"
}

// renderTurnstileGate finishes a combined attestation: the player proves
// human once more via Turnstile before the OAuth-bound grant is issued.
func (s *Server) renderTurnstileGate(w http.ResponseWriter, session, host string) {
	data := scriptJSON(map[string]string{"session": session, "host": host, "sitekey": s.cfg.TurnstileSiteKey, "action": s.cfg.turnstileActionOrDefault()})
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	fmt.Fprintf(w, `<!doctype html><meta charset="utf-8"><title>Romzo</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1a1a2e}</style>
<p>最后一步：请完成人机验证。</p>
<div id="box"></div>
<p id="m"></p>
<script src="https://challenges.cloudflare.com/turnstile/api.js?render=explicit"></script>
<script>
const cfg = %s;
window.turnstile.render('#box', {sitekey: cfg.sitekey, action: cfg.action, callback(token) {
  fetch('/api/v1/verify', {method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({turnstile: token, host: cfg.host, session: cfg.session})})
    .then(r => r.json().then(j => r.ok ? j : Promise.reject(j)))
    .then(j => {
      const payload = {type: 'romzo-grant', grant: j.grant};
      try { if (window.opener) window.opener.postMessage(payload, %s); } catch (e) {}
      document.getElementById('m').textContent = '验证成功，可以关闭此页面。';
      window.turnstile.reset();
    })
    .catch(() => {
      const payload = {type: 'romzo-grant-error', error: 'turnstile_failed'};
      try { if (window.opener) window.opener.postMessage(payload, %s); } catch (e) {}
      document.getElementById('m').textContent = '验证失败，请刷新重试。';
      window.turnstile.reset();
    });
}});
</script>`, data, jsonString(s.grantTargetOrigin()), jsonString(s.grantTargetOrigin()))
}
