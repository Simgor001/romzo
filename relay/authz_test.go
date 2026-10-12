package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func rawRequest(t *testing.T, s *Server, method, target string, body any) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, target, bytes.NewReader(wire(body)))
	r.RemoteAddr = "127.0.0.1:1234"
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}

func grantTestConfig() Config {
	c := testConfig()
	c.GrantKey = bytes.Repeat([]byte{9}, 32)
	return c
}

func allocationBody(t *testing.T, s *Server, host string) map[string]any {
	t.Helper()
	var c struct{ Challenge string }
	invoke(t, s, "POST", api+"room-challenges", map[string]any{}, 200, &c)
	options := json.RawMessage(`{"app":"grant-test"}`)
	q := AllocationRequest{protocol, s.cfg.Origin, c.Challenge, randomHex(16), host, randomHex(32), hash("romzo/lobby-options/v1", options), randomHex(16), options}
	return map[string]any{"request": q}
}

func TestParseCreateMode(t *testing.T) {
	valid := map[string]createMode{
		"anonymous":        {allowAll: true},
		"off":              {allowAll: true},
		"password":         {password: true},
		"turnstile":        {turnstile: true},
		"oauth":            {oauth: true},
		"oidc":             {oauth: true},
		"turnstile+oauth":  {turnstile: true, oauth: true},
		"oauth + turnstile": {turnstile: true, oauth: true},
	}
	for input, expected := range valid {
		m, e := parseCreateMode(input)
		if e != nil || m != expected {
			t.Fatalf("%q parsed as %+v, error %v", input, m, e)
		}
	}
	for _, input := range []string{"", "OAuth2", "turnstile+password", "password+turnstile", "anonymous+turnstile", "oauth+oauth", "+", "turnstile+"} {
		if _, e := parseCreateMode(input); e == nil {
			t.Fatalf("%q accepted", input)
		}
	}
	if (createMode{turnstile: true, oauth: true}).String() != "turnstile+oauth" {
		t.Fatal("combined mode canonical string wrong")
	}
}

func TestGrantLifecycleAndReplay(t *testing.T) {
	c := grantTestConfig()
	c.Auth = "turnstile"
	c.TurnstileSecret = "unused-because-grant-path-skips-it"
	s := newServer(c)
	hp, _, _ := ed25519.GenerateKey(rand.Reader)
	host := hex.EncodeToString(hp)
	s.mu.Lock()
	grant := s.issueGrantLocked("turnstile", "", host, grantTTL)
	s.mu.Unlock()

	body := allocationBody(t, s, host)
	body["grant"] = grant
	var d Descriptor
	invoke(t, s, "POST", api+"rooms", body, 200, &d)
	if d.Code == "" {
		t.Fatal("grant allocation produced no room")
	}

	// A grant is single-use: replaying it against a fresh challenge fails even
	// though every other field is untouched.
	body = allocationBody(t, s, host)
	body["grant"] = grant
	var failure map[string]string
	invoke(t, s, "POST", api+"rooms", body, 401, &failure)
	if failure["error"] != "invalid_grant" {
		t.Fatalf("grant replay accepted: %v", failure)
	}
}

func TestGrantBindsHostKey(t *testing.T) {
	c := grantTestConfig()
	c.Auth = "turnstile"
	s := newServer(c)
	hp, _, _ := ed25519.GenerateKey(rand.Reader)
	other, _, _ := ed25519.GenerateKey(rand.Reader)
	s.mu.Lock()
	grant := s.issueGrantLocked("turnstile", "", hex.EncodeToString(hp), grantTTL)
	s.mu.Unlock()
	body := allocationBody(t, s, hex.EncodeToString(other))
	body["grant"] = grant
	var failure map[string]string
	invoke(t, s, "POST", api+"rooms", body, 401, &failure)
	if failure["error"] != "invalid_grant" {
		t.Fatalf("cross-host grant accepted: %v", failure)
	}
}

func TestGrantProviderStrictness(t *testing.T) {
	issue := func(mode, provider string) (*Server, SignedGrant, string) {
		c := grantTestConfig()
		c.Auth = mode
		s := newServer(c)
		hp, _, _ := ed25519.GenerateKey(rand.Reader)
		host := hex.EncodeToString(hp)
		s.mu.Lock()
		grant := s.issueGrantLocked(provider, "subject", host, grantTTL)
		s.mu.Unlock()
		return s, grant, host
	}
	// turnstile-only mode must not accept a combined grant.
	s, grant, host := issue("turnstile", "turnstile+oauth:github")
	body := allocationBody(t, s, host)
	body["grant"] = grant
	var failure map[string]string
	invoke(t, s, "POST", api+"rooms", body, 401, &failure)
	if failure["error"] != "invalid_grant" {
		t.Fatal("turnstile mode accepted turnstile+oauth grant")
	}
	// oauth-only mode must not accept a bare turnstile grant.
	s, grant, host = issue("oauth", "turnstile")
	body = allocationBody(t, s, host)
	body["grant"] = grant
	invoke(t, s, "POST", api+"rooms", body, 401, &failure)
	if failure["error"] != "invalid_grant" {
		t.Fatal("oauth mode accepted turnstile grant")
	}
	// An oauth grant records the provider identity as the quota subject.
	s, grant, host = issue("oauth", "oauth:github")
	body = allocationBody(t, s, host)
	body["grant"] = grant
	var d Descriptor
	invoke(t, s, "POST", api+"rooms", body, 200, &d)
	s.mu.Lock()
	subject := s.rooms[d.Code].quotaSubject
	s.mu.Unlock()
	if subject != "subject" {
		t.Fatalf("oauth subject not used for quota: %q", subject)
	}
}

