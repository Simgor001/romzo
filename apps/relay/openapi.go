package main

import (
	"encoding/json"

	"github.com/getkin/kin-openapi/openapi3"
	"gopkg.in/yaml.v3"
)

// The OpenAPI document is built in code against the same wire types the server
// implements, so the contract cannot drift from protocol.go. `relay openapi`
// prints it as YAML for publishing; the test suite validates it.

func ptr[T any](v T) *T { return &v }

func schemaRef(name string) *openapi3.SchemaRef {
	return openapi3.NewSchemaRef("#/components/schemas/"+name, nil)
}
func jsonContent(s *openapi3.SchemaRef) openapi3.Content {
	return openapi3.NewContentWithSchemaRef(s, []string{"application/json"})
}
func response(description string, s *openapi3.SchemaRef) *openapi3.ResponseRef {
	return &openapi3.ResponseRef{Value: &openapi3.Response{Description: ptr(description), Content: jsonContent(s)}}
}
func requestBody(s *openapi3.SchemaRef) *openapi3.RequestBodyRef {
	return &openapi3.RequestBodyRef{Value: &openapi3.RequestBody{Required: true, Content: jsonContent(s)}}
}
func operation(summary, description string, body *openapi3.RequestBodyRef, responses map[string]*openapi3.ResponseRef) *openapi3.Operation {
	o := &openapi3.Operation{Summary: summary, Description: description, Responses: &openapi3.Responses{}}
	if body != nil {
		o.RequestBody = body
	}
	for code, r := range responses {
		o.Responses.Set(code, r)
	}
	return o
}
func stringSchema(pattern string) *openapi3.Schema {
	return &openapi3.Schema{Type: &openapi3.Types{"string"}, Pattern: pattern}
}
func intSchema(format string) *openapi3.Schema {
	return &openapi3.Schema{Type: &openapi3.Types{"integer"}, Format: format}
}
func errResponse(description string) map[string]*openapi3.ResponseRef {
	return map[string]*openapi3.ResponseRef{
		"400": response("Malformed request body.", schemaRef("Error")),
		"403": response(description, schemaRef("Error")),
		"429": response("Per-IP token bucket exhausted.", schemaRef("Error")),
	}
}

