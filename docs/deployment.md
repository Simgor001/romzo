# Romzo relay

中文：[deployment_zh.md](deployment_zh.md)

Standalone Go service; no database dependency.
Turnstile verification is optional.

## Run

```sh
cd relay
go run . init > ../deploy/.env.secrets
```

1. Keep .env.secrets private.
2. Copy `deploy/.env.example` to `deploy/.env` and fill its empty secret values locally.
3. Set `PUBLIC_ORIGIN` and `CLIENT_ORIGINS`.
4. From `relay/`, run `go run . --env-file ../deploy/.env`. The environment file is ignored by Git.

The server serves HTTP/WS behind a TLS reverse proxy; PUBLIC_ORIGIN must be a canonical HTTPS origin, except for explicit loopback development.
Do not expose the unencrypted listener publicly.
`relay -version` reports 1.3.0.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `CREATE_AUTH` | — | `password` verifies a PBKDF2 challenge proof; `anonymous`/`off` skip that proof. |
| `TURNSTILE_SECRET` | — (optional) | Independently enforces Turnstile on room creation only; enable it for a public anonymous demo. Idempotent allocation replays do not revalidate a spent Turnstile token. |
| `*_FILE` variants | — | Private secret values may instead be supplied through the corresponding `*_FILE` variables. |
| `AUTH_SALT` | — | Keep stable across normal restarts. Password rotation requires a fresh salt. |
| `TICKET_KEY` | — | Keep stable across normal restarts. Losing or rotating the ticket key invalidates recovery. |

Rooms are memory-only: clients with unexpired recovery tickets restore the room and perform application-layer resynchronization after a restart.

## Docker

From the repository root:

```sh
docker compose -f deploy/compose.yaml pull
docker compose -f deploy/compose.yaml up -d
```

The compose file pulls the versioned GHCR image, with Linux amd64 and arm64 support.
Set `ROMZO_VERSION=v1.3.0` (or another published tag) to choose a release.
The first publication must complete and the package must be public before anonymous pulls work.
Generate secrets using `docker run --rm ghcr.io/simgor001/romzo:v1.3.0 init > deploy/.env.secrets`, then fill `deploy/.env` as described above.

To build locally instead of pulling a release:

```sh
docker compose -f deploy/compose.yaml -f deploy/compose.source.yaml up --build -d
```

- The image runs as an unprivileged user, with a read-only filesystem, dropped capabilities and a loopback host-port mapping.
- It includes CA roots for outbound Turnstile HTTPS.
- Configure your own domain and TLS; `deploy/nginx.conf` is a placeholder example.
- Only configure `TRUSTED_PROXIES` for actual trusted proxy source CIDRs. CORS and WS origins must match exact `CLIENT_ORIGINS`; they do not establish identity.
- The server does not host clients or redirects. A separate static-client configuration example is in `deploy/nginx-same-origin.conf`.

Port convention:

- The relay listens on loopback 9224 by default, and the service default port for invites is 443.
- Terminate TLS on 443 in a reverse proxy in front of the relay (nginx forwards `/ws`, `/api/v1/` and `/.well-known/romzo` to the relay), or listen with TLS directly on 443.
- A relay exposed on any other port must be written explicitly in the invite.
- Cloudflare's proxied (orange-cloud) mode does not support 5-digit ports: with a 5-digit port use DNS-only records with your own certificate; Turnstile is unaffected.

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
| `MAX_OPTIONS_BYTES` | 4096 UTF-8 raw bytes | Default and maximum. Options accept any canonical JSON root, safe integers only. The server checks configHash and host signatures; application clients validate their own rules. |

For a capped demo, consider `MAX_ROOMS=32`, `MAX_CONNECTIONS=128` and both byte rates at 262144.
Queue/frame/payload limits and terminal errors are specified in [FRAMES.md](../protocol/FRAMES.md).

Outbound fanout bandwidth lies outside these limits.

Server release 1.3.0 speaks wire protocol `romzo/v1` with updated domains.
Multi-instance routing and failover require more than a recovery ticket.

## Verify

From the repository root: `npm ci && npm run verify`.
Within `relay/`: `go test ./...` and `go test -race ./...`.
`openapi.yaml` is the single source of truth for the HTTP surface; a contract test checks that it covers every endpoint.
Shared fixtures under `protocol/` contain public deterministic test values; never use them as production secrets.

## Read-only monitoring

`GET /api/v1/metrics` requires an independent persistent `METRICS_KEY` via `Authorization: Bearer <key>`.

- An empty key disables the endpoint (404).
- Missing or incorrect credentials return 401, including on loopback.

`relay init` generates a random 32-byte hexadecimal key along with the other secrets.
Keep it in a private `.env`, or set `METRICS_KEY_FILE` to a private file; do not set both.
Existing installations can generate a key with `openssl rand -hex 32` and save it once.
Configuration is loaded at startup, so changing the key requires a restart.
Room passwords and ticket keys are separate.

```sh
curl -H "Authorization: Bearer $METRICS_KEY" https://relay.example.com/api/v1/metrics
```

