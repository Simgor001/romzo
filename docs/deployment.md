# Deploy Romzo

中文：[deployment_zh.md](deployment_zh.md)

Romzo is a Go relay service with no database. This guide builds the Docker image from the repository; nginx provides HTTPS and the static website. Run all commands from the repository root on a Linux server.

## 1. Build the image and generate secrets

You need Docker and Compose, a domain and a TLS certificate. Website builds and tests need Node.js 24+; source tests also need Go (see `relay/go.mod`).

Initial deployment:

```sh
cp -n deploy/.env.example deploy/.env
chmod 600 deploy/.env
docker compose -f deploy/compose.yaml -f deploy/compose.source.yaml build relay
umask 077
docker run --rm romzo-local:dev init > deploy/.env.secrets
```

Copy the generated values into `deploy/.env`. Run `init` once; keep the same file through rebuilds and restarts.

Edit `deploy/.env`:

| Setting | Value |
| --- | --- |
| `PUBLIC_ORIGIN` | Public relay address, e.g. `https://relay.example.com`, no path. |
| `CLIENT_ORIGINS` | `*` for a public node, or comma-separated web origins to restrict. |
| `ADMIN_ORIGINS` | Management page origin, e.g. `https://relay.example.com`; no wildcard. |
| `CREATE_AUTH` | Room creation method, see below. The template uses `password`. |
| `AUTH_SALT`, `TICKET_KEY` | Generated values. Keep them unchanged or recovery tickets stop working. |
| `GRANT_KEY` | Generated value. Turnstile and OAuth creation both need it. |
| `METRICS_KEY` | Generated value for the management page. Empty disables monitoring and management. |
| `MEMBER_STATE_FILE` | `/data/members.json`, stores participant numbers. Required by the playground. |
| `METRICS_HISTORY_FILE` | `/data/rooms.json`, stores traffic counters and room shutdown records. |

Origins carry scheme and port, e.g. `https://game.example.com` or `http://127.0.0.1:7104`, no path. An allowed origin only decides who may call the API; it replaces neither authentication nor traffic limits.

### Room creation methods

| `CREATE_AUTH` | Also set |
| --- | --- |
| `password` | `CREATE_PASSWORD` (the generated password) |
| `anonymous` | Nothing |
| `turnstile` | `TURNSTILE_SECRET`, `TURNSTILE_SITEKEY`, `GRANT_KEY` |
| `oauth` | `OAUTH_PROVIDER`, `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, authorization/token/user-info URLs, `GRANT_KEY` |
| `turnstile+oauth` | Both sets |

The website's `play.html` creates rooms via Turnstile, so set `CREATE_AUTH=turnstile` and keep the widget site key equal to `TURNSTILE_SITEKEY`. If the widget runs on a different domain from the relay, list it in `TURNSTILE_HOSTNAMES` and allow it in the Cloudflare widget configuration. If you set `TURNSTILE_ACTION`, it must match the widget's action.

The OAuth callback is `PUBLIC_ORIGIN` plus `/api/v1/auth/oauth/callback`. Optional variables are listed in the [environment template](../deploy/.env.example).

## 2. Start the relay

Compose mounts `/opt/romzo/data` at `/data` in the container. The relay runs as UID 65532:

```sh
sudo install -d -m 700 -o 65532 -g 65532 /opt/romzo/data
docker compose -f deploy/compose.yaml -f deploy/compose.source.yaml up -d
docker compose -f deploy/compose.yaml -f deploy/compose.source.yaml logs --tail=50 relay
```

`romzo relay ready` in the log means it is up. The listener maps to `127.0.0.1:9224` on the host, not a public port. The container filesystem is read-only; state goes to `/data`.

`members.json` maps identities to participant numbers and stores no chat. `rooms.json` stores monitoring counters and shutdown markers. The two paths must differ, and one data directory serves one relay process. Corrupt or unreadable state files prevent startup.

## 3. HTTPS and the website

Adapt the [nginx example](../deploy/nginx.conf) with your domain, certificate paths and static directory. Forward these routes to `http://127.0.0.1:9224`:

- `/.well-known/romzo`
- `/api/v1/`
- `/ws`, preserving the WebSocket Upgrade headers

The relay serves only APIs and WebSockets; serve the website with nginx or any static server. Build it (including the SDK):

```sh
npm ci
npm run build:website
```

