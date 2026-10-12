# Romzo 中继

English: [deployment.md](deployment.md)

独立的 Go 服务；不依赖数据库，Turnstile 外部校验可按需开启。

## 运行

```sh
cd relay
go run . init > ../deploy/.env.secrets
```

1. 妥善保管 .env.secrets。
2. 把 `deploy/.env.example` 复制为 `deploy/.env`，在本地填入其中的空密钥值。
3. 设置 `PUBLIC_ORIGIN`；公共服务使用 `CLIENT_ORIGINS=*`，私有服务填写允许的网页来源；管理界面单独配置 `ADMIN_ORIGINS`。
4. 在 `relay/` 中运行 `go run . --env-file ../deploy/.env`。环境文件已被 Git 忽略。

模板列出常用和可选配置。连接、帧率和 IP 限流与内置默认值一致；模板中的三项
房间／节点限额仍然启用。Turnstile、可信代理、历史记录文件和创建 IP 记录按需
配置。空密钥仍须填入初始化生成的值，当前不会在启动时自动生成。

服务端以 HTTP/WS 形式运行在 TLS 反向代理之后；除显式回环开发外，PUBLIC_ORIGIN 必须是规范的 HTTPS 源站。不要把未加密监听口暴露到公网。`relay -version` 报告 1.4.0。

## 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CLIENT_ORIGINS` | `PUBLIC_ORIGIN` | `*` 开放任意 HTTP(S) 网页来源；私有部署使用逗号分隔的精确来源（协议、主机、端口，不带路径）。来源开放不跳过身份认证或限流。 |
| `ADMIN_ORIGINS` | `PUBLIC_ORIGIN` | metrics/admin 的独立来源白名单，不允许 `*`，仍须管理 Bearer 密钥。 |
| `CREATE_AUTH` | — | 建房真人校验模式：`password`（PBKDF2 证明）、`anonymous`/`off`（免校验）、`turnstile`、`oauth`，以及组合 `turnstile+oauth`；后三者需要 `GRANT_KEY`。 |
| `TURNSTILE_SECRET` | —（可选） | 启用 Cloudflare Turnstile 校验；要求 `CREATE_AUTH` 含 `turnstile`。siteverify 响应的 hostname 固定为 `PUBLIC_ORIGIN` 的主机名，除非用 `TURNSTILE_HOSTNAMES`（逗号分隔）覆盖；`TURNSTILE_ACTION` 可强制组件 action。客户端经 `/api/v1/verify` 用 token 换取 grant。 |
| `*_FILE` 变量 | — | 私钥值也可改经对应的 `*_FILE` 变量提供。 |
| `AUTH_SALT` | — | 正常重启期间保持稳定。轮换口令需要新盐。 |
| `TICKET_KEY` | — | 正常重启期间保持稳定。丢失或轮换票据密钥会使恢复失效。 |
| `GRANT_KEY` | — | 为建房 grant（turnstile/oauth 校验结果）签名；保持稳定，轮换仅使未使用的 grant 失效。 |
| `TURNSTILE_SITEKEY` | — | 公开 Turnstile site key，经发现文档提供给 SDK 渲染组件；组合模式 `turnstile+oauth` 必填。 |
| `OAUTH_*` | — | 通用 OAuth2/OIDC 客户端（`OAUTH_PROVIDER`、`OAUTH_CLIENT_ID`、`OAUTH_CLIENT_SECRET`、`OAUTH_AUTHORIZE_URL`、`OAUTH_TOKEN_URL`、`OAUTH_USERINFO_URL`，可选 `OAUTH_SCOPES`、`OAUTH_NAME_FIELD` 点路径）。要求 `CREATE_AUTH` 含 `oauth`；需在提供方注册回调地址 `PUBLIC_ORIGIN + /api/v1/auth/oauth/callback`。grant 携带提供方登录名作为主体，因此接入 OAuth 的节点即私服。 |

房间仅存内存：重启后，持有未过期恢复票据的客户端恢复房间，并执行应用层重同步。

