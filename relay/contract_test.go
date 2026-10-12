package main

import (
	"crypto/ed25519"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// openapi.yaml is the single source of truth for the HTTP surface; this test
// pins the contract that matters: version, protocol identifier, and every
// endpoint path the server routes.
func TestOpenAPIDocumentCoversWireContract(t *testing.T) {
	y, e := os.ReadFile("../protocol/openapi.yaml")
	if e != nil {
		t.Fatal(e)
	}
	doc := string(y)
	if !strings.Contains(doc, "openapi: 3") {
		t.Fatal("openapi.yaml is not an OpenAPI 3 document")
	}
	if !strings.Contains(doc, "version: "+version) {
		t.Fatal("openapi.yaml does not document relay version " + version)
	}
	for _, path := range []string{
		"/.well-known/romzo",
		api + "metrics",
		api + "room-challenges",
		api + "rooms",
		api + "rooms/{code}",
		api + "rooms/{code}/confirm",
		api + "rooms/{code}/admissions",
		api + "rooms/{code}/restore",
		api + "verify",
		api + "auth/oauth/login",
		api + "auth/oauth/callback",
		wsPath,
		"/healthz",
		"/readyz",
	} {
		if !strings.Contains(doc, "\n    "+path+":") {
			t.Fatal("openapi.yaml missing endpoint path " + path)
		}
	}
	if !strings.Contains(doc, protocol) {
		t.Fatal("openapi.yaml missing protocol identifier " + protocol)
	}
}

func TestSharedVectors(t *testing.T) {
	b, e := os.ReadFile("../protocol/relay-v1-vectors.json")
	if e != nil {
		t.Fatal(e)
	}
	var v struct {
		Value              any    `json:"value"`
		Domain             string `json:"domain"`
		Canonical          string `json:"canonical"`
		Digest             string `json:"digest"`
		Password           string `json:"password"`
		Salt               string `json:"salt"`
		Iterations         int    `json:"iterations"`
		Derived            string `json:"derived"`
		HMAC               string `json:"hmac"`
		CreateProof        string `json:"createProof"`
		PublicKey          string `json:"publicKey"`
		Signature          string `json:"signature"`
		RelayVersion       string `json:"relayVersion"`
		GenericOptions     any    `json:"genericOptions"`
		GenericOptionsHash string `json:"genericOptionsHash"`
	}
	if e = decode(b, &v); e != nil {
		t.Fatal(e)
	}
	c, e := canonical(v.Value)
	if e != nil || c != v.Canonical {
		t.Fatalf("canonical mismatch: %q", c)
	}
	if hash(v.Domain, v.Value) != v.Digest {
		t.Fatal("digest mismatch")
	}
	if v.RelayVersion != version || hash("romzo/lobby-options/v1", v.GenericOptions) != v.GenericOptionsHash {
		t.Fatal("generic options vector mismatch")
	}
	salt, _ := hex.DecodeString(v.Salt)
	key, e := pbkdf2.Key(sha256.New, v.Password, salt, v.Iterations, 32)
	if e != nil || hex.EncodeToString(key) != v.Derived {
		t.Fatal("PBKDF2 mismatch")
	}
	if mac(key, v.Domain, v.Value) != v.HMAC {
		t.Fatal("HMAC mismatch")
	}
	if mac(key, "romzo/relay-create/v1", v.Value) != v.CreateProof {
		t.Fatal("creation proof mismatch")
	}
	if !verifySignature(v.PublicKey, v.Signature, v.Domain, v.Value) {
		t.Fatal("Ed25519 mismatch")
	}
}

func TestOpaqueOptionsAreBoundedCanonicalJSON(t *testing.T) {
	for _, value := range []string{`null`, `true`, `42`, `"another game"`, `[1,{"expansion":"forest"}]`, `{"players":2,"rules":{"dice":6},"lifecycle":"custom"}`} {
		if !validOptions([]byte(value)) {
			t.Fatalf("generic options rejected: %s", value)
		}
	}
	for _, value := range []string{"", "{} trailing", `{"n":1.5}`, `{"n":9007199254740992}`, `"` + strings.Repeat("x", 4095) + `"`} {
		if validOptions([]byte(value)) {
			t.Fatal("invalid or oversized options accepted")
		}
	}
	if !validOptions([]byte(`"` + strings.Repeat("x", 4094) + `"`)) {
		t.Fatal("4096-byte boundary rejected")
	}
}

func TestRomzoConfiguredLimits(t *testing.T) {
	t.Setenv("PUBLIC_ORIGIN", "http://127.0.0.1")
	t.Setenv("AUTH_SALT", strings.Repeat("ab", 32))
	t.Setenv("TICKET_KEY", strings.Repeat("cd", 32))
	t.Setenv("CREATE_AUTH", "anonymous")
	t.Setenv("BYTES_PER_SECOND", "262144")
	t.Setenv("IP_BYTES_PER_SECOND", "262144")
	t.Setenv("MAX_OPTIONS_BYTES", "4096")
	c, err := config()
	if err != nil || c.BytesPerSecond != 262144 || c.IPBytesPerSecond != 262144 || c.OptionsBytes != 4096 {
		t.Fatalf("capped demo configuration rejected: %v", err)
	}
	for _, pair := range [][2]string{{"IP_BYTES_PER_SECOND", "1"}, {"MAX_OPTIONS_BYTES", "4097"}, {"MAX_OPTIONS_BYTES", "0"}} {
		t.Run(pair[0]+pair[1], func(t *testing.T) {
			t.Setenv(pair[0], pair[1])
			if _, err := config(); err == nil {
				t.Fatal("invalid resource bound accepted")
			}
		})
	}
}

func TestGenericRoomAllocationAndConfiguredOptionsBound(t *testing.T) {
	cfg := testConfig()
	cfg.OptionsBytes = 64
	s := newServer(cfg)
	host, _, _ := ed25519.GenerateKey(rand.Reader)
	transport, _, _ := ed25519.GenerateKey(rand.Reader)
	var challenge struct{ Challenge string }
	invoke(t, s, "POST", api+"room-challenges", map[string]any{}, 200, &challenge)
	options := json.RawMessage(`{"table":"other","players":2,"rules":["custom"]}`)
	q := AllocationRequest{protocol, s.cfg.Origin, challenge.Challenge, randomHex(16), hex.EncodeToString(host), hex.EncodeToString(transport), hash("romzo/lobby-options/v1", options), randomHex(16), options}
	invoke(t, s, "POST", api+"rooms", map[string]any{"request": q, "proof": ""}, 200, nil)
	q.RequestID = randomHex(16)
	q.Options = json.RawMessage(`"` + strings.Repeat("x", 63) + `"`)
	q.ConfigHash = hash("romzo/lobby-options/v1", q.Options)
	invoke(t, s, "POST", api+"rooms", map[string]any{"request": q, "proof": ""}, 400, nil)
}

func TestConfiguredOptionsBoundAppliesToRestore(t *testing.T) {
	cfg := testConfig()
	descriptor, _, key, _, recovery := allocateTest(t, newServer(cfg))
	body := map[string]any{"signed": descriptor, "recovery": recovery, "signature": signed(key, "romzo/relay-restore/v1", recovery)}
	path := api + "rooms/" + descriptor.Descriptor.Code + "/restore"
	invoke(t, newServer(cfg), "POST", path, body, 200, nil)
	// A deployment lowering its bound cannot be bypassed with an old ticket.
	cfg.OptionsBytes = 32
	limited := newServer(cfg)
	invoke(t, limited, "POST", path, body, 403, nil)
	if len(limited.rooms) != 0 {
		t.Fatal("oversized restore allocated a room")
	}
}
