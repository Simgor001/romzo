# Architecture

中文：[architecture_zh.md](architecture_zh.md)

Romzo has two components: a Go relay service and a TypeScript client SDK.
The service manages rooms, signed admission/recovery tickets and WebSocket channel membership.
It forwards application JSON without interpreting it.
The SDK implements the matching HTTP flow, cryptographic contracts and authenticated socket session.

## Room lifecycle

1. Discover the relay's canonical origin, authentication policy and limits.
2. Obtain a creation challenge, allocate a room and confirm its host-signed descriptor.
   Allocation retries reuse the same request body and request ID.
3. Guests verify the descriptor, configuration hash and host signature before obtaining admission.
   Applications supply their own options validator.
4. Authenticate the socket through authenticate → challenge → proof → authenticated.
   Then subscribe to channels declared in the room options (no predefined channels).
5. Keepalive renews recovery tickets.
   After a disconnect or server restart, restore the room, reconnect, resubscribe and synchronize application state.

Rooms and messages are held in memory.
A send acknowledgment covers relay acceptance only and says nothing about whether recipients applied it.
Delivery is at most once.
Applications own encryption, persistence, sequencing, retries, deduplication and reconnection policy.
SDK-generated private keys are extractable so an application can export them for recovery; protecting them at rest is up to the application.

`romzo/v1` also defines two optional extensions: stable member order persists a per-key `joinSeq` (1..4096) through `MEMBER_STATE_FILE` so membership order survives recovery into the same room instance, and persistent-identity rooms use signed `identityPolicy: {exclusive, ttlMs}` options to allow one live connection per public key.

## Boundaries

- Options are opaque canonical JSON, including any JSON root type, subject to a configurable maximum of 4096 UTF-8 bytes.
  Numbers must be safe integers.
- Allocation policy is selected by CREATE_AUTH: anonymous, a creation password, or attestation via Turnstile and/or OAuth, accepted as a signed grant from the verifying provider.
  Guests join through room capabilities and signed tickets.
  Origin checks do not establish user identity.
- Frame, queue, connection and per-IP ingress limits bound individual resource usage; outbound fanout bandwidth lies outside these limits.
- TLS terminates at the deployment proxy.
  Only explicitly trusted proxy CIDRs may supply client IPs, and allowed client origins are exact matches.
- Recovery on multiple servers also requires shared ticket keys, a common origin and coordinated room routing.
  Multi-instance consistency and failover require more than recovery tickets.

## Compatibility and verification

Server release 1.5.0 and SDK 0.4.0 implement public protocol `romzo/v1`, with `/api/v1/` HTTP routes, `/ws` for WebSocket and `/.well-known/romzo` for discovery.
Cryptographic domains use the `romzo/` prefix.
Clients and servers must agree on the protocol; tickets and signatures from other protocols cannot be reused.
Shared fixtures verify canonical encoding and cryptographic outputs in Go and TypeScript.
`openapi.yaml` is the single source of truth for the HTTP surface, with a contract test validating endpoint coverage.

`npm run verify` runs SDK and Go tests, race checks, the publication boundary checks and a real local integration through two SDK clients, including ticket renewal and server restart recovery.
Mesh-consumer, persistent-identity and mobile-browser suites, protocol vector checks (`generate-vectors --check`), a relay build and release artifact checks complete the pipeline.
The integration covers local HTTP/WS only; public WSS and multi-instance deployment need separate acceptance tests.