func buildSpec() *openapi3.T {
	spec := &openapi3.T{
		OpenAPI: "3.0.3",
		Info: &openapi3.Info{
			Title:       "Romzo Relay",
			Description: "Room allocation and encrypted fan-out relay for the ru-relay/v1 protocol. The server forwards client-signed envelopes verbatim; it holds no game rules, keys, or state beyond room lifecycles. All requests reject query strings; browser origins are checked against the server allowlist; every route is per-IP rate limited.",
			Version:     version,
		},
		Servers: openapi3.Servers{{URL: "/"}},
		Paths:   &openapi3.Paths{},
	}
	components := openapi3.Schemas{}

	components["Options"] = &openapi3.SchemaRef{Value: &openapi3.Schema{Description: "Opaque canonical JSON, at most MAX_OPTIONS_BYTES UTF-8 bytes (default and maximum 4096). Safe integers only; application rules are validated by clients. Any JSON root type is permitted.", Nullable: true}}
	components["AllocationRequest"] = &openapi3.SchemaRef{Value: &openapi3.Schema{
		Type:     &openapi3.Types{"object"},
		Required: []string{"protocol", "origin", "challenge", "requestId", "host", "transport", "capability", "configHash", "options"},
		Properties: openapi3.Schemas{
			"protocol":   &openapi3.SchemaRef{Value: &openapi3.Schema{Type: &openapi3.Types{"string"}, Enum: []any{protocol}}},
			"origin":     &openapi3.SchemaRef{Value: stringSchema("")},
			"challenge":  &openapi3.SchemaRef{Value: stringSchema(`^[0-9a-f]{64}$`)},
			"requestId":  &openapi3.SchemaRef{Value: stringSchema(`^[0-9a-f]{32}$`)},
			"host":       &openapi3.SchemaRef{Value: stringSchema(`^[0-9a-f]{64}$`)},
			"transport":  &openapi3.SchemaRef{Value: stringSchema(`^[0-9a-f]{64}$`)},
			"capability": &openapi3.SchemaRef{Value: stringSchema(`^[0-9a-f]{32}$`)},
			"configHash": &openapi3.SchemaRef{Value: stringSchema(`^[0-9a-f]{64}$`)},
			"options":    schemaRef("Options"),
		},
	}}
	components["Descriptor"] = &openapi3.SchemaRef{Value: &openapi3.Schema{
		Type:     &openapi3.Types{"object"},
		Required: []string{"protocol", "origin", "code", "instance", "host", "transport", "capability", "configHash", "options"},
		Properties: openapi3.Schemas{
			"protocol":   &openapi3.SchemaRef{Value: &openapi3.Schema{Type: &openapi3.Types{"string"}, Enum: []any{protocol}}},
			"origin":     &openapi3.SchemaRef{Value: stringSchema("")},
			"code":       &openapi3.SchemaRef{Value: stringSchema(`^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$`)},
			"instance":   &openapi3.SchemaRef{Value: stringSchema(`^[0-9a-f]{32}$`)},
			"host":       &openapi3.SchemaRef{Value: stringSchema(`^[0-9a-f]{64}$`)},
			"transport":  &openapi3.SchemaRef{Value: stringSchema(`^[0-9a-f]{64}$`)},
			"capability": &openapi3.SchemaRef{Value: stringSchema(`^[0-9a-f]{32}$`)},
			"configHash": &openapi3.SchemaRef{Value: stringSchema(`^[0-9a-f]{64}$`)},
			"options":    schemaRef("Options"),
		},
	}}
	components["SignedDescriptor"] = &openapi3.SchemaRef{Value: &openapi3.Schema{
		Type:       &openapi3.Types{"object"},
		Required:   []string{"descriptor", "signature"},
		Properties: openapi3.Schemas{"descriptor": schemaRef("Descriptor"), "signature": &openapi3.SchemaRef{Value: stringSchema(`^[0-9a-f]{128}$`)}},
	}}
	components["Ticket"] = &openapi3.SchemaRef{Value: &openapi3.Schema{
		Type:     &openapi3.Types{"object"},
		Required: []string{"protocol", "origin", "code", "instance", "digest", "key", "purpose", "expires", "nonce"},
		Properties: openapi3.Schemas{
			"protocol": &openapi3.SchemaRef{Value: &openapi3.Schema{Type: &openapi3.Types{"string"}, Enum: []any{protocol}}},
			"origin":   &openapi3.SchemaRef{Value: stringSchema("")},
			"code":     &openapi3.SchemaRef{Value: stringSchema(`^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$`)},
			"instance": &openapi3.SchemaRef{Value: stringSchema(`^[0-9a-f]{32}$`)},
			"digest":   &openapi3.SchemaRef{Value: stringSchema(`^[0-9a-f]{64}$`)},
			"key":      &openapi3.SchemaRef{Value: stringSchema(`^[0-9a-f]{64}$`)},
			"purpose":  &openapi3.SchemaRef{Value: &openapi3.Schema{Type: &openapi3.Types{"string"}, Enum: []any{"creator", "guest", "recovery"}}},
			"expires":  &openapi3.SchemaRef{Value: intSchema("int64")},
			"nonce":    &openapi3.SchemaRef{Value: stringSchema(`^[0-9a-f]{32}$`)},
		},
	}}
	components["SignedTicket"] = &openapi3.SchemaRef{Value: &openapi3.Schema{
		Type:       &openapi3.Types{"object"},
		Required:   []string{"ticket", "signature"},
		Properties: openapi3.Schemas{"ticket": schemaRef("Ticket"), "signature": &openapi3.SchemaRef{Value: stringSchema(`^[0-9a-f]{64}$`)}},
	}}
	components["AllocationBody"] = &openapi3.SchemaRef{Value: &openapi3.Schema{
		Type:     &openapi3.Types{"object"},
		Required: []string{"request"},
		Properties: openapi3.Schemas{
			"request":   schemaRef("AllocationRequest"),
			"proof":     &openapi3.SchemaRef{Value: stringSchema(`^[0-9a-f]{64}$`)},
			"turnstile": &openapi3.SchemaRef{Value: stringSchema("")},
		},
		Description: "proof is the HMAC over the request with the password-derived verifier and is required when the server announces auth=password; turnstile is a Cloudflare Turnstile token and is required when the server announces turnstile=true. Idempotent replays with the same requestId return the original descriptor without re-verifying either.",
	}}
	components["ChallengeResponse"] = &openapi3.SchemaRef{Value: &openapi3.Schema{
		Type:       &openapi3.Types{"object"},
		Required:   []string{"challenge", "expires"},
		Properties: openapi3.Schemas{"challenge": &openapi3.SchemaRef{Value: stringSchema(`^[0-9a-f]{64}$`)}, "expires": &openapi3.SchemaRef{Value: intSchema("int64")}},
	}}
	components["AdmissionRequest"] = &openapi3.SchemaRef{Value: &openapi3.Schema{
		Type:       &openapi3.Types{"object"},
		Required:   []string{"key"},
		Properties: openapi3.Schemas{"key": &openapi3.SchemaRef{Value: stringSchema(`^[0-9a-f]{64}$`)}},
	}}
	components["AdmissionResponse"] = &openapi3.SchemaRef{Value: &openapi3.Schema{
		Type:       &openapi3.Types{"object"},
		Required:   []string{"admission"},
		Properties: openapi3.Schemas{"admission": schemaRef("SignedTicket")},
	}}
	components["TicketPair"] = &openapi3.SchemaRef{Value: &openapi3.Schema{
		Type:       &openapi3.Types{"object"},
		Required:   []string{"admission", "recovery"},
		Properties: openapi3.Schemas{"admission": schemaRef("SignedTicket"), "recovery": schemaRef("SignedTicket")},
	}}
	components["RestoreBody"] = &openapi3.SchemaRef{Value: &openapi3.Schema{
		Type:     &openapi3.Types{"object"},
		Required: []string{"signed", "recovery", "signature"},
		Properties: openapi3.Schemas{
			"signed":    schemaRef("SignedDescriptor"),
			"recovery":  schemaRef("SignedTicket"),
			"signature": &openapi3.SchemaRef{Value: stringSchema(`^[0-9a-f]{128}$`)},
		},
	}}
	components["Metrics"] = &openapi3.SchemaRef{Value: &openapi3.Schema{
		Type: &openapi3.Types{"object"},
		Properties: openapi3.Schemas{
			"rooms":           &openapi3.SchemaRef{Value: intSchema("int32")},
			"connections":     &openapi3.SchemaRef{Value: intSchema("int32")},
			"unauthenticated": &openapi3.SchemaRef{Value: intSchema("int32")},
			"queueBytes":      &openapi3.SchemaRef{Value: intSchema("int64")},
			"receivedFrames":  &openapi3.SchemaRef{Value: intSchema("int64")},
			"receivedBytes":   &openapi3.SchemaRef{Value: intSchema("int64")},
			"sentFrames":      &openapi3.SchemaRef{Value: intSchema("int64")},
			"sentBytes":       &openapi3.SchemaRef{Value: intSchema("int64")},
			"queueRejected":   &openapi3.SchemaRef{Value: intSchema("int64")},
			"closedReasons":   &openapi3.SchemaRef{Value: &openapi3.Schema{Type: &openapi3.Types{"object"}, AdditionalProperties: openapi3.AdditionalProperties{Schema: &openapi3.SchemaRef{Value: intSchema("int64")}}}},
		},
	}}
	components["Discovery"] = &openapi3.SchemaRef{Value: &openapi3.Schema{
		Type:     &openapi3.Types{"object"},
		Required: []string{"protocol", "version", "origin", "auth", "salt", "iterations", "algorithm", "turnstile", "limits"},
		Properties: openapi3.Schemas{
			"protocol":   &openapi3.SchemaRef{Value: &openapi3.Schema{Type: &openapi3.Types{"string"}, Enum: []any{protocol}}},
			"version":    &openapi3.SchemaRef{Value: stringSchema("")},
			"origin":     &openapi3.SchemaRef{Value: stringSchema("")},
			"auth":       &openapi3.SchemaRef{Value: &openapi3.Schema{Type: &openapi3.Types{"string"}, Enum: []any{"password", "anonymous", "off"}}},
			"salt":       &openapi3.SchemaRef{Value: stringSchema(`^[0-9a-f]{64}$`)},
			"iterations": &openapi3.SchemaRef{Value: intSchema("int32")},
			"algorithm":  &openapi3.SchemaRef{Value: &openapi3.Schema{Type: &openapi3.Types{"string"}, Enum: []any{"PBKDF2-HMAC-SHA256"}}},
			"turnstile":  &openapi3.SchemaRef{Value: &openapi3.Schema{Type: &openapi3.Types{"boolean"}}},
			"limits":     &openapi3.SchemaRef{Value: &openapi3.Schema{Type: &openapi3.Types{"object"}, Required: []string{"framesPerSecond", "bytesPerSecond"}, Properties: openapi3.Schemas{"framesPerSecond": &openapi3.SchemaRef{Value: intSchema("int32")}, "bytesPerSecond": &openapi3.SchemaRef{Value: intSchema("int32")}}}},
		},
	}}
	components["Ready"] = &openapi3.SchemaRef{Value: &openapi3.Schema{
		Type:       &openapi3.Types{"object"},
		Required:   []string{"ready"},
		Properties: openapi3.Schemas{"ready": &openapi3.SchemaRef{Value: &openapi3.Schema{Type: &openapi3.Types{"boolean"}}}},
	}}
	components["Error"] = &openapi3.SchemaRef{Value: &openapi3.Schema{
		Type:       &openapi3.Types{"object"},
		Required:   []string{"error"},
		Properties: openapi3.Schemas{"error": &openapi3.SchemaRef{Value: stringSchema("")}},
	}}
	spec.Components = &openapi3.Components{Schemas: components}

	for _, probe := range []string{"/healthz", "/readyz"} {
		spec.Paths.Set(probe, &openapi3.PathItem{Get: operation("Liveness/readiness probe", "Returns 200 while the process serves requests. Unauthenticated and unrate-limited.", nil, map[string]*openapi3.ResponseRef{"200": response("Service is up.", schemaRef("Ready"))})})
	}
	spec.Paths.Set("/.well-known/relic-undertow", &openapi3.PathItem{Get: operation("Relay discovery document", "Public parameters a client needs before allocating a room: PBKDF2 salt for password-derived proofs, whether creation requires a password proof and/or a Cloudflare Turnstile token, and relay rate limits.", nil, map[string]*openapi3.ResponseRef{"200": response("Discovery document.", schemaRef("Discovery"))})})
	spec.Paths.Set(api+"metrics", &openapi3.PathItem{Get: operation("Operational metrics", "Snapshot of rooms, connections, queue pressure, frame counters, and close reasons. Intended for the deployer; unauthenticated on the relay port.", nil, map[string]*openapi3.ResponseRef{"200": response("Metrics snapshot.", schemaRef("Metrics"))})})
	spec.Paths.Set(api+"room-challenges", &openapi3.PathItem{Post: operation("Mint a single-use creation challenge", "Every room allocation must reference a fresh challenge, consumed by the allocation attempt (including failed password proofs). Challenges expire after 30 seconds.", requestBody(&openapi3.SchemaRef{Value: &openapi3.Schema{Type: &openapi3.Types{"object"}}}), map[string]*openapi3.ResponseRef{
		"200": response("Fresh challenge.", schemaRef("ChallengeResponse")),
		"503": response("Challenge store full.", schemaRef("Error")),
		"429": response("Per-IP token bucket exhausted.", schemaRef("Error")),
	})})

	roomsResponses := errResponse("Origin not allowlisted, Turnstile token missing or rejected.")
	roomsResponses["200"] = response("Room descriptor for the new reservation; identical replays of the same requestId return the same descriptor.", schemaRef("Descriptor"))
	roomsResponses["401"] = response("Challenge missing/expired or password proof rejected.", schemaRef("Error"))
	roomsResponses["409"] = response("requestId already used with a different request.", schemaRef("Error"))
	roomsResponses["503"] = response("Room capacity reached.", schemaRef("Error"))
	spec.Paths.Set(api+"rooms", &openapi3.PathItem{Post: operation("Allocate a room", "Creates an unconfirmed room reservation. Optionally enforces a Cloudflare Turnstile token and/or a password proof, both checked only at this step; the reservation itself must be confirmed by the host via the confirm endpoint before peers can join.", requestBody(schemaRef("AllocationBody")), roomsResponses)})

	codeParam := openapi3.Parameters{&openapi3.ParameterRef{Value: &openapi3.Parameter{Name: "code", In: "path", Required: true, Schema: &openapi3.SchemaRef{Value: stringSchema(`^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}`)}}}}
	spec.Paths.Set(api+"rooms/{code}", &openapi3.PathItem{Get: &openapi3.Operation{
		Summary:    "Fetch the confirmed room descriptor",
		Responses:  &openapi3.Responses{},
		Parameters: codeParam,
	}})
	roomItem := spec.Paths.Find(api + "rooms/{code}")
	roomItem.Get.Responses.Set("200", response("Signed descriptor as confirmed by the host.", schemaRef("SignedDescriptor")))
	roomItem.Get.Responses.Set("404", response("Unknown or unconfirmed room.", schemaRef("Error")))

	spec.Paths.Set(api+"rooms/{code}/confirm", &openapi3.PathItem{Post: &openapi3.Operation{
		Summary:     "Confirm a reservation and receive tickets",
		Description: "The host posts the descriptor signed with its Ed25519 host key, proving control of the room identity. Returns a short-lived admission ticket for the WebSocket handshake and a recovery ticket bound to the current lease.",
		RequestBody: requestBody(schemaRef("SignedDescriptor")),
		Parameters:  codeParam,
		Responses:   &openapi3.Responses{},
	}})
	confirmItem := spec.Paths.Find(api + "rooms/{code}/confirm")
	confirmItem.Post.Responses.Set("200", response("Admission and recovery tickets.", schemaRef("TicketPair")))
	confirmItem.Post.Responses.Set("403", response("Descriptor mismatch or invalid host signature.", schemaRef("Error")))
	confirmItem.Post.Responses.Set("410", response("Reservation or lease expired.", schemaRef("Error")))
	confirmItem.Post.Responses.Set("429", response("Per-IP token bucket exhausted.", schemaRef("Error")))

	spec.Paths.Set(api+"rooms/{code}/admissions", &openapi3.PathItem{Post: &openapi3.Operation{
		Summary:     "Mint a guest admission ticket",
		Description: "Anyone holding a confirmed room code can mint a 60-second admission ticket for a peer Ed25519 public key; possession of the private key is proven inside the WebSocket handshake.",
		RequestBody: requestBody(schemaRef("AdmissionRequest")),
		Parameters:  codeParam,
		Responses:   &openapi3.Responses{},
	}})
	admissionsItem := spec.Paths.Find(api + "rooms/{code}/admissions")
	admissionsItem.Post.Responses.Set("200", response("Guest admission ticket.", schemaRef("AdmissionResponse")))
	admissionsItem.Post.Responses.Set("400", response("Malformed key.", schemaRef("Error")))
	admissionsItem.Post.Responses.Set("404", response("Unknown or unconfirmed room.", schemaRef("Error")))
	admissionsItem.Post.Responses.Set("429", response("Per-IP token bucket exhausted.", schemaRef("Error")))

	spec.Paths.Set(api+"rooms/{code}/restore", &openapi3.PathItem{Post: &openapi3.Operation{
		Summary:     "Restore a room after relay restart",
		Description: "Reinstates the room instance bound to an unexpired recovery ticket signed by the ticket key holder. Replays cannot extend the original lease.",
		RequestBody: requestBody(schemaRef("RestoreBody")),
		Parameters:  codeParam,
		Responses:   &openapi3.Responses{},
	}})
	restoreItem := spec.Paths.Find(api + "rooms/{code}/restore")
	restoreItem.Post.Responses.Set("200", response("Fresh admission ticket.", schemaRef("AdmissionResponse")))
	restoreItem.Post.Responses.Set("403", response("Recovery ticket, digest, or signature invalid.", schemaRef("Error")))
	restoreItem.Post.Responses.Set("409", response("Room identity conflict.", schemaRef("Error")))
	restoreItem.Post.Responses.Set("503", response("Room capacity reached.", schemaRef("Error")))
	restoreItem.Post.Responses.Set("429", response("Per-IP token bucket exhausted.", schemaRef("Error")))

	spec.Paths.Set(api+"ws", &openapi3.PathItem{Get: &openapi3.Operation{
		Summary:     "WebSocket relay endpoint",
		Description: "Upgrades to a WebSocket carrying ru-relay/v1 text frames. The handshake is authenticate (admission ticket) then proof (Ed25519 signature over the server challenge). Authenticated frames are subscribe, unsubscribe, send, and keepalive on the channels discovery, lobby, and game; the relay only routes envelopes and never inspects payload contents. This document describes the HTTP surface; frame-level semantics live in the protocol vectors.",
		Responses:   &openapi3.Responses{},
	}})
	wsItem := spec.Paths.Find(api + "ws")
	wsItem.Get.Responses.Set("503", response("Connection capacity reached.", schemaRef("Error")))

	return spec
}

func openapiYAML() ([]byte, error) {
	j, e := json.Marshal(buildSpec())
	if e != nil {
		return nil, e
	}
	var doc map[string]any
	if e = json.Unmarshal(j, &doc); e != nil {
		return nil, e
	}
	return yaml.Marshal(doc)
}