func TestGrantExpiry(t *testing.T) {
	c := grantTestConfig()
	c.Auth = "turnstile"
	s := newServer(c)
	now := time.Now()
	s.now = func() time.Time { return now }
	hp, _, _ := ed25519.GenerateKey(rand.Reader)
	host := hex.EncodeToString(hp)
	s.mu.Lock()
	grant := s.issueGrantLocked("turnstile", "", host, grantTTL)
	s.mu.Unlock()
	now = now.Add(grantTTL + time.Second)
	body := allocationBody(t, s, host)
	body["grant"] = grant
	var failure map[string]string
	invoke(t, s, "POST", api+"rooms", body, 401, &failure)
	if failure["error"] != "invalid_grant" {
		t.Fatal("expired grant accepted")
	}
}

func TestVerifyEndpointIssuesGrant(t *testing.T) {
	s, verify, calls := turnstileHarness(t, "success")
	defer verify.Close()
	hp, _, _ := ed25519.GenerateKey(rand.Reader)
	host := hex.EncodeToString(hp)
	var out struct {
		Grant SignedGrant
	}
	invoke(t, s, "POST", api+"verify", map[string]any{"turnstile": "good-token", "host": host}, 200, &out)
	if out.Grant.Grant.Provider != "turnstile" || out.Grant.Grant.Host != host || out.Grant.Signature == "" {
		t.Fatalf("bad grant from verify endpoint: %+v", out.Grant)
	}
	// The grant minted by /api/v1/verify allocates without another siteverify call.
	body := allocationBody(t, s, host)
	body["grant"] = out.Grant
	var d Descriptor
	invoke(t, s, "POST", api+"rooms", body, 200, &d)
	if *calls != 1 {
		t.Fatal("allocate re-verified the turnstile token after grant exchange")
	}
	invoke(t, s, "POST", api+"verify", map[string]any{"turnstile": "bad-token", "host": host}, 403, nil)
	invoke(t, s, "POST", api+"verify", map[string]any{"turnstile": "good-token", "host": "zz"}, 400, nil)
}

func TestVerifyEndpointRequiresTurnstile(t *testing.T) {
	c := grantTestConfig()
	c.Auth = "oauth"
	s := newServer(c)
	invoke(t, s, "POST", api+"verify", map[string]any{"turnstile": "x", "host": randomHex(32)}, 404, nil)
}

// fakeIdP serves a minimal OAuth2 token + userinfo pair.
func fakeIdP(t *testing.T) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/token":
			if e := r.ParseForm(); e != nil || r.Form.Get("client_secret") != "test-secret" || r.Form.Get("code") != "good-code" {
				w.WriteHeader(400)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "tok123"})
		case "/userinfo":
			if r.Header.Get("Authorization") != "Bearer tok123" {
				w.WriteHeader(401)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"login": "octocat"})
		default:
			w.WriteHeader(404)
		}
	}))
}

func oauthTestConfig(idp *httptest.Server, mode string) Config {
	c := grantTestConfig()
	c.Auth = mode
	c.OAuth = OAuthConfig{Provider: "github", ClientID: "test-client", ClientSecret: "test-secret", AuthorizeURL: "http://127.0.0.1:9/authorize", TokenURL: idp.URL + "/token", UserInfoURL: idp.URL + "/userinfo", NameField: "login"}
	if strings.Contains(mode, "turnstile") {
		c.TurnstileSecret = "test-turnstile-secret"
		c.TurnstileSiteKey = "test-sitekey"
		c.TurnstileHostnames = []string{"127.0.0.1"}
	}
	return c
}

