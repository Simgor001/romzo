# Romzo

中文：[README_zh.md](README_zh.md)

A room-based opaque WebSocket relay with a zero-runtime-dependency TypeScript SDK.
The relay handles room registration, signed tickets, channel membership and bounded forwarding.
Applications own encryption, rules, persistence, reconnection and history synchronization.

Server release: **1.3.0**.
SDK: **romzo 0.3.0**.
Wire protocol: **romzo/v1** (HTTP under `/api/v1`, WebSocket at `/ws`).

## Components

| Component | Path | Description |
| --- | --- | --- |
| Relay server | `relay` | Room registration, signed tickets, channel membership and bounded forwarding. |
| TypeScript SDK | `packages/romzo-client` | Zero-runtime-dependency client SDK. |
| Protocol | `protocol/` | WebSocket specification, HTTP OpenAPI and shared test vectors. |
| Deployment | `deploy/` | Docker, environment template and reverse-proxy examples. |
| Documentation | `docs/` | Deployment, architecture and release guides. |

## Quick start

Requires Node.js 24 and Go 1.26.1.
From a clean checkout:

```sh
npm ci
npm run verify
```

## Use

In a browser client, after obtaining a creation password from the user:

The relay origin may be written with or without the scheme:
bare hosts default to https, loopback hosts to http.

```ts
import { createRoom, buildInviteLink, RelaySession } from 'romzo';

const room = await createRoom('relay.example.com', {
  game: 'example', players: 2, rules: ['draft'],
  channels: [
    { name: 'table', maxFrameBytes: 262144 },
    { name: 'chat', maxFrameBytes: 16384 },
  ],
}, { password: creationPassword });
const invite = buildInviteLink(room.descriptor.origin, room.descriptor.code,
  'https://client.example.com/');
const session = await RelaySession.connect(
  room.descriptor.origin.replace(/^http/, 'ws') + '/ws',
  room.admission, room.transport);
await session.subscribe('table');
```

Build the SDK from this workspace with `npm run build`.

Invites use `https://client/#ABCD123XYZ@relay.example.com`:

- An omitted port is the service default port 443; a relay on any other port must write it explicitly, e.g. `@relay.example.com:9224`.
- Passwords, private keys and recovery tickets never belong in URLs.

The application consumes and clears the fragment and owns browser-history recovery.
The SDK allows http origins on loopback only; production relay origins must be HTTPS.

## Limits

| Limit | Default | Notes |
| --- | --- | --- |
| Options payload | at most 4096 UTF-8 bytes (configurable lower) | Opaque canonical JSON. Applications validate their own rules before obtaining admission. |
| Channels | declared in options, up to 8 | `{"name": "table", "maxFrameBytes": 262144}` entries; undeclared rooms have no channels; the relay supplies no defaults. |
| Frame delivery | at most once | Send acknowledgments do not confirm that recipients applied an operation. |
| Reconnection | opt-in (`autoReconnect`) | Off by default; when enabled the SDK re-handshakes and re-subscribes, while the application still owns envelope-layer history sync (see the SDK README). |

## Development

`npm run verify` checks:

- the public file boundary and reachable Git history,
- SDK unit tests and types,
- Go tests and race tests,
- shared protocol vectors,
- `openapi.yaml` — the single source of truth for the HTTP surface, with a contract test covering every endpoint,
- SDK builds,
- a real local relay integration.

`npm run build:relay` builds Linux amd64/arm64 and Windows amd64 binaries, checksums and dependency license notices under `dist/relay/`.

The local integration starts a real Go process:
it creates and joins a generic room, authenticates two SDK sessions, forwards messages, renews tickets, restarts the relay and restores the room.
It covers local HTTP/WS only.
Public WSS, browser clients, real networks and multi-instance setups need their own tests.

## Documentation

| Document | Path | Notes |
| --- | --- | --- |
| SDK documentation | [packages/romzo-client/README.md](packages/romzo-client/README.md) | |
| Relay deployment guide | [docs/deployment.md](docs/deployment.md) | |
| HTTP OpenAPI | [protocol/openapi.yaml](protocol/openapi.yaml) | Single source of truth for the HTTP surface. |
| WebSocket protocol (FRAMES) | [protocol/FRAMES.md](protocol/FRAMES.md) | |
| Architecture guide | [docs/architecture.md](docs/architecture.md) | Application responsibilities and recovery boundaries. |
| Examples | [examples/](examples/) | Minimal browser (`examples/browser/`) and Node.js (`examples/node/`) chat clients against a live relay. |
| Security guidance | [SECURITY.md](SECURITY.md) | |

## License

[Apache-2.0](LICENSE).
Third-party dependencies keep their original licenses; release binaries include their license files.
See [security guidance](SECURITY.md).
