# 部署 Romzo

English: [deployment.md](deployment.md)

Romzo 是 Go 写的中继服务，不用数据库。下文从源码构建 Docker 镜像，nginx 负责 HTTPS 和静态网页。命令都在 Linux 服务器的仓库根目录执行。

## 1. 构建镜像，生成密钥

准备：Docker 和 Compose、域名、TLS 证书。构建和测试网站需要 Node.js 24+，跑源码测试需要 Go（版本见 `relay/go.mod`）。

首次部署：

```sh
cp -n deploy/.env.example deploy/.env
chmod 600 deploy/.env
docker compose -f deploy/compose.yaml -f deploy/compose.source.yaml build relay
umask 077
docker run --rm romzo-local:dev init > deploy/.env.secrets
```

把 `.env.secrets` 里的值填进 `deploy/.env`。`init` 只跑一次，之后重建、重启都沿用这份配置。

编辑 `deploy/.env`：

| 配置 | 填法 |
| --- | --- |
| `PUBLIC_ORIGIN` | 中继公网地址，如 `https://relay.example.com`，不带路径。 |
| `CLIENT_ORIGINS` | 公共节点填 `*`；要限制就填网页来源，逗号分隔。 |
| `ADMIN_ORIGINS` | 管理页面来源，如 `https://relay.example.com`，不支持 `*`。 |
| `CREATE_AUTH` | 建房方式，见下表。模板用 `password`。 |
| `AUTH_SALT`、`TICKET_KEY` | 填初始化结果。不换值，恢复票据才继续有效。 |
| `GRANT_KEY` | 填初始化结果。Turnstile 和 OAuth 建房都要用。 |
| `METRICS_KEY` | 填初始化结果，管理页面用它登录；留空则关掉监控和管理接口。 |
| `MEMBER_STATE_FILE` | `/data/members.json`，存参与者编号，在线体验需要。 |
| `METRICS_HISTORY_FILE` | `/data/rooms.json`，存流量统计和房间下线记录。 |

来源带协议和端口，如 `https://game.example.com`、`http://127.0.0.1:7104`，不带路径。来源限制只决定谁能调接口，不代替身份认证和流量限制。

### 建房方式

| `CREATE_AUTH` | 还要填 |
| --- | --- |
| `password` | `CREATE_PASSWORD`（初始化生成的口令） |
| `anonymous` | 无 |
| `turnstile` | `TURNSTILE_SECRET`、`TURNSTILE_SITEKEY`、`GRANT_KEY` |
| `oauth` | `OAUTH_PROVIDER`、`OAUTH_CLIENT_ID`、`OAUTH_CLIENT_SECRET`、授权／token／用户信息地址、`GRANT_KEY` |
| `turnstile+oauth` | 两组都填 |

`play.html` 用 Turnstile 建房，部署这个页面就设 `CREATE_AUTH=turnstile`，site key 与 `TURNSTILE_SITEKEY` 一致。组件所在网页的域名与中继不同时，把网页域名填进 `TURNSTILE_HOSTNAMES`，Cloudflare 的组件配置也要放行该域名。设了 `TURNSTILE_ACTION` 就要和页面组件的 action 一致。

OAuth 回调地址是 `PUBLIC_ORIGIN` 加 `/api/v1/auth/oauth/callback`。其余可选变量见 [环境变量模板](../deploy/.env.example)。

## 2. 启动

`/opt/romzo/data` 会挂到容器的 `/data`。容器以 UID 65532 运行：

```sh
sudo install -d -m 700 -o 65532 -g 65532 /opt/romzo/data
docker compose -f deploy/compose.yaml -f deploy/compose.source.yaml up -d
docker compose -f deploy/compose.yaml -f deploy/compose.source.yaml logs --tail=50 relay
```

日志出现 `romzo relay ready` 即启动完成。监听口只映射在 `127.0.0.1:9224`，不公网暴露。容器根目录只读，状态文件写在 `/data`。

`members.json` 存身份和参与者编号的对应关系，不含聊天记录；`rooms.json` 存监控计数和下线标记。两个文件路径不能相同，同一数据目录只给一个 relay 用。文件损坏或读不了，服务会拒启。

## 3. HTTPS 和网站

照 [nginx 示例](../deploy/nginx.conf) 改域名、证书路径、静态目录。反代转发这些路径到 `http://127.0.0.1:9224`：

- `/.well-known/romzo`
- `/api/v1/`
- `/ws`（保留 WebSocket Upgrade 头）

relay 只提供 API 和 WebSocket，网页由 nginx 或别的静态服务器出。构建网页（含 SDK）：

```sh
npm ci
npm run build:website
```

整个 `website/` 目录拷到静态目录，包括生成的 `website/sdk/`。用自己的中继域名时，改 `website/play.html` 的 `ORIGIN` 和 `website/site.js` 的节点地址；Turnstile site key 在 `play.html` 的 `ts-widget` 元素里。管理页面在 `website/admin/`。

只在代理可信时设 `TRUSTED_PROXIES`，值是代理 IP 的 CIDR。中继本身走 HTTP，公网 HTTPS 由反代提供。邀请链接用公网地址，别填容器端口或 `127.0.0.1`。

## 4. 检查

```sh
curl -fsS http://127.0.0.1:9224/readyz
curl -fsS https://relay.example.com/.well-known/romzo
```

发现接口返回的 `origin` 要正确，并带 `"stableMemberOrder": true`。然后开 `play.html` 建房，换个浏览器加入、互发消息，两边成员列表和消息作者的参与者编号应一致。

