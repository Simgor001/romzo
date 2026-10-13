# romzo

中文：[README_zh.md](README_zh.md)

Romzo client SDK — a standalone client implementation of the room-based opaque WebSocket relay (`romzo/v1` protocol).

Uses Web Crypto and WebSocket (HTTPS browsers / Node 24+), with `@noble/curves` as the Ed25519 fallback for browsers without native support. Use `exportPrivateKey` and `importKeyPair` for portable key persistence; fallback keys are opaque handles rather than native CryptoKeys.

## Optional invitation QR codes

Import QR helpers from `romzo/qr`; they are deliberately absent from the root
entry so ordinary SDK bundles do not pull in the encoder or camera helpers.
The pinned `qr@0.7.2` dependency has no dependencies of its own. Measured with
esbuild minification + gzip: encoder 6.5 KiB, software decoder 16.8 KiB. The
decoder is a dynamic import, used only for image reads or camera fallback.

```ts
import { buildInviteLink } from "romzo";
import { renderInviteQr, scanInviteCamera, readInviteQrFile } from "romzo/qr";
const invite = buildInviteLink(origin, code, "https://game.example/");
const svg = renderInviteQr(invite); // Full invitation, not just the room code
const controller = new AbortController();
const address = await scanInviteCamera(video, { signal: controller.signal });
// Check address.origin against your application policy before requesting admission.
// Closing your UI should call controller.abort().
// A photo/file fallback: await readInviteQrFile(file).
```

`renderInviteQr` creates black-on-white SVG with a four-module quiet zone.
`readInviteQr({width,height,data})` reads RGBA pixels and also works in Node;
`readInviteQrFile(Blob)` uses the browser's image decoder locally. Camera scans
prefer native QR-capable `BarcodeDetector`, falling back to the lazy decoder.
Camera permission is requested only when invoked; success, abort, timeout and
errors release owned tracks. Default timeout is 60 seconds, rear camera preferred.
HTTPS/secure context is required for camera access; images/manual codes remain
available when the camera is denied or absent. Parsed invitations return only
`{origin,code}` and never navigate to a decoded client URL. Check the relay before
joining; non-invitation QR codes are rejected. Loopback HTTP is opt-in through
`{allowLoopbackHttp:true}` for local tests, not a public HTTP-camera guarantee.

The single browser demo `website/play.html` shows the QR when a room is ready,
supports camera/image joining, copying invitations, and leaving/rejoining rooms.
Images are not uploaded. Browser tests use actual QR pixels and controlled
video frames; this does not certify scanning through physical phone cameras.

## Optional automatic P2P mesh

`MeshSession` (`romzo` or `romzo/mesh`) layers WebRTC over `RelaySession` without
changing the relay protocol. Declare `{name: "signal", maxFrameBytes: 16384}`
alongside your business channels, within the room's eight-channel limit:

```ts
import { MeshSession, attachMesh } from "romzo/mesh";
const session = await MeshSession.connect(url, admission, identity,
  { autoReconnect: { signedDescriptor } },
  { signedDescriptor, rtcConfig: { iceServers: [{ urls: "stun:your-stun.example" }] },
    onPath: (peer, path) => console.log(peer, path) });
await session.subscribe("chat");
await session.send("chat", { seq: 1, text: "hello" });
// With an existing relay: await attachMesh(relay, identity, {signedDescriptor}).
```

Attachment verifies the descriptor, the immutable `relay.roomBinding`
(`origin/code/instance/digest`), and identity key. It resolves after signal
subscription, before RTC negotiation. A relay can have only one mesh attachment;
successful attachment owns that session's lifecycle. Failed attachment cleans up
its listeners/subscription without closing the caller's relay. `connect` closes
its newly created relay on attachment failure.

The wrapper proxies `id`, `key`, `joinSeq`, `roomBinding`, `on/off`,
`subscribe/unsubscribe/send/members`, `keepalive`, `currentRecovery`, and `close`.
`path(peer)` returns `relay`, `connecting`, `rtc`, or null for unknown peers;
`onPath` reports changes. RTC can traverse TURN, so `rtc` is not a direct-network
claim. The signal channel is hidden from wrapper events and members, and cannot
be used or unsubscribed through the wrapper. `relay` is an explicit escape hatch.
Node imports and attachment work without WebRTC and retain relay delivery.

**Delivery:** each message chooses one path, with no automatic retry or replay.
Each live path is ordered and at-most-once, but switching paths can reorder or
lose messages. Relay `send()` resolves on server ack; RTC resolves on local
enqueue. Neither confirms receiver processing. Application envelopes must supply
sequence numbers, acknowledgments, deduplication, reordering, gap detection and
history synchronization. Broadcast can partially succeed before rejecting;
successful copies are never resent by mesh.

