# romzo

English: [README.md](README.md)

Romzo 客户端 SDK — 「房间型不透明中继」（room-based opaque WebSocket relay，`romzo/v1` 协议）的独立客户端实现。

零运行时依赖；仅使用全局 `crypto.subtle`（WebCrypto）与全局 `WebSocket`（浏览器 / Node 22+）。ESM，TypeScript 严格模式。行为与 Go 参考服务端逐字节兼容（canonical JSON、域分隔哈希/HMAC、Ed25519 签名域），并以 `protocol/relay-v1-vectors.json` 共享测试向量做契约校验。

## 概念

- **房间（room）** 由 10 位房间码标识，房主持 `host` 密钥对房间描述符（descriptor）签名确认。
- **票据（ticket）**：短期 admission 票据（60 秒、单次握手）用于 WebSocket 认证；长期 recovery 票据用于崩溃/重启后恢复房间。
- **通道（channel）**：房间 options 可声明至多 8 个频道（如 `{ "name": "table", "maxFrameBytes": 262144 }`），peer 订阅所声明的名字后即可收发热更新（join/leave/receive 帧）。options 不带 `channels` 时使用兼容默认 `discovery` / `lobby` / `game`（16 KiB / 16 KiB / 256 KiB），SDK 以 `DEFAULT_CHANNELS` 导出。中继只校验名字语法与数值边界；频道语义由应用自定。
- 中继不持久化消息：至多一次投递，客户端信封层负责可靠性（见 FRAMES_zh.md）。

## 建房 → 确认 → 连接（房主）

中继地址可以不带协议写：裸域名默认走 https，回环地址默认走 http。

```ts
import { createRoom, RelaySession } from "romzo";

const roomOptions = {
  players: 4,
  channels: [
    { name: "table", maxFrameBytes: 262144 },
    { name: "chat", maxFrameBytes: 16384 },
  ],
};
const room = await createRoom("relay.example", roomOptions, {
  password: creationPassword,        // relay 为 password 认证时必填
  turnstileToken: turnstileToken,    // Discovery.turnstile 为 true 时必填
});

// 持久化这三样即可在崩溃后恢复（见下文）
//   room.signedDescriptor, room.transport, room.recovery

const url = room.descriptor.origin.replace(/^http/, "ws") + "/ws";
const session = await RelaySession.connect(url, room.admission, room.transport);

session.on("join", (_p, { channel, peer, key }) => { /* peer 公钥 key 可用于端侧加密 */ });
session.on("receive", (value, { channel, peer }) => { /* 他人 send 的负载 */ });
session.on("close", () => { /* 终端 error 帧或传输断开；用 recovery 票据重连 */ });

await session.subscribe("table");
await session.send("table", { hello: "world" });
```

同房所有 peer 必须认同同一份声明：描述符 `configHash` 逐字节覆盖 options，超过频道声明 `maxFrameBytes` 的 `send` 会被中继以终端错误 `message_bound_or_unsubscribed` 拒绝。

## 访客加入

```ts
import { joinRoom, RelaySession } from "romzo";

const joined = await joinRoom("relay.example", "ABCD2345EF");
const url = joined.signedDescriptor.descriptor.origin.replace(/^http/, "ws") + "/ws";
const session = await RelaySession.connect(url, joined.admission, joined.transport);
await session.subscribe("table");
```

## 邀请

```ts
import { buildInviteLink, parseInviteHash } from "romzo";
const link = buildInviteLink("https://romzo.net:9224", "ABCD123XYZ", "https://game.example.com/");
// https://game.example.com/#ABCD123XYZ@romzo.net
const address = parseInviteHash(new URL(link).hash);
// { origin: "https://romzo.net:9224", code: "ABCD123XYZ" }
```

邀请中省略端口 = 服务默认端口 **9224**（`DEFAULT_RELAY_PORT`）。443 中继必须显式写出——`buildInviteLink("https://romzo.net", ...)` 会产出 `#ABCD123XYZ@romzo.net:443`——否则会被解析回 9224。本地回环开发应始终显式写出端口。

函数不读写 DOM 或历史。应用消费邀请后应清除地址栏 hash，并自行保留刷新和历史导航状态。生产邀请隐含 HTTPS；本地 HTTP 客户端连接回环 HTTP 中继须显式传入 `{ allowLoopbackHttp: true }`。口令和恢复票据不得加入邀请。

## 崩溃恢复

keepalive 应答会自动更新 `session.currentRecovery()`（也可经 `onRecovery` 回调持久化）。恢复流程：

```ts
import { restoreSession, RelaySession } from "romzo";

const restored = await restoreSession(saved.signedDescriptor, saved.recovery, saved.transport);
const session = await RelaySession.connect(wsUrl, restored.admission, restored.transport);
// 重新订阅并做信封层历史同步
```

## 分层 API

非浏览器应用也须发送匹配服务端 `CLIENT_ORIGINS` 的 WebSocket Origin；可注入 `webSocketFactory` 设置请求头（本仓库集成测试通过应用侧 `ws` 工厂实现，属测试开发依赖）。SDK 不持久化密钥或历史状态。

