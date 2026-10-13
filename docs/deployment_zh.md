# 部署 Romzo

English: [deployment.md](deployment.md)

Romzo 是一个 Go 中继服务，不需要数据库。下面使用 Docker 从仓库源码构建，
由 nginx 提供 HTTPS 和静态网页。命令在 Linux 服务器的仓库根目录执行。

## 1. 构建镜像并生成配置

安装 Docker 和 Compose，准备域名及 TLS 证书。网站构建和测试需要 Node.js 24+；
运行源码测试还需要 Go，要求见 `relay/go.mod`。首次部署时执行：

```sh
cp -n deploy/.env.example deploy/.env
chmod 600 deploy/.env
docker compose -f deploy/compose.yaml -f deploy/compose.source.yaml build relay
umask 077
docker run --rm romzo-local:dev init > deploy/.env.secrets
```

将 `.env.secrets` 中生成的密钥填入 `deploy/.env`。`init` 只需执行一次；
以后重启或重新构建时，保留这份配置和密钥。

编辑 `deploy/.env`：

| 配置 | 填写方式 |
| --- | --- |
| `PUBLIC_ORIGIN` | 中继的公网地址，例如 `https://relay.example.com`，不带路径。 |
| `CLIENT_ORIGINS` | 公共节点填 `*`；限制访问时填写网页来源，多个来源用逗号分隔。 |
| `ADMIN_ORIGINS` | 管理页面的来源，例如 `https://relay.example.com`，不支持 `*`。 |
| `CREATE_AUTH` | 建房方式，见下方说明。模板使用 `password`。 |
| `AUTH_SALT`、`TICKET_KEY` | 填入初始化结果。保持不变，才能继续使用恢复票据。 |
| `GRANT_KEY` | 填入初始化结果。Turnstile 和 OAuth 建房需要此密钥。 |
| `METRICS_KEY` | 填入初始化结果，用于管理页面；留空则关闭监控和管理接口。 |
| `MEMBER_STATE_FILE` | `/data/members.json`，保存参与者编号，在线体验需要此配置。 |
| `METRICS_HISTORY_FILE` | `/data/rooms.json`，保存流量统计和房间下线记录。 |

来源填写协议、域名及需要的端口，例如 `https://game.example.com` 或
`http://127.0.0.1:7104`，不能带路径。允许网页来源只决定谁能调用接口，
不会免除身份认证或流量限制。

### 选择建房方式

| `CREATE_AUTH` | 还需要填写 |
| --- | --- |
| `password` | `CREATE_PASSWORD`，使用初始化生成的口令。 |
| `anonymous` | 无建房验证。 |
| `turnstile` | `TURNSTILE_SECRET`、`TURNSTILE_SITEKEY`、`GRANT_KEY`。 |
| `oauth` | `OAUTH_PROVIDER`、`OAUTH_CLIENT_ID`、`OAUTH_CLIENT_SECRET`、授权／token／用户信息地址，以及 `GRANT_KEY`。 |
| `turnstile+oauth` | 同时填写 Turnstile 和 OAuth 配置。 |

网站的 `play.html` 使用 Turnstile 建房。部署这个页面时，设置
`CREATE_AUTH=turnstile`，并让组件的 site key 与 `TURNSTILE_SITEKEY` 一致。
若验证组件所在网页的域名与中继域名不同，还要在 `TURNSTILE_HOSTNAMES`
中填写网页域名；Cloudflare 组件配置也必须允许该域名。
若设置 `TURNSTILE_ACTION`，其值应与页面组件的 action 一致。

OAuth 提供方的回调地址填写 `PUBLIC_ORIGIN` 加
`/api/v1/auth/oauth/callback`。可选配置见 [环境变量模板](../deploy/.env.example)。

## 2. 准备数据目录并启动

Compose 把服务器的 `/opt/romzo/data` 挂载到容器的 `/data`。
容器以 UID 65532 运行，需要这个目录的写权限：

```sh
sudo install -d -m 700 -o 65532 -g 65532 /opt/romzo/data
docker compose -f deploy/compose.yaml -f deploy/compose.source.yaml up -d
docker compose -f deploy/compose.yaml -f deploy/compose.source.yaml logs --tail=50 relay
```

看到 `romzo relay ready` 表示服务已启动。监听口映射到服务器的
`127.0.0.1:9224`，不直接暴露到公网。容器根目录只读，状态文件写入 `/data`。

`members.json` 保存身份与参与者编号的对应关系，不保存聊天记录。
`rooms.json` 保存监控计数和下线标记。两个文件不能使用同一路径，
同一份数据目录只供一个 relay 进程使用。文件损坏或不可读时，服务会拒绝启动。

## 3. 配置 HTTPS 和网站

按 [nginx 示例](../deploy/nginx.conf) 修改域名、证书路径和静态文件目录。
反向代理需要转发以下路径到 `http://127.0.0.1:9224`：

- `/.well-known/romzo`
- `/api/v1/`
- `/ws`，保留 WebSocket Upgrade 请求头

relay 只提供 API 和 WebSocket，网页由 nginx 或其他静态服务器提供。
构建网页所需的 SDK：