升级本次源码后，公共服务可设置 `CLIENT_ORIGINS=*` 并重启中继。此前从其他域名访问管理接口的部署须显式填写 `ADMIN_ORIGINS`；它不再沿用游戏客户端白名单。现有密钥、建房模式和限额应保持原配置。已发布的 1.3.0 镜像尚不包含此更新，应先使用本次源码构建产物，或等待新版本发布。

本次本地验收覆盖 Go 常规/race、SDK、公共/私有模式的真实 HTTP/WS 双客户端及重启恢复。Chromium 的两个不同网页来源已验证跨来源建房、签名握手、双向收发、重启恢复、管理来源隔离与私有模式拒绝；这不代表 romzo.net 已部署，也不代表完整游戏对局通过。

## Docker

在仓库根目录执行：

```sh
docker compose -f deploy/compose.yaml pull
docker compose -f deploy/compose.yaml up -d
```

Compose 直接拉取 GHCR 的版本镜像，支持 Linux amd64 和 arm64。通过
`ROMZO_VERSION=v1.3.0` 选择已发布版本。首次发布完成后，维护者需将镜像包
设为 Public，用户才能匿名拉取。可用
`docker run --rm ghcr.io/simgor001/romzo:v1.4.0 init > deploy/.env.secrets`
生成密钥，再按上文填写 `deploy/.env`。

需要从源码构建时执行：

```sh
docker compose -f deploy/compose.yaml -f deploy/compose.source.yaml up --build -d
```

- 镜像以非特权用户运行，文件系统只读，capabilities 已收缩，主机端口映射到回环。
- 镜像内含用于出站 Turnstile HTTPS 的 CA 根。
- 自行配置域名与 TLS；`deploy/nginx.conf` 是占位示例。
- 仅为实际可信的代理源 CIDR 配置 `TRUSTED_PROXIES`。私有模式的 HTTP/WS 来源必须与 `CLIENT_ORIGINS` 精确匹配；公共模式允许任意 HTTP(S) 来源。来源不建立身份。缺少 Origin 的非浏览器 WS 客户端只在公共模式中允许；浏览器的 `null` 来源仍被拒绝。
- 服务端不托管客户端或重定向。单独的静态客户端同源配置示例见 `deploy/nginx-same-origin.conf`。

端口约定：中继默认监听回环 9224；邀请链接的服务默认端口为 443——TLS 由中继前的反向代理在 443 终结（nginx 将 `/ws`、`/api/v1/` 与 `/.well-known/romzo` 转发给中继），或由中继直接监听 443 并终结 TLS。其他端口的中继必须在邀请中显式写出。注意 Cloudflare 橙云代理不支持 5 位端口：使用 5 位端口时请用 DNS-only 记录 + 自有证书；Turnstile 不受影响。

## 限制

默认值：

| 限制 | 默认值 | 说明 |
| --- | --- | --- |
| 房间数（`MAX_ROOMS`） | 64 | |
| 连接数（`MAX_CONNECTIONS`） | 512 | |
| 未认证连接 | 64 | |
| 每房间连接 | 32 | |
| 认证时限 | 5 秒 | |
| admission 票据有效期 | 60 秒 | |
| 空闲连接上限 | 45 秒 | |
| 新建空闲房间过期 | 10 分钟 | |
| 活跃恢复租约 | 最长 30 分钟 | |

每连接：

| 限制 | 默认值 | 说明 |
| --- | --- | --- |
| 帧率 | 64 帧/秒 | |
| 带宽 | 1 MiB/秒 | 突发 2 秒。 |

每 IP：

| 限制 | 默认值 | 说明 |
| --- | --- | --- |
| 每 IP 聚合入站已认证 WS 字节（`IP_BYTES_PER_SECOND`） | 1 MiB/秒 | 跨房间/频道/连接共享；原始 JSON 空白也计入。每连接限制同时生效。 |

options：

| 限制 | 默认值 | 说明 |
| --- | --- | --- |
| `MAX_OPTIONS_BYTES` | 4096 UTF-8 原始字节 | 默认与最大。options 接受任何 canonical JSON 根类型，仅安全整数。服务端核对 configHash 与宿主签名；应用客户端校验自己的规则。 |

