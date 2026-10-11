# romzo/v1 WebSocket frame protocol

中文：[FRAMES_zh.md](FRAMES_zh.md)

This document is the specification of the `relay` WebSocket surface; it
complements the OpenAPI document (`openapi.yaml`) for the HTTP surface.
Third-party client implementations can follow this document and the shared
test vectors (`protocol/relay-v1-vectors.json`) alone.

Server release is **1.3.0**; the public wire protocol is **romzo/v1**.
HTTP routes use `/api/v1/`, WebSocket uses `/ws`, and cryptographic domains
use the `romzo/` prefix. Clients and servers must use the same protocol.
Release 1.3.0 makes the channel set declarative: allocation options may
carry a `channels` list, replacing the previously hardcoded
`discovery` / `lobby` / `game` names and per-name frame tiers (see
Channels below). Options without `channels` keep the old behavior
unchanged.

## Invite links and room configuration

The standard invite is `https://<client-origin>/#<10-char Crockford room code>@<relay-host[:port]>`, e.g. `https://game.example.com/#ABCD123XYZ@romzo.net`. Room codes are uppercase, without separators; production relays imply HTTPS. An omitted port is the service default port **9224**; a relay on 443 must write `:443` explicitly (otherwise it reads back as 9224), and local loopback development should always write its port explicitly.

The fragment never enters the HTTP request; the client parses it, clears it via `history.replaceState`, and keeps the state needed for reloads and history navigation itself. Passwords, private keys and recovery tickets never enter an invite. The SDK functions `buildInviteLink` / `parseInviteHash` are pure and do not touch browser history.

Only explicitly enabled local development may use an HTTP loopback relay (localhost, 127.0.0.1, [::1]); production pages must not interpret a scheme-less invite as remote HTTP. Applications handle legacy invite compatibility, development address overrides and browser-history recovery; the SDK pure functions cover only the standard invite format.

The descriptor `options` are opaque canonical JSON, allowing any JSON root type; the UTF-8 raw JSON cap is `MAX_OPTIONS_BYTES`, default and maximum 4096 bytes. The frozen canonical protocol allows only safe integers — no decimals, no numbers outside the JavaScript safe-integer range. The server checks configHash but does not interpret players, factions, scoring or lifecycle; the application must validate its own rules before requesting admission.

## Channels

The room's channel set is declared in the allocation `options` under
`"channels"`, as up to 8 entries of
`{"name": "table", "maxFrameBytes": 262144}`:

- `name` matches `^[a-z][a-z0-9-]{0,31}$`; entries must not repeat.
- `maxFrameBytes` is the per-channel `send` payload limit, between 256 and
  262144 (256 KiB) bytes inclusive.
- A malformed declaration — bad name, duplicate, more than 8 entries, or an
  out-of-range limit — fails allocation with `invalid_allocation`.

Options with no `channels` key keep the pre-1.3.0 compatibility defaults:

| channel | send payload limit |
| --- | --- |
| `discovery` | 16 KiB |
| `lobby` | 16 KiB |
| `game` | 256 KiB |

The relay is zero-knowledge about channels: it validates only name syntax
and numeric bounds and never interprets meaning. Because the declaration
lives in `options`, `configHash` binds every peer of the room to the same
channel set. Each channel's declared `maxFrameBytes` replaces the old
per-name tiers when sending; the global 256 KiB payload limit remains the
absolute upper bound.

## Connection and transport

- Endpoint: `GET /ws`, WebSocket text frames, **binary frames not supported**.
- Every frame is a single JSON object with a `"v": "romzo/v1"` version field.
- Origin must be in the relay's allowlist (browser scenarios); each IP has an independent token-bucket rate limit.
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

- The `admission` ticket is issued by `POST /rooms` (host), `/rooms/{code}/confirm`, `/admissions` (guest) or `/restore`; it is valid for 60 seconds and void after a single handshake.
- `proof` signs the challenge object with the Ed25519 private key matching the ticket's `key` (domain-separation string `romzo/relay-connect/v1`, see vectors).
- Handshake failure always drops the connection with **no error frame** (no feedback for enumeration attackers).

## Client frames after authentication

Common fields: `id` is a required non-empty response-correlation ID of ≤64 characters; a `send` frame may carry `target` (a peer id string).

| kind | fields | semantics |
|---|---|---|
| `subscribe` | `channel` | Subscribe to a channel declared in the room options (a compatibility default name if the options declare none). On success you receive `join` for existing channel members and broadcast `join` to them |
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

After a terminal error frame the client should reconnect with the `recovery` ticket and resynchronize local state instead of retrying immediately; exponential backoff is recommended.

## Delivery semantics (reliability contract)

- **At most once**: the relay does not persist and does not resend. TCP plus per-peer FIFO guarantees frames from the **same sender are ordered and not duplicated** (while the connection lives).
- The client envelope layer owns disconnect recovery: critical envelopes (scoring, votes) should carry a monotone sequence number and a peer application-level acknowledgment; on detecting a gap, reconnect via a recovery ticket and perform history synchronization. The relay does not provide QoS 1/2.
- Rooms are entirely in memory; after a relay restart a room can be restored with an unexpired recovery ticket (`POST /rooms/{code}/restore`). Multi-instance recovery also requires shared ticket keys and a unified origin; same-room routing, allocation and failover correctness still need separate validation.

## Rate limits (defaults, adjustable via server configuration)

Per connection: 64 frames/s, 1 MiB/s (token bucket, 2-second burst); write queue 128 frames / 1 MiB, full queue drops that connection; global queue 64 MiB.

Per IP: authenticated inbound WS raw JSON bytes default to 1 MiB/s with a 2-second burst; `IP_BYTES_PER_SECOND` adjusts it. Rooms and channels share that source-IP budget, and JSON whitespace counts. Per-connection limits still apply. IP identification trusts only proxies listed in `TRUSTED_PROXIES`; outbound fanout bandwidth lies outside this limit. Token refill uses the monotonic component of Go time.
