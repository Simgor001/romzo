# Romzo 中继

English: [README.md](README.md)

独立的 Go 服务；无游戏引擎、静态客户端、数据库或 WebRTC。

## 运行

```sh
go build -trimpath -o relay .
relay init > .env.secrets
```

1. 妥善保管 .env.secrets。
2. 把 `.env.example` 复制为 `.env`，在本地填入其中的空密钥值。
3. 设置 `PUBLIC_ORIGIN` 与 `CLIENT_ORIGINS`。
4. 运行 `relay --env-file .env`。环境文件已被 Git 忽略。

服务端以 HTTP/WS 形式运行在 TLS 反向代理之后；除显式回环开发外，PUBLIC_ORIGIN 必须是规范的 HTTPS 源站。不要把未加密监听口暴露到公网。`relay -version` 报告 1.2.0。

## 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CREATE_AUTH` | — | `password` 校验 PBKDF2 质询证明（proof）；`anonymous`/`off` 跳过该校验。 |
| `TURNSTILE_SECRET` | —（可选） | 独立地仅在建房时强制 Turnstile；公网匿名演示应启用它。幂等分配重放不会重新校验已消耗的 Turnstile token。 |
| `*_FILE` 变量 | — | 私钥值也可改经对应的 `*_FILE` 变量提供。 |
| `AUTH_SALT` | — | 正常重启期间保持稳定。轮换口令需要新盐。 |
| `TICKET_KEY` | — | 正常重启期间保持稳定。丢失或轮换票据密钥会使恢复失效。 |

房间仅存内存：重启后，持有未过期恢复票据的客户端恢复房间，并执行应用层重同步。

## Docker

在本目录执行：

```sh
docker compose up --build -d
```

- 镜像以非特权用户运行，文件系统只读，capabilities 已收缩，主机端口映射到回环。
- 镜像内含用于出站 Turnstile HTTPS 的 CA 根。
- 自行配置域名与 TLS；`deploy/nginx.conf` 是占位示例。
- 仅为实际可信的代理源 CIDR 配置 `TRUSTED_PROXIES`。CORS 与 WS 源站必须与 `CLIENT_ORIGINS` 精确匹配，它们不建立身份。
- 服务端不托管客户端或重定向。单独的静态客户端同源配置示例见 `deploy/nginx-same-origin.conf`。

端口约定：中继默认监听 9224；TLS 可由 9224 前的反向代理终结，也可由中继监听端直接终结。注意 Cloudflare 橙云代理不支持 5 位端口：使用 5 位端口时请用 DNS-only 记录 + 自有证书；Turnstile 不受影响。

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
| `MAX_OPTIONS_BYTES` | 4096 UTF-8 原始字节 | 默认与最大。options 接受任何 canonical JSON 根类型，仅安全整数。服务端核对 configHash 与宿主签名；应用客户端校验游戏规则。 |

受限演示可考虑 `MAX_ROOMS=32`、`MAX_CONNECTIONS=128`，两个字节率均为 262144。队列/帧/负载限制与终端错误见 FRAMES_zh.md。

出站扇出带宽不受此限。

服务端 1.2.0 使用线上协议 `romzo/v1`。多实例路由与故障迁移仅靠恢复票据不够。

## 验证

在仓库根目录：`npm ci && npm run verify`。在本目录内：`go test ./...` 与 `go test -race ./...`。`openapi.yaml` 是 HTTP 面的唯一信源；契约测试校验其端点覆盖。`protocol/` 下的共享夹具均为公开的确定性测试值，不得用作生产密钥。
