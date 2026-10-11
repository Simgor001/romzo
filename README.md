# Romzo

中文：[README_zh.md](README_zh.md)

A room-based opaque WebSocket relay and zero-runtime-dependency TypeScript SDK.
The relay handles room registration, signed tickets, channel membership and
bounded forwarding. Applications own encryption, game rules, persistence,
reconnection and history synchronization.

Server release: **1.3.0**. SDK: **@romzo/client 0.2.0**. Wire protocol:
**romzo/v1** (HTTP under `/api/v1`, WebSocket at `/ws`).

## Components

| Component | Path | Description |
| --- | --- | --- |
| Relay server | `apps/relay` | Room registration, signed tickets, channel membership and bounded forwarding. |
| TypeScript SDK | `packages/romzo-client` | Zero-runtime-dependency client SDK. |
| Shared protocol vectors | `protocol/` | Public deterministic test values. |

## Quick start

Requires Node.js 24 and Go 1.26.1. From a clean checkout:

```sh
npm ci
npm run verify
```

## Use

In a browser client, after obtaining a creation password from the user:

```ts
import { createRoom, buildInviteLink, RelaySession } from '@romzo/client';

const room = await createRoom('https://relay.example.com', {
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

Invites use `https://client/#ABCD123XYZ@relay.example.com`: an omitted port is the
service default port 9224, so a relay on 443 must write `@relay.example.com:443`
explicitly. Passwords, private keys and recovery tickets never belong in URLs.

The application consumes and clears the fragment and owns browser-history
recovery. HTTP loopback tests require an explicit SDK exception; production
relay origins require HTTPS.

## Limits

| Limit | Default | Notes |
| --- | --- | --- |
| Options payload | at most 4096 UTF-8 bytes (configurable lower) | Opaque canonical JSON. Applications validate their own rules before obtaining admission. |
| Channels | declared in options, up to 8 | `{"name": "table", "maxFrameBytes": 262144}` entries; undeclared rooms keep the compatibility defaults `discovery`/`lobby`/`game` (16 KiB/16 KiB/256 KiB send limits). |
| Frame delivery | at most once | Send acknowledgments do not confirm that recipients applied an operation. |
| Reconnection | — | The SDK does not automatically reconnect. |

## Development

Verification checks the public file boundary and reachable Git history, SDK
unit tests and types, Go tests and race tests, shared protocol vectors,
`openapi.yaml` as the single source of truth for the HTTP surface with a contract
test covering every endpoint, SDK builds and a real local relay integration.

`npm run build:relay` also builds Linux amd64/arm64 and Windows amd64
binaries, checksums and dependency license notices under apps/relay/dist.

The local integration starts a real Go process, creates and joins a generic
room, authenticates two SDK sessions, forwards messages, renews tickets,
restarts the relay and restores the room. This is **local HTTP/WS evidence**
only; public WSS, browser gameplay, physical devices and multi-instance
acceptance need separate tests.

## Documentation

| Document | Path | Notes |
| --- | --- | --- |
| SDK documentation | [packages/romzo-client/README.md](packages/romzo-client/README.md) | |
| Relay deployment guide | [apps/relay/README.md](apps/relay/README.md) | |
| HTTP OpenAPI | [apps/relay/openapi.yaml](apps/relay/openapi.yaml) | Single source of truth for the HTTP surface. |
| WebSocket protocol (FRAMES) | [apps/relay/FRAMES.md](apps/relay/FRAMES.md) | |
| Architecture guide | [docs/architecture.md](docs/architecture.md) | Application responsibilities and recovery boundaries. |
| Security guidance | [SECURITY.md](SECURITY.md) | |

## License

[Apache-2.0](LICENSE). Third-party dependencies keep their original licenses;
release binaries include their license files. See [security guidance](SECURITY.md).
