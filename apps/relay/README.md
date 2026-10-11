# Romzo relay

Standalone Go service; no game engine, static client, database or WebRTC.

## Run

```sh
go build -trimpath -o relay .
relay init > .env.secrets
```

Keep .env.secrets private. Copy .env.example to .env, fill its empty secret
values locally, set PUBLIC_ORIGIN and CLIENT_ORIGINS, then run
`relay --env-file .env`. The environment file is ignored by Git. The server
serves HTTP/WS behind a TLS reverse proxy; PUBLIC_ORIGIN must be a canonical
HTTPS origin, except for explicit loopback development. Do not expose the
unencrypted listener publicly. `relay -version` reports 1.2.0.

`CREATE_AUTH=password` verifies a PBKDF2 challenge proof; anonymous/off skip
that proof. Optional TURNSTILE_SECRET independently enforces Turnstile on room
creation only. Enable it for a public anonymous demo. Idempotent allocation
replays do not revalidate a spent Turnstile token. Private secret values may
instead be supplied through corresponding *_FILE variables.

Keep AUTH_SALT and TICKET_KEY stable across normal restarts. Password rotation
requires a fresh salt. Losing or rotating the ticket key invalidates recovery.
Rooms are memory-only: clients with unexpired recovery tickets restore the
room and perform application-layer resynchronization after a restart.

## Docker / TLS

From this directory: `docker compose up --build -d`. The image runs as an
unprivileged user, with a read-only filesystem, dropped capabilities and a
loopback host-port mapping. It includes CA roots for outbound Turnstile HTTPS.
Configure your own domain and TLS; deploy/nginx.conf is a placeholder example.
Only configure TRUSTED_PROXIES for actual trusted proxy source CIDRs. CORS and
WS origins must match exact CLIENT_ORIGINS; they do not establish identity.
The server does not host clients or redirects. A separate static-client
configuration example is in deploy/nginx-same-origin.conf.

## Limits / contract

Defaults: 64 rooms, 512 connections, 64 unauthenticated connections and 32
connections per room. Authentication deadline 5 seconds; admission lifetime
60 seconds; idle connection limit 45 seconds. New idle rooms expire after
10 minutes; active recovery leases last at most 30 minutes.

Per connection: 64 frames/s, 1 MiB/s with a two-second burst. Per IP aggregate
inbound authenticated WS bytes: IP_BYTES_PER_SECOND (default 1 MiB/s), shared
across rooms/channels/connections; raw JSON whitespace counts. Each connection
also retains its own limit. This is not an outbound fanout bandwidth budget.
For a capped demo, consider MAX_ROOMS=32, MAX_CONNECTIONS=128 and both byte
rates at 262144. Queue/frame/payload limits and terminal errors are specified
in FRAMES.md.

Options accept any canonical JSON root, safe integers only, bounded by
MAX_OPTIONS_BYTES (default and maximum 4096 UTF-8 raw bytes). The server checks
configHash and host signatures; application clients validate game rules.
Server release 1.2.0 retains wire protocol ru-relay/v1 and the signing domains.
A recovery ticket alone does not establish multi-instance routing or failover.

## Verify

From the repository root: `npm ci && npm run verify`. Within this directory:
`go test ./...` and `go test -race ./...`. `relay openapi` emits the generated
HTTP specification; tests compare it with openapi.yaml. Shared fixtures under
protocol/ contain public deterministic test values, not production secrets.
