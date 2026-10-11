# Architecture

中文：[architecture_zh.md](architecture_zh.md)

Romzo has two components: a Go relay service and a TypeScript client SDK.
The service manages rooms, signed admission/recovery tickets and WebSocket
channel membership. It forwards application JSON without interpreting game
rules. The SDK implements the matching HTTP flow, cryptographic contracts and
authenticated socket session.

## Room lifecycle

1. Discover the relay's canonical origin, authentication policy and limits.
2. Obtain a creation challenge, allocate a room and confirm its host-signed
   descriptor. Allocation retries reuse the same request body and request ID.
3. Guests verify the descriptor, configuration hash and host signature before
   obtaining admission. Applications supply their own options validator.
4. Authenticate the socket through authenticate → challenge → proof →
   authenticated, then subscribe to discovery, lobby or game channels.
5. Keepalive renews recovery tickets. After a disconnect or server restart,
   restore the room, reconnect, resubscribe and synchronize application state.

Rooms and messages are held in memory. A send acknowledgment covers relay
acceptance only and says nothing about whether recipients applied it. Delivery is at most once.
Applications own encryption, persistence, sequencing, retries, deduplication
and reconnection policy. SDK-generated private keys are extractable so an
application can export them for recovery; protecting them at rest is up to the application.

## Boundaries

- Options are opaque canonical JSON, including any JSON root type, subject to
  a configurable maximum of 4096 UTF-8 bytes. Numbers must be safe integers.
- Creation passwords and optional Turnstile validation protect allocation;
  they are independent policies. Guests join through room capabilities and
  signed tickets. Origin checks do not establish user identity.
- Frame, queue, connection and per-IP ingress limits bound individual resource
  usage; outbound fanout bandwidth lies outside these limits.
- TLS terminates at the deployment proxy. Only explicitly trusted proxy CIDRs
  may supply client IPs, and allowed client origins are exact matches.
- Recovery on multiple servers also requires shared ticket keys, a common
  origin and coordinated room routing; multi-instance consistency and failover
  require more than recovery tickets.

## Compatibility and verification

Server release 1.2.0 and SDK 0.2.0 implement public protocol `romzo/v1`,
with `/api/v1/` HTTP routes, `/ws` for WebSocket and `/.well-known/romzo`
for discovery. Cryptographic domains use the `romzo/` prefix. Clients and
servers must agree on the protocol; tickets and signatures from other
protocols cannot be reused. Shared fixtures verify canonical
encoding and cryptographic outputs in Go and TypeScript; `openapi.yaml` is the
single source of truth for the HTTP surface, with a contract test validating
endpoint coverage.

`npm run verify` runs SDK and Go tests, race checks, the publication boundary
checks and a real local integration through two SDK clients, including ticket
renewal and server restart recovery. This provides local HTTP/WS evidence;
public WSS and multi-instance deployment need separate acceptance tests.
