# romzo

中文：[README_zh.md](README_zh.md)

Romzo client SDK — a standalone client implementation of the room-based opaque WebSocket relay (`romzo/v1` protocol).

Zero runtime dependencies; uses only the global `crypto.subtle` (WebCrypto) and the global `WebSocket` (browser / Node 22+).
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
const link = buildInviteLink("https://romzo.net:9224", "ABCD123XYZ", "https://game.example.com/");
// https://game.example.com/#ABCD123XYZ@romzo.net
const address = parseInviteHash(new URL(link).hash);
// { origin: "https://romzo.net:9224", code: "ABCD123XYZ" }
```

An omitted invite port is the service default port **9224** (`DEFAULT_RELAY_PORT`).
A relay on 443 must be written explicitly — `buildInviteLink("https://romzo.net", ...)` produces `#ABCD123XYZ@romzo.net:443` — otherwise it would parse back as 9224.
Local loopback development should always write its port explicitly.

The functions do not read or write the DOM or history.
After consuming an invite the application should clear the address-bar hash and keep reload/history-navigation state itself.
Production invites imply HTTPS; when the invite functions handle a local loopback address, pass `{ allowLoopbackHttp: true }` to allow http.
Passwords and recovery tickets never belong in an invite.

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

Non-browser applications must still send a WebSocket Origin matching the server's `CLIENT_ORIGINS`; inject `webSocketFactory` to set headers (the integration tests in this repository use an application-side `ws` factory, a dev dependency for tests only).
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
