# romzo/v1 WebSocket 帧协议

English: [FRAMES.md](FRAMES.md)

本文档是 `relay` WebSocket 面的规范，与 HTTP 面的 OpenAPI 文档（`openapi.yaml`）互补。第三方客户端实现应以本文档 + 共享测试向量（`protocol/relay-v1-vectors.json`）为准，不需要阅读服务端源码。

服务端发行版本为 **1.3.0**；公共 wire 协议为 **romzo/v1**。HTTP 接口使用 `/api/v1/`，WebSocket 使用 `/ws`，密码学域使用 `romzo/` 前缀；服务端与客户端必须使用同一协议。频道由应用通过 `options.channels` 显式声明；中继没有预置的频道名称。

## 邀请链接与房间配置

标准邀请为 `https://<client-origin>/#<10位Crockford房号>@<relay-host[:port]>`，例如 `https://game.example.com/#ABCD123XYZ@romzo.net`。房号大写、不带分隔符；生产中继隐含 HTTPS。省略端口 = 服务默认端口 **9224**；443 中继必须显式写 `:443`（否则会被解析为 9224），本地回环开发应始终显式写出端口。

fragment 不进入 HTTP 请求，客户端解析后通过 `history.replaceState` 清除，并自行保存刷新和历史导航所需的状态。口令、私钥、恢复票据不进入邀请。SDK 的 `buildInviteLink` / `parseInviteHash` 是纯函数，不操作浏览器历史。

只有明确启用的本地开发环境允许 HTTP 回环中继（localhost、127.0.0.1、[::1]）；生产页面不能把省略 scheme 的邀请解释为远程 HTTP。应用侧负责旧邀请兼容、开发地址覆盖及浏览器历史恢复；SDK 纯函数只处理标准邀请格式。

descriptor 的 `options` 是不透明 canonical JSON，允许任何 JSON 根类型；UTF-8 原始 JSON 上限由 `MAX_OPTIONS_BYTES` 指定，默认和最大 4096 字节。现有 canonical 协议只允许安全整数，不能包含小数或超出 JavaScript 安全整数范围的数。服务端核对 configHash，但不解释 players、阵营、计分或 lifecycle；应用必须在申请 admission 前验证自己的规则。

## 频道

房间的频道集合在建房 `options` 的 `channels` 键下声明，至多 8 条，每条形如
`{"name": "table", "maxFrameBytes": 262144}`：

- `name` 须匹配 `^[a-z][a-z0-9-]{0,31}$`，且不可重复；
- `maxFrameBytes` 是该频道 `send` 负载的逐频道上限，取值 256 – 262144（256 KiB）字节（含边界）；
- 声明非法（名字非法、重名、超过 8 个、数值越界）时建房失败并返回 `invalid_allocation`。

未声明 `channels` 时，房间没有频道；空数组也表示没有频道，`channels: null` 无效。订阅未声明的名称会返回 `invalid_channel`。恢复流程使用同一份已签名声明，不补入默认频道。

中继不解读频道语义：只校验名字语法与数值边界。声明存放在 `options` 里，`configHash` 保证同房所有 peer 认同同一份声明。发送时按频道声明的 `maxFrameBytes` 校验；全局 256 KiB 负载上限仍是绝对上界。

## 连接与传输

- 端点：`GET /ws`，WebSocket 文本帧，**不支持二进制帧**。
- 每个帧都是单个 JSON 对象，带 `"v": "romzo/v1"` 版本字段。
- Origin 必须在中继器允许列表内（浏览器场景）；每 IP 有独立令牌桶限流。
- 认证必须在连接后 **5 秒**内完成，超时直接断开（无错误帧）。
- 认证后每 **45 秒**内必须收到任意合法帧，否则断开（发送 `keepalive` 即可保活）。
- 单帧上限 288 KiB；慢写 5 秒断开。

## 握手（四帧）

```
客户端 → {"v","kind":"authenticate","admission": <SignedTicket>}
服务端 → {"v","kind":"challenge","value": {"protocol","origin","ticket": <ticket哈希>,"challenge": <64 hex>}}
客户端 → {"v","kind":"proof","signature": <Ed25519 签名, 128 hex>}
服务端 → {"v","kind":"authenticated","id": <16 hex peer id>}
```