受限演示可考虑 `MAX_ROOMS=32`、`MAX_CONNECTIONS=128`，两个字节率均为 262144。队列/帧/负载限制与终端错误见 [FRAMES_zh.md](../protocol/FRAMES_zh.md)。

出站扇出带宽不受此限。

服务端 1.3.0 使用线上协议 `romzo/v1`。多实例路由与故障迁移仅靠恢复票据不够。

## 验证

在仓库根目录：`npm ci && npm run verify`。在 `relay/` 内：`go test ./...` 与 `go test -race ./...`。`openapi.yaml` 是 HTTP 面的唯一信源；契约测试校验其端点覆盖。`protocol/` 下的共享夹具均为公开的确定性测试值，不得用作生产密钥。

## 只读监控

`GET /api/v1/metrics` 使用独立、持久化的 `METRICS_KEY`，通过
`Authorization: Bearer <key>` 鉴权。不配置密钥时接口关闭（404）；
缺少或错误的密钥返回 401，本机访问也需要鉴权。

`relay init` 会随其他密钥生成一个随机的 32 字节十六进制监控密钥。
将它保存在私有 `.env` 中，或通过 `METRICS_KEY_FILE` 指定私有密钥文件，
两者不能同时设置。已有部署可运行 `openssl rand -hex 32` 生成并保存一次。
每次启动读取同一份配置即可沿用；更换密钥需要重启。
监控密钥与建房口令、票据密钥独立，不要混用。

```sh
curl -H "Authorization: Bearer $METRICS_KEY" https://relay.example.com/api/v1/metrics
```

不要将密钥写入源码、前端、URL 或代理日志。远程访问使用 HTTPS。
接口仅提供汇总计数；帧数和字节数从进程启动起累计，速率可用两次采样的
差值除以时间间隔计算。监控接口只读；管理页面另提供鉴权后的房间下线操作。

### 节点状态页

在中继域名下打开 `/admin/`，输入同一个监控 key。控制台是仓库
`website/admin/` 里的静态文件，纯前端调用中继接口，没有外部资源。
放在中继域名下最省事——浏览器可以直接同源调用接口；怎么分发由部署者决定。
可查看汇总计数、采样字节速率、关闭原因
和最后成功更新时间，每 5 秒刷新一次，可暂停、手动刷新或退出。
key 仅保存在页面内存中，刷新、离开页面或退出后清除，不写入浏览器存储或 URL。
未配置 `METRICS_KEY` 时，监控接口关闭，页面无数据可读。

鉴权后的房间排行展示房间号和独立监控编号。房间数包含未确认的预留房间。
入站计数统计认证后的协议帧；出站计数统计进入发送队列的帧，不保证成功投递。
字节数不包含 HTTP、WebSocket 帧头、TCP、TLS 开销，不能当作云厂商计费流量。
公开的 `/healthz`、`/readyz` 用于健康检查；`/.well-known/romzo` 描述配置，
不反映当前负载。状态页与鉴权监控 API 展示的是同一份统计数据。

### 房间记录与限额

状态页提供流量 Top 10，以及当前有连接的房间在线时长 Top 10。
在线时长从开始监控起累计，不含无连接时间和节点停机时间。
记录独立编号、房间号、计数、时间、下线原因及可选创建 IP；不记录频道名、options、
身份密钥或消息内容。结束的房间保留 24 小时，最多 5120 条；满额时新建房间
返回 503，等待旧记录到期，不通过丢弃尚有效的限额记录来释放容量。

```sh
METRICS_HISTORY_FILE=.romzo-history/rooms.json
MAX_ROOM_TRAFFIC_BYTES=1073741824
MAX_ROOM_AGE_SECONDS=21600
```

上述配置为每房间入站与出站入队合计 1 GiB、从首次监控起最长 6 小时。
设为 0 可关闭相应限制；已有部署必须明确配置限额。历史文件放在私有目录中，
推荐目录已被 Git 忽略。每 10 秒及正常关闭时原子保存一次，异常退出可能丢失
一个保存周期的数据。损坏的历史文件会阻止启动；写入失败会显示在状态页和
控制台。不配置文件时，历史与限额计数只保存在内存中。
Docker 需要挂载 UID 65532 可写的目录，将文件路径指向该目录。