func TestOAuthLoginRedirectAndCallback(t *testing.T) {
	idp := fakeIdP(t)
	defer idp.Close()
	s := newServer(oauthTestConfig(idp, "oauth"))
	hp, _, _ := ed25519.GenerateKey(rand.Reader)
	host := hex.EncodeToString(hp)

	w := rawRequest(t, s, "GET", api+"auth/oauth/login?host="+host, nil)
	if w.Code != 302 {
		t.Fatalf("login did not redirect: %d", w.Code)
	}
	location, e := url.Parse(w.Header().Get("Location"))
	if e != nil || !strings.HasPrefix(location.String(), "http://127.0.0.1:9/authorize?") {
		t.Fatalf("bad authorize redirect: %v", location)
	}
	if location.Query().Get("client_id") != "test-client" || location.Query().Get("state") == "" ||
		location.Query().Get("redirect_uri") != s.cfg.Origin+"/api/v1/auth/oauth/callback" {
		t.Fatalf("authorize parameters missing: %v", location.Query())
	}
	state := location.Query().Get("state")

	// State is single-use and expires with the pending record.
	w = rawRequest(t, s, "GET", api+"auth/oauth/callback?code=good-code&state="+state, nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"provider":"oauth:github"`) || !strings.Contains(w.Body.String(), "octocat") {
		t.Fatalf("callback did not render the grant page: %d %s", w.Code, w.Body.String())
	}
	w = rawRequest(t, s, "GET", api+"auth/oauth/callback?code=good-code&state="+state, nil)
	if w.Code != 403 {
		t.Fatal("oauth state replay accepted")
	}

	// Identity provider errors surface as the denial page.
	w = rawRequest(t, s, "GET", api+"auth/oauth/callback?error=access_denied&state="+randomHex(16), nil)
	if w.Code != 403 || !strings.Contains(w.Body.String(), "oauth_denied") {
		t.Fatal("provider denial not rendered")
	}
}

func TestOAuthTurnstileCombinedFlow(t *testing.T) {
	idp := fakeIdP(t)
	defer idp.Close()
	verify := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		if r.Form.Get("response") == "good-token" {
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "hostname": "127.0.0.1"})
		} else {
			_ = json.NewEncoder(w).Encode(map[string]any{"success": false})
		}
	}))
	defer verify.Close()
	c := oauthTestConfig(idp, "turnstile+oauth")
	c.TurnstileURL = verify.URL
	s := newServer(c)
	hp, _, _ := ed25519.GenerateKey(rand.Reader)
	host := hex.EncodeToString(hp)

	w := rawRequest(t, s, "GET", api+"auth/oauth/login?host="+host, nil)
	state := func() string {
		location, _ := url.Parse(w.Header().Get("Location"))
		return location.Query().Get("state")
	}()
	w = rawRequest(t, s, "GET", api+"auth/oauth/callback?code=good-code&state="+state, nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "test-sitekey") || !strings.Contains(w.Body.String(), `"session"`) {
		t.Fatalf("combined mode did not render the Turnstile gate: %d", w.Code)
	}

	// Extract the one-time session id from the gate page.
	var session string
	marker := `"session":"`
	if i := strings.Index(w.Body.String(), marker); i >= 0 {
		session = w.Body.String()[i+len(marker) : i+len(marker)+32]
	}
	if session == "" {
		t.Fatal("gate page carries no verify session")
	}
	var out struct {
		Grant SignedGrant
	}
	invoke(t, s, "POST", api+"verify", map[string]any{"turnstile": "good-token", "host": host, "session": session}, 200, &out)
	if out.Grant.Grant.Provider != "turnstile+oauth:github" || out.Grant.Grant.Subject != "octocat" {
		t.Fatalf("combined grant wrong: %+v", out.Grant)
	}
	// The session is single-use.
	invoke(t, s, "POST", api+"verify", map[string]any{"turnstile": "good-token", "host": host, "session": session}, 403, nil)
	// And the resulting grant allocates in combined mode.
	body := allocationBody(t, s, host)
	body["grant"] = out.Grant
	var d Descriptor
	invoke(t, s, "POST", api+"rooms", body, 200, &d)
	s.mu.Lock()
	subject := s.rooms[d.Code].quotaSubject
	s.mu.Unlock()
	if subject != "octocat" {
		t.Fatalf("combined grant lost the oauth subject: %q", subject)
	}
}

func TestOAuthDisabledWithoutConfig(t *testing.T) {
	s := newServer(grantTestConfig())
	w := rawRequest(t, s, "GET", api+"auth/oauth/login?host="+randomHex(32), nil)
	if w.Code != 404 {
		t.Fatal("oauth login available without OAUTH_CLIENT_ID")
	}
}

func TestDiscoveryAnnouncesAttestation(t *testing.T) {
	idp := fakeIdP(t)
	defer idp.Close()
	c := oauthTestConfig(idp, "turnstile+oauth")
	c.TurnstileSiteKey = "sitekey-1"
	s := newServer(c)
	var doc map[string]any
	invoke(t, s, "GET", "/.well-known/romzo", nil, 200, &doc)
	if doc["auth"] != "turnstile+oauth" || doc["turnstileSiteKey"] != "sitekey-1" ||
		doc["verify"] != api+"verify" || doc["oauthLogin"] != api+"auth/oauth/login" {
		t.Fatalf("discovery missing attestation fields: %v", doc)
	}
}
