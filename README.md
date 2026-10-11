# Romzo

A room-based opaque WebSocket relay and zero-runtime-dependency TypeScript SDK.
The relay handles room registration, signed tickets, channel membership and
bounded forwarding. Applications own encryption, game rules, persistence,
reconnection and history synchronization.

Server release: **1.2.0**. SDK: **@romzo/client 0.1.0**. Wire protocol:
**ru-relay/v1** (including the existing /_relic/v1 paths and signing domains).

## Develop

Requires Node.js 24 and Go 1.26.1. From a clean checkout:

```sh
npm ci
npm run verify
```

Verification checks the public file boundary and reachable Git history, SDK
unit tests and types, Go tests and race tests, shared protocol vectors,
generated OpenAPI consistency, SDK builds and a real local relay integration.
`npm run build:relay` additionally builds Linux amd64/arm64 and Windows amd64
binaries, checksums and dependency license notices under apps/relay/dist.

## Use

In a browser client, after obtaining a creation password from the user:

```ts
import { createRoom, buildInviteLink, RelaySession } from '@romzo/client';

const room = await createRoom('https://relay.example.com', {
  game: 'example', players: 2, rules: ['draft']
}, { password: creationPassword });
const invite = buildInviteLink(room.descriptor.origin, room.descriptor.code,
  'https://client.example.com/');
const session = await RelaySession.connect(
  room.descriptor.origin.replace(/^http/, 'ws') + '/_relic/v1/ws',
  room.admission, room.transport);
await session.subscribe('game');
```

Build the SDK from this workspace with `npm run build`. See the
[SDK documentation](packages/romzo-client/README.md),
[deployment guide](apps/relay/README.md), [HTTP OpenAPI](apps/relay/openapi.yaml)
and [WebSocket protocol](apps/relay/FRAMES.md). The [architecture guide](docs/architecture.md)
describes application responsibilities and recovery boundaries.

Invites use `https://client/#ABCD123XYZ@relay.example.com`. Passwords, private
keys and recovery tickets never belong in URLs. The application consumes and
clears the fragment and owns browser-history recovery. HTTP loopback tests
require an explicit SDK exception; production relay origins require HTTPS.

## Boundaries

Options are opaque canonical JSON, at most 4096 UTF-8 bytes (configurable
lower). Applications validate their own rules before obtaining admission.
Frames are delivered at most once; send acknowledgments do not confirm that
recipients applied an operation. The SDK does not automatically reconnect.

The local integration starts a real Go process, creates and joins a generic
room, authenticates two SDK sessions, forwards messages, renews tickets,
restarts the relay and restores the room. This is **local HTTP/WS evidence**,
not public WSS, browser gameplay, physical-device or multi-instance acceptance.

## License

[Apache-2.0](LICENSE). Third-party dependencies keep their original licenses;
release binaries include their license files. See [security guidance](SECURITY.md).
