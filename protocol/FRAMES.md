# romzo/v1 WebSocket frame protocol

中文：[FRAMES_zh.md](FRAMES_zh.md)

This document is the specification of the `relay` WebSocket surface; it complements the OpenAPI document (`openapi.yaml`) for the HTTP surface.
Third-party client implementations can follow this document and the shared test vectors (`protocol/relay-v1-vectors.json`) alone.

Server release is **1.5.0**; the public wire protocol is **romzo/v1**.
HTTP routes use `/api/v1/`, WebSocket uses `/ws`, and cryptographic domains use the `romzo/` prefix.
Clients and servers must use the same protocol.
Channels are declared by applications in `options.channels`; the relay has no predefined channel names.

## Invite links and room configuration

The standard invite is `https://<client-origin>/#<10-char Crockford room code>@<relay-host[:port]>`, e.g. `https://game.example.com/#ABCD123XYZ@romzo.net`.

- Room codes are uppercase, without separators.
- Production relays imply HTTPS.
- An omitted port means the default HTTPS port **443** (relay behind a reverse proxy); a directly listened relay such as `:9224` must be written explicitly.
- Local loopback development should always write its port explicitly.

### LAN invitations

Three forms extend the host position; the room code is unchanged and all forms stay pure fragment data:

- `#<code>/lan` — discovery form: no host. The room code is the rendezvous key on the local network; the application locates the host by its own means (e.g. a Node host announcing over multicast).
- `#<code>/<host1,host2:port>` — direct form: one to eight private LAN candidates sharing a single explicit port, tried in order.
- `#<code>/<private-host:port>` — a single private literal auto-detects as the direct form with one candidate.

