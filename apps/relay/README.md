# Romzo relay

中文：[README_zh.md](README_zh.md)

Standalone Go service; no game engine, static client, database or WebRTC.

## Run

```sh
go build -trimpath -o relay .
relay init > .env.secrets
```

1. Keep .env.secrets private.
2. Copy `.env.example` to `.env` and fill its empty secret values locally.
3. Set `PUBLIC_ORIGIN` and `CLIENT_ORIGINS`.
4. Run `relay --env-file .env`. The environment file is ignored by Git.

The server serves HTTP/WS behind a TLS reverse proxy; PUBLIC_ORIGIN must be a
canonical HTTPS origin, except for explicit loopback development. Do not expose
the unencrypted listener publicly. `relay -version` reports 1.3.0.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `CREATE_AUTH` | — | `password` verifies a PBKDF2 challenge proof; `anonymous`/`off` skip that proof. |
| `TURNSTILE_SECRET` | — (optional) | Independently enforces Turnstile on room creation only; enable it for a public anonymous demo. Idempotent allocation replays do not revalidate a spent Turnstile token. |
| `*_FILE` variants | — | Private secret values may instead be supplied through the corresponding `*_FILE` variables. |
| `AUTH_SALT` | — | Keep stable across normal restarts. Password rotation requires a fresh salt. |
| `TICKET_KEY` | — | Keep stable across normal restarts. Losing or rotating the ticket key invalidates recovery. |

Rooms are memory-only: clients with unexpired recovery tickets restore the room
and perform application-layer resynchronization after a restart.

## Docker

From this directory:

```sh
docker compose up --build -d
```

- The image runs as an unprivileged user, with a read-only filesystem, dropped capabilities and a loopback host-port mapping.
- It includes CA roots for outbound Turnstile HTTPS.
- Configure your own domain and TLS; `deploy/nginx.conf` is a placeholder example.
- Only configure `TRUSTED_PROXIES` for actual trusted proxy source CIDRs. CORS and WS origins must match exact `CLIENT_ORIGINS`; they do not establish identity.
- The server does not host clients or redirects. A separate static-client configuration example is in `deploy/nginx-same-origin.conf`.

Port convention: the relay listens on 9224 by default; terminate TLS on 9224
either in a reverse proxy in front of the relay or in the relay listener
itself. Note that Cloudflare's proxied (orange-cloud) mode does not support
5-digit ports: with a 5-digit port use DNS-only records with your own
certificate; Turnstile is unaffected.

## Limits

Defaults:

| Limit | Default | Notes |
| --- | --- | --- |
| Rooms (`MAX_ROOMS`) | 64 | |
| Connections (`MAX_CONNECTIONS`) | 512 | |
| Unauthenticated connections | 64 | |
| Connections per room | 32 | |
| Authentication deadline | 5 seconds | |
| Admission lifetime | 60 seconds | |
| Idle connection limit | 45 seconds | |
| New idle room expiry | 10 minutes | |
| Active recovery lease | at most 30 minutes | |

Per connection:

| Limit | Default | Notes |
| --- | --- | --- |
| Frame rate | 64 frames/s | |
| Bandwidth | 1 MiB/s | Two-second burst. |

Per IP:

| Limit | Default | Notes |
| --- | --- | --- |
| Aggregate inbound authenticated WS bytes per IP (`IP_BYTES_PER_SECOND`) | 1 MiB/s | Shared across rooms/channels/connections; raw JSON whitespace counts. Each connection also retains its own limit. |

Options:

| Limit | Default | Notes |
| --- | --- | --- |
| `MAX_OPTIONS_BYTES` | 4096 UTF-8 raw bytes | Default and maximum. Options accept any canonical JSON root, safe integers only. The server checks configHash and host signatures; application clients validate game rules. |

For a capped demo, consider `MAX_ROOMS=32`, `MAX_CONNECTIONS=128` and both
byte rates at 262144. Queue/frame/payload limits and terminal errors are
specified in FRAMES.md.

Outbound fanout bandwidth lies outside these limits.

Server release 1.3.0 speaks wire protocol `romzo/v1` with updated
domains. Multi-instance routing and failover require more than a recovery
ticket.

## Verify

From the repository root: `npm ci && npm run verify`. Within this directory:
`go test ./...` and `go test -race ./...`. `openapi.yaml` is the single source
of truth for the HTTP surface; a contract test checks that it covers every
endpoint. Shared fixtures under `protocol/` contain public deterministic test
values; never use them as production secrets.