```sh
npm ci
npm run build:website
```

将整个 `website/` 目录部署到静态文件目录，包括生成的 `website/sdk/`。
使用自己的中继域名时，修改 `website/play.html` 的 `ORIGIN` 和
`website/site.js` 的节点地址；Turnstile site key 位于 `play.html` 的
`ts-widget` 元素。管理页面位于 `website/admin/`。

只在代理可信时填写 `TRUSTED_PROXIES`，值为代理源 IP 的 CIDR。
中继本身使用 HTTP；公网 HTTPS 由反向代理提供。邀请链接使用公网地址，
不要填写容器端口或 `127.0.0.1`。

## 4. 检查部署

先检查服务器本机，再检查公网地址：

```sh
curl -fsS http://127.0.0.1:9224/readyz
curl -fsS https://relay.example.com/.well-known/romzo
```

发现接口应返回正确的 `origin`，以及 `stableMemberOrder: true`。
然后打开 `play.html`，创建房间，用另一个浏览器加入并互发消息。
成员列表和消息作者应显示相同的参与者编号。

| 现象 | 检查位置 |
| --- | --- |
| 节点未启用成员编号 | 检查容器的 `MEMBER_STATE_FILE`。修改 `.env` 后重新执行 Compose `up -d --force-recreate`，单纯重启不会更新环境变量。 |
| `member state write failed` | 检查 `/data` 挂载和 UID 65532 的写权限。 |
| Turnstile 验证失败 | 检查 site key、secret、网页域名和 action 是否对应。 |
| HTTP 正常、WebSocket 连接失败 | 检查 `/ws` 转发、Upgrade 请求头及 `CLIENT_ORIGINS`。 |
| `invalid metrics history` | 检查日志和 `rooms.json`，保留文件以便排查，不要直接删除下线记录。 |

## 日常维护

更新源码并重新构建：

```sh
git pull --ff-only
docker compose -f deploy/compose.yaml -f deploy/compose.source.yaml up -d --build
```

修改 `.env` 后执行：

```sh
docker compose -f deploy/compose.yaml -f deploy/compose.source.yaml up -d --force-recreate
```

备份 `deploy/.env` 和 `/opt/romzo/data`。复制数据文件前先停止 relay，
备份后再启动。不要把这些文件放进网站、镜像或 Git。
更换 `TICKET_KEY` 会使恢复票据失效；丢失成员状态文件后，参与者编号无法恢复。

中继在内存中维护在线房间，不保存消息历史。服务重启后，客户端使用
恢复票据恢复房间，消息历史由应用同步。状态文件不能代替聊天或游戏存档。

直接运行 Go 二进制时，可使用 `--env-file deploy/.env` 加载配置；
将监听地址设为 `127.0.0.1:9224`，并把两个状态文件路径改为服务用户可写的目录。

## 监控和流量限制

打开 `/admin/`，输入 `METRICS_KEY`。管理页面可查看连接、流量、关闭原因
和房间排行，也可下线房间。密钥只保存在页面内存中。
`GET /api/v1/metrics` 使用 `Authorization: Bearer <METRICS_KEY>` 鉴权。
未配置密钥时接口返回 404，错误密钥返回 401。

| 变量 | 不设置时 | 模板值 |
| --- | --- | --- |
| `MAX_ROOMS` | 64 | 64 |
| `MAX_CONNECTIONS` | 512 | 512 |
| `MAX_UNAUTHENTICATED` | 64 | 64 |
| `MAX_ROOM_CONNECTIONS` | 32 | 32 |
| `FRAMES_PER_SECOND` | 每连接 64 帧／秒 | 64 |
| `BYTES_PER_SECOND` | 每连接 1 MiB／秒 | 1048576 |
| `IP_BYTES_PER_SECOND` | 每 IP 入站 1 MiB／秒 | 1048576 |
| `MAX_OPTIONS_BYTES` | 4096 字节 | 4096 |
| `MAX_ROOM_TRAFFIC_BYTES` | 0，不限制 | 1073741824，合计 1 GiB |
| `MAX_ROOM_AGE_SECONDS` | 0，不限制 | 21600，6 小时 |
| `NODE_OUTBOUND_BYTES_PER_SECOND` | 0，不限制 | 1048576，1 MiB／秒 |

帧率和字节率超限会断开连接。房间流量或时长到限会断开该房间的全部连接，
恢复票据不能绕过限额。广播的出站流量按接收人数累加，给同步和重连留出余量。
这些计数是协议字节，不包括 TLS、TCP 等开销。

监控历史每 10 秒及正常关闭时保存一次。房间结束记录保留 24 小时，
最多保存 5120 条。`RECORD_CREATOR_IP` 默认关闭；启用后管理记录包含创建 IP。

## 本地测试

```sh
npm ci
npx playwright install --with-deps chromium
npm run verify
npm run test:docker-load
```

`verify` 检查 SDK、Go／race、真实 HTTP／WS 和浏览器集成。
Docker 打流报告保存在 `test-results/docker-load/`。这些命令检查本机环境；
部署后的域名、证书和验证组件仍需按上面的步骤检查。