Candidates must be private literals (`10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `100.64/10`, `fc00::/7`, `fe80::/10`, or a `*.local` name). Private literals are never relay origins; public IP literals keep the relay-origin meaning. Loopback stays a relay origin (HTTP only by explicit opt-in), never a LAN host. The bare keyword `lan` is the discovery form; `lan` written with an explicit port reads as a hostname.

The fragment never enters the HTTP request.
The client parses it, clears it via `history.replaceState`, and keeps the state needed for reloads and history navigation itself.
Passwords, private keys and recovery tickets never enter an invite.
The SDK functions `buildInviteLink` / `parseInviteHash` are pure and do not touch browser history.

Only explicitly enabled local development may use an HTTP loopback relay (localhost, 127.0.0.1, [::1]).
Production pages must not interpret a scheme-less invite as remote HTTP.
Applications handle legacy invite compatibility, development address overrides and browser-history recovery; the SDK pure functions cover only the standard invite format.

The descriptor `options` are opaque canonical JSON, allowing any JSON root type.
The UTF-8 raw JSON cap is `MAX_OPTIONS_BYTES`, default and maximum 4096 bytes.
The frozen canonical protocol allows only safe integers — no decimals, no numbers outside the JavaScript safe-integer range.
The server checks configHash but does not interpret players, factions, scoring or lifecycle; the application must validate its own rules before requesting admission.

## Channels

The room's channel set is declared in the allocation `options` under `"channels"`, as up to 8 entries of `{"name": "table", "maxFrameBytes": 262144}`:

- `name` matches `^[a-z][a-z0-9-]{0,31}$`; entries must not repeat.
- `maxFrameBytes` is the per-channel `send` payload limit, between 256 and 262144 (256 KiB) bytes inclusive.
- A malformed declaration — bad name, duplicate, more than 8 entries, or an out-of-range limit — fails allocation with `invalid_allocation`.

Omitting `channels` creates a room with no channels.
An empty array explicitly declares no channels; `channels: null` is invalid.
Subscribing to any undeclared name fails with `invalid_channel`.
Restoration uses the same signed declaration and never inserts defaults.

The relay does not interpret channel semantics: it validates only name syntax and numeric bounds.
Because the declaration lives in `options`, `configHash` binds every peer of the room to the same channel set.
Sending is checked against the channel's declared `maxFrameBytes`; the global 256 KiB payload limit remains the absolute upper bound.

## Connection and transport

- Endpoint: `GET /ws`, WebSocket text frames, **binary frames not supported**.
- Every frame is a single JSON object with a `"v": "romzo/v1"` version field.
- Private deployments require an exact `CLIENT_ORIGINS` match. `CLIENT_ORIGINS=*` permits arbitrary HTTP(S) browser origins and non-browser clients without Origin; opaque `null` origins are rejected. Management HTTP endpoints use the separate exact `ADMIN_ORIGINS` list and Bearer authentication. Each IP has an independent token-bucket rate limit.
- Authentication must complete within **5 seconds** of connect, or the connection is dropped (no error frame).
- After authentication, any valid frame must arrive within **45 seconds**, or the connection is dropped (a `keepalive` suffices).
- Per-frame cap 288 KiB; slow writes are dropped after 5 seconds.

## Handshake (four frames)

```
client → {"v","kind":"authenticate","admission": <SignedTicket>}
server → {"v","kind":"challenge","value": {"protocol","origin","ticket": <ticket hash>,"challenge": <64 hex>}}
client → {"v","kind":"proof","signature": <Ed25519 signature, 128 hex>}
server → {"v","kind":"authenticated","id": <16 hex peer id>}
```

- The `admission` ticket is issued by `POST /rooms` (host), `/rooms/{code}/confirm`, `/rooms/{code}/admissions` (guest) or `/restore`; it is valid for 60 seconds and void after a single handshake.
- `proof` signs the challenge object with the Ed25519 private key matching the ticket's `key` (domain-separation string `romzo/relay-connect/v1`, see vectors).
- Handshake failure always drops the connection with **no error frame** (no feedback for enumeration attackers).

## Client frames after authentication

Common fields: `id` is a required non-empty response-correlation ID of ≤64 characters; a `send` frame may carry `target` (a peer id string).

| kind | fields | semantics |
|---|---|---|
| `subscribe` | `channel` | Subscribe to a channel declared in the room options (no channels exist if options declare none). On success you receive `join` for existing channel members and broadcast `join` to them |
| `unsubscribe` | `channel` | Unsubscribe; broadcasts `leave` to other channel members |
| `send` | `channel`, `value`, `target?` | Forward `value` (any JSON) to channel members; `target` defaults to broadcast and must be another peer subscribed to that channel. `value` must be non-empty and within the channel's declared `maxFrameBytes` (see Channels) |
| `keepalive` | — | Renew room liveness (requires an active subscription); the response carries a new recovery ticket |

## Server frames

| kind | semantics |
|---|---|
| `ack` | Response to each `subscribe`/`unsubscribe`/`send`/`keepalive`, echoing `id`; the `keepalive` response also carries `recovery` (a signed recovery ticket) |
| `error` | Application-level error without closing (currently only `invalid_target`: `send` target is missing/self/not subscribed to the channel) |
| `error` (terminal) | Protocol violation; **the connection is closed after this frame**, see table below |
| `join` / `leave` | Channel membership change, with `channel`, `peer` (id), `key` (that peer's Ed25519 public key, for end-to-end encryption) |
| `receive` | Another peer's `send` payload, with `channel`, `peer`, `value` (verbatim JSON) |
| `authenticated` / `challenge` | Handshake frames, see above |

## Terminal error frames (always sent before disconnect, unless the transport is already dead)

| error code | trigger |
|---|---|
| `invalid_frame_fields` | missing `id`, carrying `admission`/`signature`, non-send frame over 16 KiB, etc. |
| `invalid_target_encoding` | `target` is not a non-empty string |
| `invalid_channel` | subscribing to a channel the room did not declare |
| `message_bound_or_unsubscribed` | sending to an unsubscribed channel, empty payload or payload over the channel's declared limit |
| `keepalive_without_subscription` | keepalive without a subscription |
| `unknown_frame_kind` | any other unknown kind |
| `frame_or_byte_rate` | per-connection frame/byte rate or per-IP aggregate byte rate limit hit |

After a terminal error frame the client should reconnect with the `recovery` ticket and resynchronize local state.
Retries should use exponential backoff.

## Delivery semantics (reliability contract)

- **At most once**: the relay does not persist and does not resend.
  TCP plus per-peer FIFO guarantees frames from the **same sender are ordered and not duplicated** (while the connection lives).
- The client envelope layer owns disconnect recovery: critical envelopes (scoring, votes) should carry a monotone sequence number and a peer application-level acknowledgment.
  On detecting a gap, reconnect via a recovery ticket and perform history synchronization.
  The relay does not provide QoS 1/2.
- Rooms are entirely in memory; after a relay restart a room can be restored with an unexpired recovery ticket (`POST /rooms/{code}/restore`).
  Multi-instance recovery also requires shared ticket keys and a unified origin.
  Same-room routing, allocation and failover correctness still need separate validation.

## Rate limits (defaults, adjustable via server configuration)

Per connection: 64 frames/s, 1 MiB/s (token bucket, 2-second burst); write queue 128 frames / 1 MiB, full queue drops that connection; global queue 64 MiB.

Per IP: authenticated inbound WS raw JSON bytes default to 1 MiB/s with a 2-second burst; `IP_BYTES_PER_SECOND` adjusts it.
Rooms and channels share that source-IP budget, and JSON whitespace counts.
Per-connection limits still apply.
IP identification trusts only proxies listed in `TRUSTED_PROXIES`; outbound fanout bandwidth lies outside this limit.
Token refill uses the monotonic component of Go time.

## Stable member order (optional v1 extension)

Discovery advertises `stableMemberOrder: true` only when `MEMBER_STATE_FILE` is configured. Within a room instance, a verified transport public key receives one `joinSeq` (1..4096) at its first successful authenticated connection. Allocation/admission requests do not reserve a number; the host is not necessarily number 1. Leaving never recycles numbers; multiple connections of the same public key share the number. This is transport membership order, not a game seat.

**Frame fields.** `authenticated` adds `key` and, when enabled, `joinSeq`. `join`, `leave` and `receive` add the sender/member `key` and optional `joinSeq`; `peer` remains the ephemeral connection ID used for targeting. Existing frame kinds, signatures and `romzo/v1` stay unchanged.

**Snapshot semantics and ordering.** Every successful subscribe ack includes `channel` and `value: {members: [{peer, key, joinSeq?}, ...]}`: a complete list of online connections subscribed to that channel, including the caller. It is sorted by joinSeq then peer, and includes separate connections sharing a key. Existing-member join notifications precede this snapshot; subsequent increments follow it on the same socket queue. Repeated subscriptions also return a fresh snapshot. No other channel membership is disclosed.

**Client application rules.** Apply the snapshot synchronously when processing the ack, before subsequent frames; applying it later in a promise continuation can erase a newer join. Server snapshots may exceed the 16 KiB client-control cap and remain within the 288 KiB server-frame cap.

Persisted order survives recovery into the same signed room instance; a new instance never inherits the old order. A restored service must have the original state file and stable ticket keys. Missing records fail restore with `member_state_unavailable` (409); durable-write failures use `member_state_write_failed` (503 on HTTP or request/terminal WS error). A 4096-identity room rejects new authenticated identities with `member_capacity`; existing identities can reconnect. When durable numbering is disabled, joinSeq is omitted; clients must not invent a globally consistent number.

See [member-order-v1-vectors.json](member-order-v1-vectors.json) for public, deterministic frame fixtures.

## Optional client mesh convention

The SDK's optional `MeshSession` declares a `signal` application channel and
exchanges versioned hello, signed offer/answer, generation-scoped candidates,
restart and best-effort bye payloads through normal directed sends. Business
payloads can then use a reliable ordered WebRTC DataChannel instead of the relay.
This is a client convention, not a change to `romzo/v1` or relay authorization.
Across relay/RTC switches, messages may be reordered or lost; applications own
sequencing, acknowledgments and history recovery. SDP signatures trust roster
keys and do not authenticate identities independently of the relay.
See [SDK mesh contract](../packages/romzo-client/README.md#optional-automatic-p2p-mesh).

## Persistent-identity rooms

Signed options `identityPolicy: {exclusive:true, ttlMs}` enable one live connection per public key. After proof verification the relay checks occupancy atomically. Conflicts receive terminal `identity_in_use` without allocating a peer or member number. Online capacity returns `room_full`; the retained identity table returns `member_capacity`. Clients must not interpret unrelated errors as identity occupancy.

Online keys remain retained. Offline keys expire after ttlMs; new member numbers keep increasing and never reuse removed identities' numbers. Expired identity recovery returns `identity_expired`. Rooms without this policy still allow shared-key connections. Identity recovery does not change at-most-once delivery or replay missed messages.
