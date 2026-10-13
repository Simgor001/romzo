# Deploy Romzo

中文：[deployment_zh.md](deployment_zh.md)

Romzo is a Go relay service with no database dependency. This guide builds the
Docker image from the repository and uses nginx for HTTPS and static files.
Run the commands from the repository root on a Linux server.

## 1. Build the image and prepare configuration

Install Docker and Compose, and prepare a domain and TLS certificate. Website
builds and tests need Node.js 24+. Source tests also need Go; see `relay/go.mod`
for the requirement. For an initial deployment:

```sh
cp -n deploy/.env.example deploy/.env
chmod 600 deploy/.env
docker compose -f deploy/compose.yaml -f deploy/compose.source.yaml build relay
umask 077
docker run --rm romzo-local:dev init > deploy/.env.secrets
```

Copy the generated secrets into `deploy/.env`. Run `init` once. Keep the same
configuration and keys when restarting or rebuilding the service.

| Setting | Value |
| --- | --- |
| `PUBLIC_ORIGIN` | Public relay address, such as `https://relay.example.com`, without a path. |
| `CLIENT_ORIGINS` | `*` for a public node, or comma-separated web origins to restrict access. |
| `ADMIN_ORIGINS` | Management page origin, such as `https://relay.example.com`; no wildcard. |
| `CREATE_AUTH` | Room creation method, described below. The template uses `password`. |
| `AUTH_SALT`, `TICKET_KEY` | Generated values. Preserve them so recovery tickets remain usable. |
| `GRANT_KEY` | Generated value, required for Turnstile and OAuth creation. |
| `METRICS_KEY` | Generated value for management access. Empty disables monitoring and management. |
| `MEMBER_STATE_FILE` | `/data/members.json`, stores participant numbers; required by the playground. |
| `METRICS_HISTORY_FILE` | `/data/rooms.json`, stores traffic counters and room shutdown records. |

Origins include the scheme, hostname and any non-default port, such as `https://game.example.com` or
`http://127.0.0.1:7104`, with no path. Allowing an origin does not bypass
authentication or traffic limits.

### Choose a room creation method

| `CREATE_AUTH` | Additional settings |
| --- | --- |
| `password` | `CREATE_PASSWORD`, using the generated password. |
| `anonymous` | No creation verification. |
| `turnstile` | `TURNSTILE_SECRET`, `TURNSTILE_SITEKEY`, `GRANT_KEY`. |
| `oauth` | `OAUTH_PROVIDER`, `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, authorization/token/user-info URLs, and `GRANT_KEY`. |
| `turnstile+oauth` | Both Turnstile and OAuth settings. |

The website's `play.html` uses Turnstile to create rooms. Set
`CREATE_AUTH=turnstile` and use the same site key in the widget and
`TURNSTILE_SITEKEY`. If the widget runs on a different domain from the relay,
list that domain in `TURNSTILE_HOSTNAMES` and allow it in the Cloudflare widget
configuration. If `TURNSTILE_ACTION` is set, match the widget's action.

Register `PUBLIC_ORIGIN` plus `/api/v1/auth/oauth/callback` as the OAuth callback.
See the [environment template](../deploy/.env.example) for optional settings.

## 2. Prepare storage and start the relay

Compose mounts `/opt/romzo/data` on the server at `/data` in the container.
The relay runs as UID 65532 and needs write access:

```sh
sudo install -d -m 700 -o 65532 -g 65532 /opt/romzo/data
docker compose -f deploy/compose.yaml -f deploy/compose.source.yaml up -d
docker compose -f deploy/compose.yaml -f deploy/compose.source.yaml logs --tail=50 relay
```

`romzo relay ready` confirms startup. The host port is `127.0.0.1:9224`, not a
public listener. The container root filesystem is read-only; state goes in `/data`.

`members.json` maps identities to participant numbers; it does not store chat.
`rooms.json` stores monitoring counters and room shutdown markers. Use separate
paths and only one relay process per data directory. Corrupt or unreadable state
files prevent startup.

## 3. Configure HTTPS and the website

Edit the domain, certificate paths and static directory in the
[nginx example](../deploy/nginx.conf). Forward these routes to
`http://127.0.0.1:9224`:

- `/.well-known/romzo`
- `/api/v1/`
- `/ws`, preserving WebSocket Upgrade headers

The relay serves APIs and WebSockets. Serve the website through nginx or another
static server. Build its SDK assets:

```sh
npm ci
npm run build:website
```

Deploy all of `website/`, including the generated `website/sdk/` directory.
For your own relay, change `ORIGIN` in `website/play.html` and the node address in
`website/site.js`. The Turnstile site key is on the `ts-widget` element in
`play.html`. Management files are in `website/admin/`.

Set `TRUSTED_PROXIES` only for trusted proxy source IP CIDRs. The relay uses HTTP;
the reverse proxy provides public HTTPS. Invite links use the public address,
not the container port or `127.0.0.1`.

## 4. Check the deployment

Check the local listener and then the public address:

```sh
curl -fsS http://127.0.0.1:9224/readyz
curl -fsS https://relay.example.com/.well-known/romzo
```

Discovery should report the correct `origin` and `stableMemberOrder: true`.
Open `play.html`, create a room, join from another browser and exchange messages.
The member list and message authors should show matching participant numbers.

| Symptom | Check |
| --- | --- |
| Member numbering is disabled | Check the container's `MEMBER_STATE_FILE`. After changing `.env`, run Compose `up -d --force-recreate`; restarting alone does not refresh the environment. |
| `member state write failed` | Check the `/data` mount and UID 65532 write permissions. |
| Turnstile verification fails | Check the site key, secret, widget hostname and action. |
| HTTP works but WebSocket fails | Check `/ws` forwarding, Upgrade headers and `CLIENT_ORIGINS`. |
| `invalid metrics history` | Check logs and `rooms.json`. Keep the file for diagnosis rather than deleting shutdown records. |

## Maintenance

Pull and rebuild:

```sh
git pull --ff-only
docker compose -f deploy/compose.yaml -f deploy/compose.source.yaml up -d --build
```

After changing `.env`:

```sh
docker compose -f deploy/compose.yaml -f deploy/compose.source.yaml up -d --force-recreate
```

Back up `deploy/.env` and `/opt/romzo/data`. Stop the relay before copying state
files, then start it again. Keep these files out of the website, images and Git.
Changing `TICKET_KEY` invalidates recovery tickets. Losing member state loses
participant numbering.

The relay keeps active rooms in memory and does not store message history. After
a restart, clients restore rooms using recovery tickets; the application
synchronizes message history. State files are not chat or game saves.

To run a Go binary directly, load configuration with `--env-file deploy/.env`.
Set the listener to `127.0.0.1:9224` and put both state files in a directory
writable by the service user.

## Monitoring and traffic limits

Open `/admin/` and enter `METRICS_KEY` to view connections, traffic, close reasons
and room rankings, or shut down a room. The key stays in page memory.
`GET /api/v1/metrics` requires `Authorization: Bearer <METRICS_KEY>`.
An unset key returns 404; incorrect credentials return 401.

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
| `MAX_ROOM_TRAFFIC_BYTES` | 0, disabled | 1073741824, 1 GiB total |
| `MAX_ROOM_AGE_SECONDS` | 0, disabled | 21600, six hours |
| `NODE_OUTBOUND_BYTES_PER_SECOND` | 0, disabled | 1048576, 1 MiB/s |

Frame and byte rate limits disconnect connections. Room traffic or age limits
disconnect every member of that room; recovery tickets do not bypass the limit.
Broadcast outbound bytes multiply by the recipient count. Leave capacity for
synchronization and reconnection. Counters exclude TLS, TCP and other overhead.

Monitoring history is saved every ten seconds and on graceful shutdown. Ended
room records are retained for 24 hours, up to 5120 records.
`RECORD_CREATOR_IP` is off by default; enabling it adds creator IPs to management
records.

## Local tests

```sh
npm ci
npx playwright install --with-deps chromium
npm run verify
npm run test:docker-load
```

`verify` checks the SDK, Go/race, real HTTP/WS and browser integration. Docker load
reports go in `test-results/docker-load/`. These commands test the local
environment; check the deployed domain, certificate and verification widget
using the steps above.