RTC uses one reliable ordered DC and `{v:1,channel,value}` JSON envelopes. Identity
metadata comes from the relay roster. Both peers must subscribe to the business
channel; payload size is checked against its declared UTF-8 JSON limit. Oversize
DC envelopes for the negotiated SCTP limit use relay instead. All-relay broadcast
uses one native broadcast; mixed broadcast uses one copy per recipient. A queued
native broadcast rejects if its recipient roster changes before dispatch.

**Budgets:** defaults are 128 queued/in-flight delivery items, 1 MiB total and a
15-second waiting deadline. Relay send/signaling share 32 frames/s (burst 8) and
256 KiB/s (burst 512 KiB); control messages have priority and remain bounded. DC
high/low water marks are 256/64 KiB; messages larger than the high water mark wait
for an empty buffer.

- Queue overflow rejects without silently merging or dropping application
  messages; a mixed broadcast reserves capacity for all copies before dispatch.
- Configure `maxQueuedItems`, `maxQueuedBytes`, `queueTimeoutMs`,
  `relayFramesPerSecond`, `relayFrameBurst`, `relayBytesPerSecond`,
  `relayByteBurst`, `bufferedAmountHighWaterMark` and
  `bufferedAmountLowWaterMark` in mesh options.
- A relay packet larger than the configured byte burst rejects.
- When the relay runs custom limits, lower these budgets to match. The budgets
  exclude automatic relay keepalive, subscriptions and direct escape-hatch
  calls, and do not guarantee immunity to all server limits.

**Signaling and trust:** versioned hello requests get one reply per peer; replies
never get replies. The smaller `(key,peerId)` tuple owns offers and generation
allocation. Offer/answer signatures use `romzo/mesh-sdp/v1`, covering the room,
both peers/keys, generation, frame kind and SDP. We trust roster keys: signatures
do not protect against a malicious relay replacing that roster, hide SDP, or
encrypt relay-path application data. Candidates are generation/ICE-ufrag scoped
and bounded to 64 entries / 64 KiB. Negotiation defaults to 10 seconds, followed
by one 1–2 second backoff retry; a successful connection resets the retry budget,
and an unrecovered pair keeps relay until peer membership changes. Relay loss
immediately invalidates PCs and queued sends; reconnection
re-discovers peers after roster restoration. `bye` is best effort.

The website's `play.html` is the single browser demo and includes path badges.
The playground requires signal and durable member numbering (`MEMBER_STATE_FILE`)
on the relay. Rooms lacking signal and nodes without member numbers cannot connect.
Run `npm run build:website` and `npm run dev --prefix website` for local preview.
The deployed playground targets romzo.net; integration tests substitute a local
relay origin and stub verification only. `npm run test:mesh` verifies real local
RTC, fallback, relay restart and package consumption. Public NAT, UDP-restricted
networks, and TURN candidate-path acceptance require separate network testing.
ESM, strict TypeScript.
Behavior is byte-compatible with the Go reference server (canonical JSON, domain-separated hashes/HMACs, Ed25519 signature domains) and contract-checked against the shared test vectors in `protocol/relay-v1-vectors.json`.

## Concepts

- A **room** is identified by a 10-character room code; the host signs the room descriptor with the `host` key pair.
- **Tickets**: short-lived admission tickets (60 seconds, single handshake) authenticate the WebSocket; long-lived recovery tickets restore a room after a crash/restart.
- **Channels**: the room options may declare up to 8 channels (`{ "name": "table", "maxFrameBytes": 262144 }`); peers subscribe to declared names to exchange messages — membership changes arrive as join/leave frames, payloads as receive frames. Options without a `channels` key have no channels. The SDK supplies no predefined names. The relay only checks name syntax and size bounds; channel meaning is application policy.
- The relay does not persist messages: at-most-once delivery; the client envelope layer handles reliability (see FRAMES.md).

## Create → confirm → connect (host)

The relay origin may be written with or without the scheme: bare hosts default to https, loopback hosts to http.