Copy all of `website/` to the static directory, including the generated `website/sdk/`. For your own relay, change `ORIGIN` in `website/play.html` and the node address in `website/site.js`. The Turnstile site key sits on the `ts-widget` element in `play.html`. Management files live in `website/admin/`.

Set `TRUSTED_PROXIES` only for proxies you trust, as source IP CIDRs. The relay itself speaks HTTP; the reverse proxy provides public HTTPS. Invite links use the public address, never the container port or `127.0.0.1`.

## 4. Check the deployment

```sh
curl -fsS http://127.0.0.1:9224/readyz
curl -fsS https://relay.example.com/.well-known/romzo
```

Discovery must report the correct `origin` and `"stableMemberOrder": true`. Then open `play.html`, create a room, join from a second browser and exchange messages. Member lists and message authors should show matching participant numbers.

| Symptom | Check |
| --- | --- |
| Member numbering disabled | Check the container's `MEMBER_STATE_FILE`. After editing `.env`, run Compose `up -d --force-recreate`; a plain restart does not reload the environment. |
| `member state write failed` | Check the `/data` mount and write permission for UID 65532. |
| Turnstile verification fails | Check site key, secret, widget hostname and action. |
| HTTP works, WebSocket fails | Check `/ws` forwarding, Upgrade headers and `CLIENT_ORIGINS`. |
| `invalid metrics history` | Check logs and `rooms.json`. Keep the file; don't delete shutdown records. |

## Maintenance

Update and rebuild:

```sh
git pull --ff-only
docker compose -f deploy/compose.yaml -f deploy/compose.source.yaml up -d --build
```

After editing `.env`:

```sh
docker compose -f deploy/compose.yaml -f deploy/compose.source.yaml up -d --force-recreate
```

Back up `deploy/.env` and `/opt/romzo/data`: stop the relay, copy, start it again. Keep these files out of the website, images and Git. Changing `TICKET_KEY` invalidates recovery tickets; losing `members.json` loses participant numbering for good.

Rooms live in memory and messages are never persisted. After a restart, clients rejoin with recovery tickets and the application resyncs history — state files are not chat or game saves.

To run the Go binary directly, load configuration with `--env-file deploy/.env`, listen on `127.0.0.1:9224`, and put both state files in a directory writable by the service user.

## Monitoring and traffic limits

Open `/admin/` and enter `METRICS_KEY`. The page shows connections, traffic, close reasons and room rankings, and can shut down a room; the key stays in page memory. `GET /api/v1/metrics` takes `Authorization: Bearer <METRICS_KEY>`. An unset key returns 404, a wrong one 401.

| Variable | If unset | Template value |
| --- | --- | --- |
| `MAX_ROOMS` | 64 | 64 |
| `MAX_CONNECTIONS` | 512 | 512 |
| `MAX_UNAUTHENTICATED` | 64 | 64 |
| `MAX_ROOM_CONNECTIONS` | 32 | 32 |
| `FRAMES_PER_SECOND` | 64 frames/s per connection | 64 |
| `BYTES_PER_SECOND` | 1 MiB/s per connection | 1048576 |
| `IP_BYTES_PER_SECOND` | 1 MiB/s inbound per IP | 1048576 |
| `MAX_OPTIONS_BYTES` | 4096 bytes | 4096 |
| `MAX_ROOM_TRAFFIC_BYTES` | 0 (no limit) | 1073741824 (1 GiB per room) |
| `MAX_ROOM_AGE_SECONDS` | 0 (no limit) | 21600 (six hours) |
| `NODE_OUTBOUND_BYTES_PER_SECOND` | 0 (no limit) | 1048576 (1 MiB/s) |

Frame or byte rate limits drop that connection. Room traffic or age limits drop the whole room; recovery tickets do not bypass them. Broadcast outbound traffic multiplies by the recipient count, so leave headroom for sync and reconnects. Counters cover protocol bytes only, not TLS or TCP overhead.

Monitoring history is written every ten seconds and on graceful shutdown. Ended-room records are kept for 24 hours, up to 5120 entries. `RECORD_CREATOR_IP` defaults to off; enabling it adds creator IPs to management records.

## Local tests

```sh
npm ci
npx playwright install --with-deps chromium
npm run verify
npm run test:docker-load
```

`verify` covers the SDK, Go/race, real HTTP/WS and browser integration. Load-test reports land in `test-results/docker-load/`. Passing locally does not finish the deployment — still check the domain, certificate and verification widget as in section 4.