- `admission` 票据由 `POST /rooms`（房主）、`/rooms/{code}/confirm`、`/admissions`（访客）或 `/restore` 签发，60 秒有效，单次握手即作废。
- `proof` 用票据 `key` 对应的 Ed25519 私钥对 challenge 对象签名（域分隔串 `romzo/relay-connect/v1`，见向量）。
- 握手失败一律直接断开，**不返回错误帧**（避免给枚举攻击者反馈）。

## 认证后客户端帧

通用字段：`id` 为必填非空 ≤64 字符的应答关联 ID；`send` 帧可有 `target`（peer id 字符串）。

| kind | 字段 | 语义 |
|---|---|---|
| `subscribe` | `channel` | 订阅房间 options 声明的频道。订阅成功后收到同频道其他成员的 `join`，自己向他人广播 `join` |
| `unsubscribe` | `channel` | 退订；向同频道他人广播 `leave` |
| `send` | `channel`, `value`, `target?` | 转发 `value`（任意 JSON）给同频道成员；`target` 缺省为广播，`target` 必须是已订阅该频道的其他 peer。`value` 必须非空且不超出该频道声明的 `maxFrameBytes`（见「频道」） |
| `keepalive` | — | 续约房间活性（必须先有订阅）；应答中携带新恢复票据 |

## 服务端帧

| kind | 语义 |
|---|---|
| `ack` | 对每个 `subscribe`/`unsubscribe`/`send`/`keepalive` 的应答，回显 `id`；`keepalive` 的应答额外带 `recovery`（签名恢复票据） |
| `error` | 不关闭连接的应用层错误（目前仅 `invalid_target`：`send` 的目标不存在/是自己/未订阅该频道） |
| `error`（终端） | 协议违规，**此帧后连接必断**，见下表 |
| `join` / `leave` | 频道成员变化，带 `channel`、`peer`（id）、`key`（该 peer 的 Ed25519 公钥，用于端侧加密） |
| `receive` | 他人 `send` 的负载，带 `channel`、`peer`、`value`（原样 JSON） |
| `authenticated` / `challenge` | 握手帧，见上 |

## 终端错误帧（断开前必发，除非传输已死）

| error 码 | 触发条件 |
|---|---|
| `invalid_frame_fields` | 缺 `id`、携带 `admission`/`signature`、非 send 帧超 16 KiB 等 |
| `invalid_target_encoding` | `target` 不是非空字符串 |
| `invalid_channel` | 订阅了房间未声明的频道 |
| `message_bound_or_unsubscribed` | 向未订阅频道发送、负载为空或超出该频道声明的上限 |
| `keepalive_without_subscription` | 无订阅时发送 keepalive |
| `unknown_frame_kind` | 其他未知 kind |
| `frame_or_byte_rate` | 触发每连接帧率/字节率或每 IP 聚合字节率限制 |

客户端收到终端错误帧后应使用 `recovery` 票据重连并重同步本地状态；重试采用指数退避。

## 投递语义（可靠性契约）

- **至多一次**：中继不持久化、不重发。TCP + 每 peer FIFO 保证**同一发送者的帧有序、不重复**（在连接存活期内）。
- 断线恢复归客户端信封层处理：关键信封（计分、投票）应带单调序号与对端应用层应答；发现缺口经恢复票据重连后做历史同步。中继不提供 QoS 1/2。
- 房间全部内存态；中继重启后可凭未过期恢复票据恢复房间（`POST /rooms/{code}/restore`）。跨实例恢复还要求共享票据密钥和统一 origin；同一房间的路由、建房分配与故障迁移正确性仍需单独验证。

## 限流（默认，可经服务端配置调整）

每连接：64 帧/秒、1 MiB/秒（令牌桶，突发 2 秒）；写队列 128 帧 / 1 MiB，满则断开该连接；全局队列 64 MiB。

每 IP：认证后的入站 WS 原始 JSON 字节默认 1 MiB/秒，突发 2 秒；`IP_BYTES_PER_SECOND` 可调整。多个房间和频道共用该源 IP 的预算，JSON 空白也计入。每连接限制同时生效。IP 识别只信任 `TRUSTED_PROXIES` 明确列出的代理；出站扇出带宽不受此限。令牌补充使用 Go time 的单调时间分量。
