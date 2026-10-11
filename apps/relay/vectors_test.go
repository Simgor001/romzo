package main

import (
	"crypto/pbkdf2"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"testing"
)

func TestSharedVectors(t *testing.T) {
	b, e := os.ReadFile("../../protocol/relay-v1-vectors.json")
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
	if v.RelayVersion != version || hash("ru/lobby-options/v1", v.GenericOptions) != v.GenericOptionsHash {
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
	if mac(key, "ru/relay-create/v1", v.Value) != v.CreateProof {
		t.Fatal("creation proof mismatch")
	}
	if !verifySignature(v.PublicKey, v.Signature, v.Domain, v.Value) {
		t.Fatal("Ed25519 mismatch")
	}
}
