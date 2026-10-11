# @romzo/client

中文：[README_zh.md](README_zh.md)

Romzo client SDK — a standalone client implementation of the room-based
opaque WebSocket relay (`romzo/v1` protocol).

Zero runtime dependencies; uses only the global `crypto.subtle` (WebCrypto)
and the global `WebSocket` (browser / Node 22+). ESM, strict TypeScript.
Behavior is byte-compatible with the Go reference server (canonical JSON,
domain-separated hashes/HMACs, Ed25519 signature domains) and contract-checked
against the shared test vectors in `protocol/relay-v1-vectors.json`.

## Concepts

- A **room** is identified by a 10-character room code; the host signs the room descriptor with the `host` key pair.
- **Tickets**: short-lived admission tickets (60 seconds, single handshake) authenticate the WebSocket; long-lived recovery tickets restore a room after a crash/restart.
- **Channels**: `discovery` / `lobby` / `game`; once subscribed you receive live updates (join/leave/receive frames).
- The relay does not persist messages: at-most-once delivery; the client envelope layer handles reliability (see FRAMES.md).

## Create → confirm → connect (host)

```ts
import { createRoom, RelaySession } from "@romzo/client";

const room = await createRoom("https://relay.example", roomOptions, {
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

await session.subscribe("lobby");
await session.send("lobby", { hello: "world" });
```

## Guest join

```ts
import { joinRoom, RelaySession } from "@romzo/client";

const joined = await joinRoom("https://relay.example", "ABCD2345EF");
const url = joined.signedDescriptor.descriptor.origin.replace(/^http/, "ws") + "/ws";
const session = await RelaySession.connect(url, joined.admission, joined.transport);
await session.subscribe("lobby");
```

## Invites

```ts
import { buildInviteLink, parseInviteHash } from "@romzo/client";
const link = buildInviteLink("https://romzo.net:9224", "ABCD123XYZ", "https://game.example.com/");
// https://game.example.com/#ABCD123XYZ@romzo.net
const address = parseInviteHash(new URL(link).hash);
// { origin: "https://romzo.net:9224", code: "ABCD123XYZ" }
```

An omitted invite port is the service default port **9224** (`DEFAULT_RELAY_PORT`). A relay on 443 must be written explicitly — `buildInviteLink("https://romzo.net", ...)` produces `#ABCD123XYZ@romzo.net:443` — otherwise it would parse back as 9224. Local loopback development should always write its port explicitly.

The functions do not read or write the DOM or history. After consuming an invite the application should clear the address-bar hash and keep reload/history-navigation state itself. Production invites imply HTTPS; a local HTTP client connecting to a loopback HTTP relay must pass `{ allowLoopbackHttp: true }` explicitly. Passwords and recovery tickets never belong in an invite.

## Crash recovery

Keepalive responses update `session.currentRecovery()` automatically (it can also be persisted via the `onRecovery` callback). Recovery flow:

```ts
import { restoreSession, RelaySession } from "@romzo/client";

const restored = await restoreSession(saved.signedDescriptor, saved.recovery, saved.transport);
const session = await RelaySession.connect(wsUrl, restored.admission, restored.transport);
// resubscribe and perform envelope-layer history sync
```

## Layered API

Non-browser applications must still send a WebSocket Origin matching the server's `CLIENT_ORIGINS`; inject `webSocketFactory` to set headers (the integration tests in this repository use an application-side `ws` factory, a dev dependency for tests only). The SDK does not persist keys or history state.

| module | contents |
|---|---|
| `canonical` | `canonical()`, `hash(domain, v)`, `mac(key, domain, v)`, hex utilities (byte-compatible with the Go implementation) |
| `crypto` | Ed25519 key generation/import/export, `sign`/`verify`, PBKDF2 password derivation (600000 iterations), `passwordProof` |
| `http` | `discover`, `createChallenge`, `allocate`, `confirmRoom`, `requestAdmission`, `fetchDescriptor`, `restoreRoom`; all support injected `fetch`, errors throw `RelayHttpError(code, status)` |
| `session` | `RelaySession.connect(url, admission, identity, opts)`: four-frame handshake, `subscribe`/`unsubscribe`/`send`/`keepalive`, event subscription, automatic keepalive (can be disabled), `currentRecovery()`; injectable WebSocket factory |
| facade | `createRoom()` / `joinRoom()` / `restoreSession()` wrap the full HTTP sequence |

## Tests

```sh
npm install
npm run check -w @romzo/client   # tsc --noEmit
npm test -w @romzo/client        # vitest (includes shared-vector contract tests, no real network)
npm run build -w @romzo/client
```

## Requests, validation and caching

The HTTP primitives and the exported `relayRequest(origin, path, body?, options?)` default to a 10-second budget per attempt (including reading the body), one retry on network failure, and a 16 KiB response cap; adjust with `timeoutMs`, `retries`, `maxResponseBytes`. User cancellation, HTTP errors, invalid JSON, empty responses and over-limit responses are not retried. Network retries reuse the same serialized request; they must not regenerate requestId, challenge, proof or a Turnstile token.

`joinRoom` runs `verifyDescriptor` before requesting admission: field whitelist, origin/code, configHash and the host Ed25519 signature. `createRoom` also validates the descriptor before confirming. Supply application rules via the `validateOptions` callback; the SDK does not interpret board-game options. A signature proves the descriptor was signed by the host key it carries; confirming who is behind an invite still requires a trusted channel.

```ts
import { createPasswordKeyCache, createRoom } from "@romzo/client";
const passwordKeyProvider = createPasswordKeyCache(creationPassword);
const room = await createRoom(origin, options, { passwordKeyProvider, validateOptions });
// password change: clear() and discard the old instance, create one bound to the new password
passwordKeyProvider.clear(origin); // or clear() to drop all derived keys
```

The cache belongs to a single password instance, keyed by origin, salt and iterations; derivation failures are deleted automatically, and a failed room-creation authentication clears that origin. It does not persist passwords or derived keys. Holding the cache instance keeps the password closure alive; clear and release the instance when done — JavaScript does not guarantee memory erasure.

## Session and private-key responsibilities

The SDK keepalives every 10 seconds by default; the application should subscribe promptly, since keepalive without a subscription is rejected by the server. The handshake rejects out-of-order frames, duplicate challenges and origin/ticket binding mismatches; handshake frames after authentication, invalid JSON, binary frames or a version error close the session and reject pending requests. The SDK does not reconnect automatically; the caller handles reconnection, resubscription and history sync.

Private keys from `generateKeyPair()` and `importKeyPair()` are **extractable**, for export and recovery. Exported private-key values, passwords and recovery tickets must never appear in invite URLs, telemetry, logs or public test artifacts; the application chooses protected persistence and a clearing policy. Callers may supply compatible non-extractable CryptoKeys, but those cannot be exported with `exportPrivateKey` for recovery.

After a disconnect, the application layer handles gap detection, operation deduplication and history sync; see FRAMES.md for the delivery contract.
