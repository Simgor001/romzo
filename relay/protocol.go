package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
)

const protocol = "romzo/v1"
const version = "1.4.0"
const grantDomain = "romzo/relay-grant/v1"
const grantTTL = 5 * time.Minute
const api = "/api/v1/"
const wsPath = "/ws"
const controlLimit = 16 * 1024
const payloadLimit = 256 * 1024
const frameLimit = 288 * 1024

func randomHex(n int) string {
	b := make([]byte, n)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b)
}
func randomCode() string {
	b := make([]byte, 10)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
	for i := range b {
		b[i] = alphabet[int(b[i])&31]
	}
	return string(b)
}
func jsonString(v string) string {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	_ = e.Encode(v)
	return strings.NewReplacer("\\u2028", "\u2028", "\\u2029", "\u2029").Replace(strings.TrimSuffix(b.String(), "\n"))
}

// Only safe integers are accepted. Ordering matches JavaScript UTF-16 keys.
func canonical(v any) (string, error) {
	switch x := v.(type) {
	case nil:
		return "null", nil
	case bool:
		return strconv.FormatBool(x), nil
	case string:
		return jsonString(x), nil
	case json.Number:
		n, e := strconv.ParseInt(string(x), 10, 64)
		if e != nil || n > 9007199254740991 || n < -9007199254740991 {
			return "", errors.New("unsafe integer")
		}
		return strconv.FormatInt(n, 10), nil
	case []any:
		a := make([]string, len(x))
		for i, v := range x {
			s, e := canonical(v)
			if e != nil {
				return "", e
			}
			a[i] = s
		}
		return "[" + strings.Join(a, ",") + "]", nil
	case map[string]any:
		ks := make([]string, 0, len(x))
		for k := range x {
			ks = append(ks, k)
		}
		sort.Slice(ks, func(i, j int) bool {
			a, b := utf16.Encode([]rune(ks[i])), utf16.Encode([]rune(ks[j]))
			for k := 0; k < len(a) && k < len(b); k++ {
				if a[k] != b[k] {
					return a[k] < b[k]
				}
			}
			return len(a) < len(b)
		})
		a := make([]string, 0, len(ks))
		for _, k := range ks {
			s, e := canonical(x[k])
			if e != nil {
				return "", e
			}
			a = append(a, jsonString(k)+":"+s)
		}
		return "{" + strings.Join(a, ",") + "}", nil
	default:
		return "", errors.New("invalid canonical value")
	}
}
func decode(data []byte, v any) error {
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	d.DisallowUnknownFields()
	if e := d.Decode(v); e != nil {
		return e
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return errors.New("trailing JSON")
	}
	return nil
}
func wire(v any) []byte {
	b, e := json.Marshal(v)
	if e != nil {
		panic(e)
	}
	return b
}
func signingBytes(domain string, v any) ([]byte, error) {
	var generic any
	if e := decode(wire(v), &generic); e != nil {
		return nil, e
	}
	s, e := canonical(generic)
	return []byte(domain + "\x00" + s), e
}
func hash(domain string, v any) string {
	b, e := signingBytes(domain, v)
	if e != nil {
		return ""
	}
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
func mac(key []byte, domain string, v any) string {
	b, e := signingBytes(domain, v)
	if e != nil {
		return ""
	}
	h := hmac.New(sha256.New, key)
	h.Write(b)
	return hex.EncodeToString(h.Sum(nil))
}
func verifySignature(key, signature, domain string, v any) bool {
	k, e := hex.DecodeString(key)
	if e != nil || len(k) != 32 {
		return false
	}
	s, e := hex.DecodeString(signature)
	if e != nil || len(s) != 64 {
		return false
	}
	b, e := signingBytes(domain, v)
	return e == nil && ed25519.Verify(k, b, s)
}

type AllocationRequest struct {
	Protocol   string          `json:"protocol"`
	Origin     string          `json:"origin"`
	Challenge  string          `json:"challenge"`
	RequestID  string          `json:"requestId"`
	Host       string          `json:"host"`
	Transport  string          `json:"transport"`
	ConfigHash string          `json:"configHash"`
	Capability string          `json:"capability"`
	Options    json.RawMessage `json:"options"`
}
type Descriptor struct {
	Protocol   string          `json:"protocol"`
	Origin     string          `json:"origin"`
	Code       string          `json:"code"`
	Instance   string          `json:"instance"`
	Host       string          `json:"host"`
	Transport  string          `json:"transport"`
	Capability string          `json:"capability"`
	ConfigHash string          `json:"configHash"`
	Options    json.RawMessage `json:"options"`
}
type SignedDescriptor struct {
	Descriptor Descriptor `json:"descriptor"`
	Signature  string     `json:"signature"`
}
type Ticket struct {
	Protocol string `json:"protocol"`
	Origin   string `json:"origin"`
	Code     string `json:"code"`
	Instance string `json:"instance"`
	Digest   string `json:"digest"`
	Key      string `json:"key"`
	Purpose  string `json:"purpose"`
	Expires  int64  `json:"expires"`
	Nonce    string `json:"nonce"`
}
type SignedTicket struct {
	Ticket    Ticket `json:"ticket"`
	Signature string `json:"signature"`
}

// Grant is the single credential the relay trusts for room creation. It is
// issued by an attestation endpoint (Turnstile verification, OAuth2 login, or
// a combination) and binds the attestation to the creator's Ed25519 host key,
// so intercepting a grant without the matching private key is useless.
type Grant struct {
	Protocol string `json:"protocol"`
	Origin   string `json:"origin"`
	// Attestation provider: "turnstile", "oauth:<name>", "turnstile+oauth:<name>".
	Provider string `json:"provider"`
	// Provider-specific identity (e.g. the OAuth login); empty for Turnstile.
	Subject string `json:"subject"`
	Host    string `json:"host"`
	Expires int64  `json:"expires"`
	Nonce   string `json:"nonce"`
}
type SignedGrant struct {
	Grant     Grant  `json:"grant"`
	Signature string `json:"signature"`
}

func (s *Server) ticket(r *Room, key, purpose string, ttl time.Duration) SignedTicket {
	t := Ticket{protocol, s.cfg.Origin, r.Signed.Descriptor.Code, r.Signed.Descriptor.Instance, hash("romzo/relay-descriptor/v1", r.Signed), key, purpose, s.now().Add(ttl).UnixMilli(), randomHex(16)}
	return SignedTicket{t, mac(s.cfg.TicketKey, "romzo/relay-ticket/v1", t)}
}
func (s *Server) validTicket(t SignedTicket, purpose string) bool {
	a, e := hex.DecodeString(t.Signature)
	if e != nil {
		return false
	}
	b, _ := hex.DecodeString(mac(s.cfg.TicketKey, "romzo/relay-ticket/v1", t.Ticket))
	return hmac.Equal(a, b) && t.Ticket.Protocol == protocol && t.Ticket.Origin == s.cfg.Origin && t.Ticket.Purpose == purpose && t.Ticket.Expires > s.now().UnixMilli()
}
func validHex(v string, n int) bool {
	b, e := hex.DecodeString(v)
	return e == nil && len(b) == n && hex.EncodeToString(b) == v
}