```ts
import { createRoom, RelaySession } from "romzo";

const roomOptions = {
  players: 4,
  channels: [
    { name: "table", maxFrameBytes: 262144 },
    { name: "chat", maxFrameBytes: 16384 },
  ],
};
const room = await createRoom("relay.example", roomOptions, {
  password: creationPassword,        // required when the relay uses password auth
  turnstileToken: turnstileToken,    // required when Discovery.turnstile is true
});

// Persist these three to recover after a crash (see below)
//   room.signedDescriptor, room.transport, room.recovery

const url = room.descriptor.origin.replace(/^http/, "ws") + "/ws";
const session = await RelaySession.connect(url, room.admission, room.transport);

session.on("join", (_p, { channel, peer, key }) => { /* peer public key for end-to-end encryption */ });
session.on("receive", (value, { channel, peer }) => { /* another peer's send payload */ });
session.on("close", () => { /* terminal error frame or transport drop; reconnect with the recovery ticket */ });

await session.subscribe("table");
await session.send("table", { hello: "world" });
```

Peers of the same room must agree on the declaration:
the descriptor `configHash` covers the options verbatim, and the relay rejects a `send` payload larger than the channel's declared `maxFrameBytes` with the terminal error `message_bound_or_unsubscribed`.

## Guest join

```ts
import { joinRoom, RelaySession } from "romzo";

const joined = await joinRoom("relay.example", "ABCD2345EF");
const url = joined.signedDescriptor.descriptor.origin.replace(/^http/, "ws") + "/ws";
const session = await RelaySession.connect(url, joined.admission, joined.transport);
await session.subscribe("table");
```

## Invites

```ts
import { buildInviteLink, parseInviteHash } from "romzo";
const link = buildInviteLink("https://romzo.net", "ABCD123XYZ", "https://game.example.com/");
// https://game.example.com/#ABCD123XYZ/romzo.net
const address = parseInviteHash(new URL(link).hash);
// { origin: "https://romzo.net", code: "ABCD123XYZ" }
```

An omitted invite port is the service default port **443** (`DEFAULT_RELAY_PORT`).
Other ports must be explicit: `buildInviteLink("https://romzo.net:9224", ...)` produces `#ABCD123XYZ/romzo.net:9224`. Legacy invitations using `@` are still accepted.
Local loopback development should always write its port explicitly.

The functions do not read or write the DOM or history.
After consuming an invite the application should clear the address-bar hash and keep reload/history-navigation state itself.
Production invites imply HTTPS; when the invite functions handle a local loopback address, pass `{ allowLoopbackHttp: true }` to allow http.
Passwords and recovery tickets never belong in an invite.

LAN invitations extend the host position without changing the room code; `parseInviteHash` auto-detects private literals and returns candidates in `lan` instead of `origin`:

- `#ABCD123XYZ/lan` — discovery: `{ code, lan: [] }`; the room code is the rendezvous key on the local network.
- `#ABCD123XYZ/192.168.1.50,10.0.0.7:7777` — direct: up to eight private candidates sharing one port, `{ code, lan: ["192.168.1.50:7777", "10.0.0.7:7777"] }`.
- `#ABCD123XYZ/192.168.1.50:7777` — a single private literal auto-detects as one direct candidate.