Keep the key out of source control, client bundles, URLs and proxy logs.
Use HTTPS for remote access.
Metrics include aggregate counts and authenticated room records; frame and byte counters accumulate since process startup.
Obtain rates by subtracting successive snapshots and dividing by elapsed seconds.
The metrics endpoint is read-only; the management page also offers authenticated room shutdown.

### Node status page

Open `/admin/` on the relay origin and enter the same monitoring key.
The console is static files from `website/admin/` in the repository — a pure front-end for the relay API with no external assets.
Host them however you like; placing them under the relay origin is the simplest because the browser then calls the API same-origin.
It shows aggregate metrics, sampled byte rates, close reasons and the last successful update.
Refresh runs every five seconds; pause, manual refresh and sign out are available.
The key stays in page memory only and is cleared on reload, page exit or sign out.
No browser storage or URL credentials are used.
An unset `METRICS_KEY` disables the metrics endpoint, leaving the page without data.

Authenticated room rankings expose room codes and monitoring IDs.
Rooms include unconfirmed reservations.
Inbound counters count authenticated protocol frames; outbound counters count frames admitted to the send queue, not confirmed delivery.
Counters exclude HTTP, WebSocket framing, TCP and TLS overhead.
These values are operational indicators, not cloud billing usage.
Health probes (`/healthz`, `/readyz`) and discovery (`/.well-known/romzo`) remain public; discovery describes configuration, not current load.
The status page and authenticated metrics API are two views of the same data.

### Room history and resource limits

The metrics response includes the top ten rooms by total inbound plus outbound queued bytes, and the top ten currently connected rooms by cumulative online time.
Online time starts with monitoring and excludes periods with no connections and node downtime.
Records contain IDs, room codes, counts, timestamps, a stop reason and optional creator IPs; no channel names, options, keys or message bodies.
Ended rooms are retained for 24 hours.
A maximum of 5120 records bounds memory; when full, new room allocation fails with 503 until records expire.
Unexpired quota records are never evicted to make room, so restoration cannot reset limits.

```sh
METRICS_HISTORY_FILE=.romzo-history/rooms.json
MAX_ROOM_TRAFFIC_BYTES=1073741824
MAX_ROOM_AGE_SECONDS=21600
```

The example allows 1 GiB of combined traffic and six hours since first observation per room.
Zero disables a limit; existing installations must explicitly configure limits.
Keep the private history file outside published assets (the suggested folder is Git-ignored).
With a history file, records are checkpointed every ten seconds and on graceful shutdown, using an atomic replacement.
A hard crash can lose up to one checkpoint interval.
Invalid history prevents startup; write failures appear in the status page and server stderr.
Do not delete history to restart a limited room.
Without a file, history and quotas are memory-only.
For Docker, mount a writable directory accessible to UID 65532 and point METRICS_HISTORY_FILE there; the root filesystem remains read-only.

A limit cancels all room connections and blocks signed recovery of that room while its record remains valid.
Creating a different room can still consume resources: combine limits with existing per-IP/per-connection rate limits, connection caps and creation authorization or Turnstile.
The relay cannot infer what opaque messages carry — a game, a tunnel or something else.
These counters exclude transport overhead and do not enforce cloud billing budgets.

`NODE_OUTBOUND_BYTES_PER_SECOND` caps aggregate enqueued outbound bytes across all rooms, with a two-second burst.
The deployment example uses 1 MiB/s; zero disables it.
Queues that exceed it are disconnected and counted as node_outbound_rate.
Tune it for application resynchronization peaks.
Limits default to disabled in code for compatibility; copied deployment examples enable them explicitly.

An inbound frame already read can take the room byte counter over its limit by one frame; it is not forwarded after the limit check.
Keep headroom for transport overhead and checkpoint loss when budgeting resources.

### Room controls

`METRICS_KEY` authorizes monitoring and room shutdown. Keep it private.
The authenticated page shows room codes and optional creator IPs.
`RECORD_CREATOR_IP=false` by default; explicitly enable it to record allocation source IPs.
Source addresses follow `TRUSTED_PROXIES` rules.
Restoration never substitutes the restorer's IP for an unknown creator.

POST `/api/v1/admin/rooms/stop` with `{"id":"<monitor ID>"}` and `Authorization: Bearer <METRICS_KEY>` disconnects the room and rejects its currently valid restore tickets.
This does not ban a user or prevent new rooms.
IP filtering belongs to the reverse proxy or VPS firewall.

`METRICS_HISTORY_FILE` persists records and shutdown markers locally.
Ended records expire after 24 hours, longer than the 10/30-minute restore leases; without this file they disappear on restart.
Shutdown applies immediately.
A save failure returns 500 and means restart durability is not guaranteed.
Other history updates checkpoint approximately every 10 seconds.
Do not commit records or keys, include them in images, or publish them.
Enabling IP history requires a user-facing notice of purpose, access and retention.
No monitoring data is sent back to the project; creator IP is not proof of identity.
