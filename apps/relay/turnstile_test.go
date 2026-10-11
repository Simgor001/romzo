package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func turnstileHarness(t *testing.T, behavior string) (*Server, *httptest.Server, *int) {
	t.Helper()
	calls := 0
	verify := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if e := r.ParseForm(); e != nil {
			t.Error(e)
			return
		}
		if r.Form.Get("secret") != "test-turnstile-secret" {
			t.Error("siteverify secret mismatch")
		}
		if r.Form.Get("remoteip") == "" {
			t.Error("siteverify remoteip missing")
		}
		switch behavior {
		case "http500":
			w.WriteHeader(http.StatusInternalServerError)
		default:
			if r.Form.Get("response") == "good-token" {
				_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
			} else {
				_ = json.NewEncoder(w).Encode(map[string]any{"success": false, "error-codes": []string{"invalid-input-response"}})
			}
		}
	}))
	cfg := testConfig()
	cfg.TurnstileSecret = "test-turnstile-secret"
	cfg.TurnstileURL = verify.URL
	return newServer(cfg), verify, &calls
}

func allocateWithToken(t *testing.T, s *Server, token string, status int) Descriptor {
	t.Helper()
	hp, _, _ := ed25519.GenerateKey(rand.Reader)
	tp, _, _ := ed25519.GenerateKey(rand.Reader)
	var c struct{ Challenge string }
	invoke(t, s, "POST", api+"room-challenges", map[string]any{}, 200, &c)
	options := json.RawMessage(`{"players":4,"identityMode":"mixed","factionCounts":null,"threshold":11}`)
	q := AllocationRequest{protocol, s.cfg.Origin, c.Challenge, randomHex(16), hex.EncodeToString(hp), hex.EncodeToString(tp), hash("ru/lobby-options/v1", options), randomHex(16), options}
	var d Descriptor
	invoke(t, s, "POST", api+"rooms", map[string]any{"request": q, "turnstile": token}, status, &d)
	return d
}

func TestTurnstileEnforcedOnlyAtAllocation(t *testing.T) {
	s, verify, calls := turnstileHarness(t, "success")
	defer verify.Close()
	allocateWithToken(t, s, "", 403)          // turnstile_required
	allocateWithToken(t, s, "bad-token", 403) // turnstile_failed; challenge stays unconsumed
	if *calls != 1 {
		t.Fatal("missing or rejected token must not skip verification")
	}
	hostPub, hostPriv, _ := ed25519.GenerateKey(rand.Reader)
	tp, tpPriv, _ := ed25519.GenerateKey(rand.Reader)
	var c struct{ Challenge string }
	invoke(t, s, "POST", api+"room-challenges", map[string]any{}, 200, &c)
	options := json.RawMessage(`{"players":4,"identityMode":"mixed","factionCounts":null,"threshold":11}`)
	q := AllocationRequest{protocol, s.cfg.Origin, c.Challenge, randomHex(16), hex.EncodeToString(hostPub), hex.EncodeToString(tp), hash("ru/lobby-options/v1", options), randomHex(16), options}
	body := map[string]any{"request": q, "turnstile": "good-token"}
	var d Descriptor
	invoke(t, s, "POST", api+"rooms", body, 200, &d)
	// Idempotent replay with the same requestId returns the descriptor without
	// re-verifying the (already spent) token.
	var again Descriptor
	invoke(t, s, "POST", api+"rooms", body, 200, &again)
	if d.Code != again.Code || *calls != 2 {
		t.Fatal("replay re-verified or changed room")
	}
	// Join and restore paths never ask for Turnstile.
	sdesc := SignedDescriptor{d, signed(hostPriv, "ru/relay-descriptor/v1", d)}
	var tickets struct {
		Admission SignedTicket
		Recovery  SignedTicket
	}
	invoke(t, s, "POST", api+"rooms/"+d.Code+"/confirm", sdesc, 200, &tickets)
	_, guest, _ := ed25519.GenerateKey(rand.Reader)
	invoke(t, s, "POST", api+"rooms/"+d.Code+"/admissions", map[string]string{"key": hex.EncodeToString(guest.Public().(ed25519.PublicKey))}, 200, nil)
	fresh := newServer(s.cfg)
	invoke(t, fresh, "POST", api+"rooms/"+d.Code+"/restore", map[string]any{"signed": sdesc, "recovery": tickets.Recovery, "signature": signed(tpPriv, "ru/relay-restore/v1", tickets.Recovery)}, 200, nil)
	if *calls != 2 {
		t.Fatal("non-allocation endpoint triggered verification")
	}
	var discovery struct {
		Turnstile bool   `json:"turnstile"`
		Version   string `json:"version"`
	}
	invoke(t, s, "GET", "/.well-known/relic-undertow", nil, 200, &discovery)
	if !discovery.Turnstile {
		t.Fatal("discovery does not announce turnstile")
	}
	if discovery.Version != version {
		t.Fatal("discovery does not report relay version")
	}
}

func TestTurnstileFailClosedWhenVerifierDown(t *testing.T) {
	s, verify, _ := turnstileHarness(t, "http500")
	defer verify.Close()
	allocateWithToken(t, s, "good-token", 503)
}

func TestCreateAuthOffAndTurnstileConfig(t *testing.T) {
	t.Setenv("PUBLIC_ORIGIN", "http://127.0.0.1")
	t.Setenv("AUTH_SALT", strings.Repeat("ab", 32))
	t.Setenv("TICKET_KEY", strings.Repeat("cd", 32))
	t.Setenv("CREATE_AUTH", "off")
	c, e := config()
	if e != nil || c.Auth != "off" {
		t.Fatal("CREATE_AUTH=off rejected")
	}
	if len(c.Verifier) != 0 {
		t.Fatal("off mode derived a password verifier")
	}
	s := newServer(c)
	if _, ok := s.auth.(anonymousAuthorizer); !ok {
		t.Fatal("off mode installed a password authorizer")
	}
	t.Setenv("TURNSTILE_SECRET", "test-only-turnstile-secret")
	t.Setenv("TURNSTILE_VERIFY_URL", "://malformed")
	if _, e := config(); e == nil {
		t.Fatal("malformed TURNSTILE_VERIFY_URL accepted")
	}
	t.Setenv("TURNSTILE_VERIFY_URL", "")
	c, e = config()
	if e != nil || c.TurnstileURL != "https://challenges.cloudflare.com/turnstile/v0/siteverify" {
		t.Fatal("default siteverify URL not applied")
	}
}
