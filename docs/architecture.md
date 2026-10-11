# Architecture

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

Rooms and messages are held in memory. A send acknowledgment means the relay
accepted a request, not that recipients applied it. Delivery is at most once.
Applications own encryption, persistence, sequencing, retries, deduplication
and reconnection policy. SDK-generated private keys are extractable so an
application can export them for recovery; storage protection is its responsibility.

## Boundaries

- Options are opaque canonical JSON, including any JSON root type, subject to
  a configurable maximum of 4096 UTF-8 bytes. Numbers must be safe integers.
- Creation passwords and optional Turnstile validation protect allocation;
  they are independent policies. Guests join through room capabilities and
  signed tickets. Origin checks do not establish user identity.
- Frame, queue, connection and per-IP ingress limits bound individual resource
  usage. They do not provide an outbound fanout bandwidth budget.
- TLS terminates at the deployment proxy. Only explicitly trusted proxy CIDRs
  may supply client IPs, and allowed client origins are exact matches.
- Recovery on multiple servers also requires shared ticket keys, a common
  origin and coordinated room routing. Recovery tickets alone do not establish
  multi-instance consistency or failover.

## Compatibility and verification

Server release 1.2.0 and SDK 0.1.0 retain the `ru-relay/v1` identifier,
`/_relic/v1` paths and signature domains. Shared fixtures verify canonical
encoding and cryptographic outputs in Go and TypeScript; OpenAPI is generated
from the service's wire types and checked against its saved artifact.

`npm run verify` runs SDK and Go tests, race checks, the publication boundary
checks and a real local integration through two SDK clients, including ticket
renewal and server restart recovery. This provides local HTTP/WS evidence;
public WSS and multi-instance deployment need separate acceptance tests.