到限后断开该房间的全部连接；有效限额记录存在期间，恢复票据也不能绕过。
创建另一间房仍可消耗资源，需要结合现有 IP／连接限流、连接数上限、建房
鉴权或 Turnstile。无法仅凭不透明的消息判断具体用途（游戏、隧道等），也不能把这些
协议字节统计当作云厂商计费预算。

`NODE_OUTBOUND_BYTES_PER_SECOND` 限制全节点出站入队速率，允许两秒突发。
部署示例为 1 MiB/s，0 为关闭；超限连接会断开并计入 node_outbound_rate。
需要按应用重同步时的峰值调整。代码默认关闭新限额以兼容已有部署，复制部署
示例时才会明确启用这些值。

### 房间管理

`METRICS_KEY` 同时授权监控与房间下线，必须保密。管理页面展示房间号和可选的创建 IP。`RECORD_CREATOR_IP=false` 为默认值；显式启用后，才记录建房请求来源 IP。代理地址按 `TRUSTED_PROXIES` 规则解析。恢复房间不会把恢复者 IP 记为创建 IP；缺少原记录时显示未知。

携带 `Authorization: Bearer <METRICS_KEY>`，向 `/api/v1/admin/rooms/stop` POST `{"id":"<监控编号>"}`，可断开房间内所有连接并拒绝有效恢复票据。管理页面提供“下线”按钮。这不封禁用户，也不阻止新建房间；IP 过滤交给反向代理或 VPS 防火墙。

配置 `METRICS_HISTORY_FILE` 后，记录和下线标记保存在部署者本地。结束记录在 24 小时后清理，长于当前 10／30 分钟恢复票据期限；未配置文件时，重启会清空记录。下线立即生效；保存失败返回 500，此时不能保证重启后仍拒绝恢复。其他历史更新约每 10 秒保存一次。不得将记录或密钥提交到 Git、打包到镜像或公开。启用 IP 历史记录时，应告知用户用途、访问人员和保留期限。监控数据不回传给项目方；创建 IP 不能单独证明个人身份。

## 持久成员编号

新版在线体验页要求启用此功能；未提供成员编号的节点会明确拒绝连接，不再兼容旧版。

设置 `MEMBER_STATE_FILE=/var/lib/romzo/members.json`，并挂载持久、私有且可写的目录；Docker 中目录应归 relay 的 UID 65532 所有。不能与 `METRICS_HISTORY_FILE` 使用同一路径。留空则不启用、不声明 `stableMemberOrder`。文件只保存公钥与编号、房间实例、描述符摘要及保留期限，不保存聊天、私钥或票据；公钥身份信息仍应作为私有运维数据处理。

新身份登记和恢复凭据续期都在确认前同步落盘：私有临时文件、文件 fsync、原子替换，Unix 另同步目录。Windows 验收覆盖进程崩溃恢复；Go 的可移植 Windows 文件接口不保证断电时目录替换的持久性。同一文件只供一个 relay 进程使用。每房间最多登记 4096 个历史身份，最多保留 8192 个房间实例，序列化文件不超过 32 MiB；达到上限拒绝操作，不丢弃编号。首版通过同步全量快照保证确认前持久化，吞吐需要按实际节点测量。

文件不存在时初始化空状态，无法找到原记录的恢复请求会失败；已有文件损坏或不可读则拒绝启动。保留原 TICKET_KEY、服务 origin 和持久卷。仅在房间已不存在且所有已签发恢复票据过期后清理记录。房间描述符与消息仍需客户端恢复及同步。不能把旧备份直接当作在线回滚：旧状态可能缺少已确认编号，使用前必须作废受影响房间及票据。

发布方式：relay、SDK 和网站按当前版本统一升级；排空旧房间，准备持久卷并配置 MEMBER_STATE_FILE，再发布 relay、SDK 和网站。不要给无法追溯原始顺序的旧房间热启用编号。观察 member_capacity、member_state_write_failed、member_state_unavailable 错误及磁盘用量。本地通过不代表公共节点已部署。
