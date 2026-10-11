package main

import (
	"bytes"
	"os"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"
)

func TestOpenAPIDocumentValidAndComplete(t *testing.T) {
	y, e := openapiYAML()
	if e != nil {
		t.Fatal(e)
	}
	saved, e := os.ReadFile("openapi.yaml")
	if e != nil || !bytes.Equal(bytes.TrimSpace(bytes.ReplaceAll(saved, []byte("\r\n"), []byte("\n"))), bytes.TrimSpace(y)) {
		t.Fatal("openapi.yaml is stale; regenerate with relay openapi")
	}
	loader := openapi3.NewLoader()
	doc, e := loader.LoadFromData(y)
	if e != nil {
		t.Fatal(e)
	}
	if e := doc.Validate(loader.Context); e != nil {
		t.Fatal(e)
	}
	if doc.Info.Version != version || len(doc.Components.Schemas["Options"].Value.Properties) != 0 {
		t.Fatal("release version or opaque options schema drifted")
	}
	for _, p := range []string{
		"/healthz",
		"/readyz",
		"/.well-known/relic-undertow",
		api + "metrics",
		api + "room-challenges",
		api + "rooms",
		api + "rooms/{code}",
		api + "rooms/{code}/confirm",
		api + "rooms/{code}/admissions",
		api + "rooms/{code}/restore",
		api + "ws",
	} {
		if doc.Paths.Find(p) == nil {
			t.Fatal("spec missing path " + p)
		}
	}
	for _, s := range []string{
		"Options", "AllocationRequest", "AllocationBody", "Descriptor", "SignedDescriptor",
		"Ticket", "SignedTicket", "ChallengeResponse", "AdmissionRequest", "AdmissionResponse",
		"TicketPair", "RestoreBody", "Metrics", "Discovery", "Ready", "Error",
	} {
		if doc.Components.Schemas[s] == nil {
			t.Fatal("spec missing schema " + s)
		}
	}
	post := doc.Paths.Find(api + "rooms").Post
	if post.RequestBody.Value.Content.Get("application/json").Schema.Ref != "#/components/schemas/AllocationBody" {
		t.Fatal("rooms request body not bound to AllocationBody")
	}
	if _, ok := post.Responses.Map()["403"]; !ok {
		t.Fatal("rooms turnstile/authz denial not documented")
	}
}