Candidates are private literals only (`10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `100.64/10`, `fc00::/7`, `fe80::/10`, `*.local`); public IP literals keep their relay-origin meaning and loopback stays a relay origin. `buildLanInvite(code, hosts, client)` builds both forms (empty `hosts` = discovery) and round-trips through the parser. `parseInviteText` parses full links, bare fragments and bare `CODE/host` strings; links with credentials or a query never parse.

## Crash recovery

Keepalive responses update `session.currentRecovery()` automatically (it can also be persisted via the `onRecovery` callback).
Recovery flow:

```ts
import { restoreSession, RelaySession } from "romzo";

const restored = await restoreSession(saved.signedDescriptor, saved.recovery, saved.transport);
const session = await RelaySession.connect(wsUrl, restored.admission, restored.transport);
// resubscribe and perform envelope-layer history sync
```

## Layered API

Private relays require a WebSocket Origin matching `CLIENT_ORIGINS`; public relays configured with `CLIENT_ORIGINS=*` also accept non-browser clients without Origin; inject `webSocketFactory` to set headers (the integration tests in this repository use an application-side `ws` factory, a dev dependency for tests only).
The SDK does not persist keys or history state.

| module | contents |
|---|---|
| `canonical` | `canonical()`, `hash(domain, v)`, `mac(key, domain, v)`, hex utilities (byte-compatible with the Go implementation) |
| `crypto` | Ed25519 key generation/import/export, `sign`/`verify`, PBKDF2 password derivation (600000 iterations), `passwordProof` |
| `http` | `discover`, `createChallenge`, `allocate`, `confirmRoom`, `requestAdmission`, `fetchDescriptor`, `restoreRoom`; all support injected `fetch`, errors throw `RelayHttpError(code, status)` |
| `session` | `RelaySession.connect(url, admission, identity, opts)`: four-frame handshake, `subscribe`/`unsubscribe`/`send`/`keepalive`, event subscription, automatic keepalive (can be disabled), `currentRecovery()`, opt-in automatic reconnection (`autoReconnect`, resubscribes tracked channels, emits `reconnect`/`reconnecting`); injectable WebSocket factory |
| facade | `createRoom()` / `joinRoom()` / `restoreSession()` wrap the full HTTP sequence |

## Tests

```sh
npm install
npm run check -w romzo   # tsc --noEmit
npm test -w romzo        # vitest (includes shared-vector contract tests, no real network)
npm run build -w romzo
```

## Requests, validation and caching

The HTTP primitives and the exported `relayRequest(origin, path, body?, options?)` default to:

- a 10-second budget per attempt (including reading the body),
- one retry on network failure,
- a 16 KiB response cap;

adjust with `timeoutMs`, `retries`, `maxResponseBytes`.
User cancellation, HTTP errors, invalid JSON, empty responses and over-limit responses are not retried.
Network retries reuse the same serialized request; they must not regenerate requestId, challenge, proof or a Turnstile token.

`joinRoom` runs `verifyDescriptor` before requesting admission: field whitelist, origin/code, configHash and the host Ed25519 signature.
`createRoom` also validates the descriptor before confirming.
Supply application rules via the `validateOptions` callback; the SDK does not interpret options.
A signature proves the descriptor was signed by the host key it carries; confirming who is behind an invite still requires a trusted channel.

```ts
import { createPasswordKeyCache, createRoom } from "romzo";
const passwordKeyProvider = createPasswordKeyCache(creationPassword);
const room = await createRoom(origin, options, { passwordKeyProvider, validateOptions });
// password change: clear() and discard the old instance, create one bound to the new password
passwordKeyProvider.clear(origin); // or clear() to drop all derived keys
```

The cache belongs to a single password instance, keyed by origin, salt and iterations.
Derivation failures are deleted automatically; a failed room-creation authentication clears that origin.
It does not persist passwords or derived keys.
Holding the cache instance keeps the password closure alive; clear and release the instance when done — JavaScript does not guarantee memory erasure.

## Session and private-key responsibilities

The SDK keepalives every 10 seconds by default; the application should subscribe promptly, since keepalive without a subscription is rejected by the server.
The handshake rejects out-of-order frames, duplicate challenges and origin/ticket binding mismatches; handshake frames after authentication, invalid JSON, binary frames or a version error close the session and reject pending requests.

Automatic reconnection is opt-in, via `autoReconnect: { signedDescriptor, maxAttempts?, baseDelayMs?, maxDelayMs? }` on `RelaySession.connect` (`signedDescriptor` is required; omitting it throws).
When enabled, a transport drop or a terminal error frame starts a reconnect loop:

1. Each attempt trades the latest `currentRecovery()` ticket plus the configured signed descriptor for a fresh admission ticket through `restoreSession`, then re-handshakes and re-subscribes the channels the session had subscribed to.
2. A successful attempt emits `reconnect` with `{ attempt }`.
3. Delays grow exponentially from `baseDelayMs` (default 1000 ms) up to `maxDelayMs` (default 15000 ms) with ±20% jitter, for at most `maxAttempts` attempts (default 8).
4. Every scheduled attempt emits `reconnecting` with `{ attempt, delayMs, error }`.
5. `close` is emitted only after every attempt has failed — or right after a manual `close()`.

While a reconnect is in progress, `send`/`subscribe` reject immediately with a reconnecting error instead of hanging, and the keepalive timer is paused until the session is restored.
Without `autoReconnect` the behavior is unchanged: a drop or terminal error closes the session and emits `close` immediately, and the caller handles reconnection, resubscription and history sync.

Even with `autoReconnect` enabled, the application still owns envelope-layer history synchronization:
the SDK restores transport and channel membership but does not detect gaps, deduplicate or backfill messages (delivery is at-most-once; see FRAMES.md).
Persist the recovery ticket via `onRecovery`/`currentRecovery()` and the signed descriptor with the same care as private keys.

Private keys from `generateKeyPair()` and `importKeyPair()` are **extractable**, for export and recovery.
Exported private-key values, passwords and recovery tickets must never appear in invite URLs, telemetry, logs or public test artifacts; the application chooses protected persistence and a clearing policy.
Callers may supply compatible non-extractable CryptoKeys, but those cannot be exported with `exportPrivateKey` for recovery.

After a disconnect, the application layer handles gap detection, operation deduplication and history sync; see FRAMES.md for the delivery contract.

Channel names are application-defined; an undeclared channel set is empty.

Recovery acknowledgements wait for the `onRecovery` persistence callback. If it fails, the request rejects with `recovery_persistence_failed`; the socket remains usable and no unhandled promise rejection escapes the event handler.

### Stable member order

When discovery advertises `stableMemberOrder`, `session.joinSeq` is your identity's first-join number within this room instance. `session.members(channel)` returns an immutable, sorted online **connection** list (`Member`: peer, key, optional joinSeq); several connections may share a key/number. Count unique keys for online people. `session.on("members", (members, {channel}) => ...)` reports snapshot/increment updates, including clearing on transport loss and rebuilding after subscription/reconnect. The list is available after `await session.subscribe(channel)`. `join`/`leave`/`receive` metadata also include optional `joinSeq`. When durable numbering is disabled, show an unnumbered label. These numbers are not game seats and do not imply reliable message delivery.

```ts
await session.subscribe("chat");
console.log(session.joinSeq, session.members("chat"));
session.on("members", (_members, {channel}) => {
  if (channel === "chat") renderMembers(session.members("chat"));
});
```

## Browser identity persistence

`romzo/storage` stores identities in the application's IndexedDB origin, independently of the verification iframe. It is opt-in and safe to import in Node. `namespace` separates games hosted at the same origin. The default TTL is 30 minutes; declare the room policy when creating it:

```ts
const options = {
  identityPolicy: { exclusive: true, ttlMs: 30 * 60 * 1000 },
  channels: [{ name: "chat", maxFrameBytes: 16384 }, { name: "signal", maxFrameBytes: 16384 }],
};
```

`openIdentityStore({ namespace, identityTtlMs? })` exposes `list/get/latest/save/select/remove/track/cleanup/close`. Each identity contains its room binding, local label, keys, signed descriptor, recovery ticket, and `expiresAt`. There is no last-used timestamp. Reads and writes remove expired records. Keepalive renews connected identities; abrupt closure leaves the last successfully saved deadline. Clearing website data removes the identity.

```ts
import { MeshSession } from "romzo";
import { openIdentityStore, connectPersistentRoom } from "romzo/storage";

const store = await openIdentityStore({ namespace: "my-game" });
const active = await connectPersistentRoom(store, origin, code,
  (admission, identity, signedDescriptor, identityOptions) =>
    MeshSession.connect(origin.replace(/^http/, "ws") + "/ws", admission, identity,
      { ...identityOptions, autoReconnect: { signedDescriptor } }, { signedDescriptor }));
await active.session.subscribe("chat");
await active.session.keepalive();
await active.leave(); // Explicit leave deletes only this identity and its recovery materials.
store.close();
```

Joining clients follow the signed room TTL. A new tab probes the latest successful identity and allocates another key only on `identity_in_use`. Restoring a tab retries occupancy for up to 10 seconds; the application can then offer retry or `{newIdentity:true}`. Copied tab labels still require the relay occupancy check. Other errors propagate without replacing the key.

After creating a room, save its `host/transport/signedDescriptor/recovery` using `store.save`. Pass `store.track(record).onRecovery` into session options, then call `bind(session)` and `select(record)` after connecting successfully. `track.remove()` stops pending updates and deletes the record; late callbacks cannot recreate it. `flush()` waits for pending writes and rejects on failure. Failed automatic recovery persistence emits `error` with `recovery_persistence_failed`.

The relay needs `MEMBER_STATE_FILE` and discovery must advertise `persistentIdentity`. Exclusive rooms retain at most twice the connection limit in their public-key table; expired offline entries are reclaimed and member numbers are never reused. Persistence restores identity and transport, not application message history.

## Embedded creation verification

Turnstile runs on the relay-hosted `/api/v1/auth/turnstile` page. Browser `createRoom` opens a dismissible inline dialog by default. Use `verification: { mount, signal, timeoutMs }` to mount it in an application-owned window, or `requestEmbeddedGrant` to obtain a grant separately. Messages are bound to the iframe source, relay origin, request ID, and creator public key. Cancellation and timeout clean up the iframe and listeners.

Only the verification page's relay hostname needs Turnstile approval. Applications must still satisfy `CLIENT_ORIGINS`, and an application CSP must allow the relay origin in `frame-src`. OAuth keeps its existing flow. Node callers must supply a grant explicitly.