| 模块 | 内容 |
|---|---|
| `canonical` | `canonical()`、`hash(domain, v)`、`mac(key, domain, v)`、hex 工具（与 Go 实现逐字节一致） |
| `crypto` | Ed25519 密钥生成/导入导出、`sign`/`verify`、PBKDF2 口令派生（600000 迭代）、`passwordProof` |
| `http` | `discover`、`createChallenge`、`allocate`、`confirmRoom`、`requestAdmission`、`fetchDescriptor`、`restoreRoom`，均支持注入 `fetch`，错误抛 `RelayHttpError(code, status)` |
| `session` | `RelaySession.connect(url, admission, identity, opts)`：四帧握手、`subscribe`/`unsubscribe`/`send`/`keepalive`、事件订阅、自动保活（可关）、`currentRecovery()`、opt-in 自动重连（`autoReconnect`，自动重新订阅已订阅频道，emit `reconnect`/`reconnecting`）；支持注入 WebSocket 工厂 |
| 门面 | `createRoom()` / `joinRoom()` / `restoreSession()` 封装完整 HTTP 序列 |

## 测试

```sh
npm install
npm run check -w romzo   # tsc --noEmit
npm test -w romzo        # vitest（含共享向量契约测试，无真实网络）
npm run build -w romzo
```

## 请求、校验与缓存

HTTP 原语和导出的 `relayRequest(origin, path, body?, options?)` 默认每次尝试 10 秒（含读流）、网络故障重试一次、响应上限 16 KiB；可用 `timeoutMs`、`retries`、`maxResponseBytes` 调整。用户取消、HTTP 错误、非法 JSON、空响应和超限不重试。网络重试复用同一序列化请求，不能重新生成 requestId、challenge、proof 或 Turnstile token。

`joinRoom` 在申请 admission 前执行 `verifyDescriptor`：字段白名单、origin/code、configHash、宿主 Ed25519 签名。`createRoom` 也在确认前验证描述符。通过 `validateOptions` 回调补充应用规则；SDK 不解释桌游 options。签名只证明描述符由所载 host 密钥签署；确认邀请发出者身份仍需可信渠道。

```ts
import { createPasswordKeyCache, createRoom } from "romzo";
const passwordKeyProvider = createPasswordKeyCache(creationPassword);
const room = await createRoom(origin, options, { passwordKeyProvider, validateOptions });
// 口令变化：clear() 并丢弃旧实例，创建绑定新口令的实例。
passwordKeyProvider.clear(origin); // 或 clear() 清除全部派生密钥
```

缓存属于单一口令实例，按 origin、salt、iterations 区分；派生失败自动删除，建房认证失败清除对应 origin。不持久化口令或派生密钥。持有缓存实例即持有口令闭包；用毕请清除并释放实例，JavaScript 不保证内存擦除。

## 会话与私钥责任

SDK 默认每 10 秒保活，应用应及时订阅频道；未订阅即 keepalive 会被服务端拒绝。握手拒绝乱序、重复 challenge、origin/票据绑定不一致；认证后出现握手帧、非法 JSON、二进制帧或版本错误将关闭并拒绝 pending 请求。

自动重连为 opt-in：在 `RelaySession.connect` 上配置 `autoReconnect: { signedDescriptor, maxAttempts?, baseDelayMs?, maxDelayMs? }`（`signedDescriptor` 必填，缺省直接 throw）。开启后，传输断开或终端 error 帧不再直接关闭会话，而是进入重连循环：每次尝试用最新的 `currentRecovery()` 票据加上配置中的签名描述符，经 `restoreSession` 换新 admission 票据，重握手，自动重新订阅本会话订阅过的频道，并 emit `reconnect`（带 `{ attempt }`）。退避从 `baseDelayMs`（默认 1000 ms）指数翻倍至 `maxDelayMs`（默认 15000 ms），带 ±20% 抖动，最多 `maxAttempts` 次（默认 8）；每次排定尝试都会 emit `reconnecting`（带 `{ attempt, delayMs, error }`）供应用观测。只有所有尝试失败后才 emit `close`（手动 `close()` 则立即 emit）。重连期间 `send`/`subscribe` 以 reconnecting 错误立即拒绝、不悬挂；保活定时器暂停，恢复后重启。不开 `autoReconnect` 行为不变：断开或终端 error 帧直接关闭会话并立即 emit `close`，重连、重新订阅和历史同步由调用方处理。

即使开启 `autoReconnect`，信封层历史同步仍由应用负责：SDK 只恢复传输与频道成员关系，不做缺口检测、去重或消息回补（投递为 at-most-once，见 FRAMES.md）。恢复票据请经 `onRecovery`/`currentRecovery()` 持久化，签名描述符与私钥同等保管。

`generateKeyPair()` 和 `importKeyPair()` 的私钥是 **extractable**，用于导出和恢复。私钥导出值、口令及恢复票据不得出现在邀请 URL、遥测、日志或公开测试产物中；由应用选择受保护的持久化方式和清除策略。调用方可以提供兼容的不可导出 CryptoKey，但这类密钥不能使用 `exportPrivateKey` 导出恢复。

断线后的缺口检测、操作去重及历史同步由应用层负责，投递契约见 FRAMES_zh.md。