| 现象 | 排查 |
| --- | --- |
| 节点没启用成员编号 | 看容器 `MEMBER_STATE_FILE`。改 `.env` 后执行 `up -d --force-recreate`，只重启不生效。 |
| `member state write failed` | 看 `/data` 挂载和 UID 65532 写权限。 |
| Turnstile 验证失败 | 核对 site key、secret、网页域名、action。 |
| HTTP 通、WebSocket 不通 | 查 `/ws` 转发、Upgrade 头和 `CLIENT_ORIGINS`。 |
| `invalid metrics history` | 查日志和 `rooms.json`。保留文件，别直接删。 |

## 日常维护

更新源码并重建：

```sh
git pull --ff-only
docker compose -f deploy/compose.yaml -f deploy/compose.source.yaml up -d --build
```

改 `.env` 后：

```sh
docker compose -f deploy/compose.yaml -f deploy/compose.source.yaml up -d --force-recreate
```

备份 `deploy/.env` 和 `/opt/romzo/data`：先停 relay，复制完再启动。别把这些文件放进网站、镜像或 Git。换 `TICKET_KEY` 会让恢复票据失效；`members.json` 丢了，参与者编号找不回来。

房间在内存里，消息不落盘。重启后客户端凭恢复票据回房，消息历史由应用自己同步——状态文件不是存档。

不用 Docker 就直跑 Go 二进制：`--env-file deploy/.env` 加载配置，监听设 `127.0.0.1:9224`，两个状态文件放到服务用户可写的目录。

## 监控和限制

开 `/admin/`，输 `METRICS_KEY` 登录。页面能看连接数、流量、关闭原因、房间排行，也能下线房间；密钥只存在页面内存里。`GET /api/v1/metrics` 用 `Authorization: Bearer <METRICS_KEY>`，没配密钥返回 404，密钥错误返回 401。

| 变量 | 不设置 | 模板值 |
| --- | --- | --- |
| `MAX_ROOMS` | 64 | 64 |
| `MAX_CONNECTIONS` | 512 | 512 |
| `MAX_UNAUTHENTICATED` | 64 | 64 |
| `MAX_ROOM_CONNECTIONS` | 32 | 32 |
| `FRAMES_PER_SECOND` | 每连接 64 帧／秒 | 64 |
| `BYTES_PER_SECOND` | 每连接 1 MiB／秒 | 1048576 |
| `IP_BYTES_PER_SECOND` | 每 IP 入站 1 MiB／秒 | 1048576 |
| `MAX_OPTIONS_BYTES` | 4096 字节 | 4096 |
| `MAX_ROOM_TRAFFIC_BYTES` | 0（不限） | 1073741824（每房合计 1 GiB） |
| `MAX_ROOM_AGE_SECONDS` | 0（不限） | 21600（6 小时） |
| `NODE_OUTBOUND_BYTES_PER_SECOND` | 0（不限） | 1048576（1 MiB／秒） |

帧率、字节率超限断开该连接。房间流量或时长到限，断开全房，恢复票据绕不过。广播出站流量按接收人数累加，同步和重连要留余量。计数只算协议字节，不含 TLS、TCP 开销。

监控历史每 10 秒和正常关闭时写一次。房间结束记录留 24 小时，最多 5120 条。`RECORD_CREATOR_IP` 默认关，开了管理记录才有创建 IP。

## 本地测试

```sh
npm ci
npx playwright install --with-deps chromium
npm run verify
npm run test:docker-load
```

`verify` 跑 SDK、Go／race、真实 HTTP／WS 和浏览器集成。打流报告在 `test-results/docker-load/`。本地全过也不等于部署完成——域名、证书、验证组件仍要按第 4 节查一遍。

## 持久身份与验证窗口

Play 使用签名房间配置 `identityPolicy: {exclusive:true, ttlMs:1800000}`。保持 `MEMBER_STATE_FILE` 指向可写的持久目录，并随数据备份该文件；成员编号和离线身份期限会在中继重启后恢复。人数上限由 `MAX_ROOM_CONNECTIONS` 控制，每个独占房间保留最多两倍上限的公钥记录。表满会拒绝新身份；不会删除有效离线身份腾位置，也不会重用成员编号。

Turnstile 配置中的域名应是验证页面所在的中继域名。SDK 从发现接口取得 `/api/v1/auth/turnstile`，游戏在弹层 iframe 中加载它。生产不需要把 `127.0.0.1` 或每个接入游戏域名加入 Turnstile 白名单。本地测试使用独立测试配置。

`CLIENT_ORIGINS` 同时控制 HTTP、WebSocket 和验证页面的嵌入来源。公共服务允许任意 HTTP(S) 网页接入时可设为 `*`；限制接入时填写精确来源，包括协议和端口。域名限制不证明项目开源。验证窗口使用服务端 `TURNSTILE_ACTION`，与验证检查保持一致。

Nginx 的 `/api/v1/` 代理已覆盖验证页面。不要给这个页面附加禁止跨来源嵌入的 `X-Frame-Options`；若代理统一设置 CSP，应保留中继返回的 `frame-ancestors` 和 Turnstile 脚本／iframe 许可。游戏自己的 CSP 需要允许 `frame-src` 加载中继。

更新中继与网站产物后，检查发现接口包含 `persistentIdentity`、`maxRoomConnections` 和 `turnstilePage`。浏览器创建房间、刷新后编号不变、新标签获得独立编号、退出后身份清除，是部署后应实际检查的操作。
