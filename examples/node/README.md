# Node two-peer chat example

A minimal Node.js demo of the romzo SDK: one process hosts a room and joins
it as a guest with two independent SDK instances, then both peers exchange
three messages on the declared `chat` channel and exit.

## Prerequisites

From the repository root:

```sh
npm install        # links the romzo workspace dependency
npm run build      # builds packages/romzo-client (the SDK) once
```

## Start a local relay

The demo needs a running relay. Build and start one from `relay`:

```sh
cd relay
go run . --env-file ../deploy/.env  # copy deploy/.env.example and fill private values
```

For a quick local run you can skip room-creation auth with `CREATE_AUTH=off`
in the environment file. Two more settings matter for this demo:

- `PUBLIC_ORIGIN` must be the relay's own origin, e.g.
  `http://127.0.0.1:9224` (loopback HTTP is for development only).
- For private relays, `CLIENT_ORIGINS` must include the demo's WebSocket origin; public relays may use `*`
  `https://chat.example.local` (the demo injects it via the `ws` factory).

The default listen port is 9224; check readiness with
`curl http://127.0.0.1:9224/healthz`.

## Run

```sh
cd examples/node
node chat.js http://127.0.0.1:9224              # CREATE_AUTH=off relay
node chat.js http://127.0.0.1:9224 the-password # password-protected relay
```

Expected output (abridged):

```
relay: http://127.0.0.1:9224
room:  ABCD2345EF (channels: chat, state)
invite: http://localhost:8080/#ABCD2345EF@127.0.0.1:9224
[host] <- 1a2b3c4d: {"from":"guest","seq":1}
[guest] <- 9f8e7d6c: {"from":"host","seq":1}
...
ok: 6 messages exchanged
```

Exit code is 0 on success, 1 on failure, 2 on usage errors.

The room options declare two channels — `chat` (16 KiB) and `state`
(256 KiB) — and are otherwise opaque (`{ app: "example" }`). The `ws` package
is a development dependency used only to inject the `Origin` request header;
the SDK itself has zero runtime dependencies.
