# romzo

English: [README.md](README.md)

Romzo 客户端 SDK — 「房间型不透明中继」（room-based opaque WebSocket relay，`romzo/v1` 协议）的独立客户端实现。

使用 Web Crypto 与 WebSocket（HTTPS 浏览器 / Node 24+），缺少原生 Ed25519 时使用 `@noble/curves` 兼容实现。密钥持久化请使用 `exportPrivateKey` 与 `importKeyPair`；兼容密钥是不透明句柄。

## 可选邀请二维码

二维码功能从 `romzo/qr` 导入，不在根入口重新导出；普通 SDK 打包不会带入
生成器或摄像头辅助代码。固定使用零自身依赖的 `qr@0.7.2`，esbuild 压缩加
gzip 实测：生成器 6.5 KiB、软件解码器 16.8 KiB。解码器仅在识别图片或
摄像头软件回退时动态加载。

```ts
import { buildInviteLink } from "romzo";
import { renderInviteQr, scanInviteCamera, readInviteQrFile } from "romzo/qr";
const invite = buildInviteLink(origin, code, "https://game.example/");
const svg = renderInviteQr(invite); // 编码完整邀请，不只编码房间号
const controller = new AbortController();
const address = await scanInviteCamera(video, { signal: controller.signal });
// 检查 address.origin 符合应用的中继策略，再申请 admission。
// 关闭扫描界面时调用 controller.abort()。
// 图片回退：await readInviteQrFile(file)。
```

`renderInviteQr` 输出黑白 SVG，包含四模块留白和不透明白底。
`readInviteQr({width,height,data})` 解码 RGBA 像素，Node 也可使用；
`readInviteQrFile(Blob)` 在浏览器本地识别图片。摄像头优先使用支持 QR 的
原生 `BarcodeDetector`，不可用时使用动态加载的解码器。仅在调用扫描函数时
申请摄像头；成功、取消、超时、异常都停止自有视频轨道，默认 60 秒超时，
优先后置摄像头。摄像头需要 HTTPS／安全上下文；无权限或无设备时可选图片
或手动输入。解析只返回 `{origin,code}`，不跳转二维码里的地址，非房间邀请
会被拒绝；加入前须检查中继。仅本地测试可显式设置 `allowLoopbackHttp:true`，
不代表公网 HTTP 可访问摄像头。

唯一浏览器演示 `website/play.html` 建房后显示二维码，支持扫码／图片加入、
复制邀请和退出后再加入。图片不会上传；浏览器验收使用真实二维码像素与
受控视频帧，不等同于实体手机摄像头扫码验收。

## 可选自动 P2P mesh

`MeshSession` 从 `romzo` 或 `romzo/mesh` 导出，在 `RelaySession` 上叠加
WebRTC，不改变中继协议。房间须声明 `{name: "signal", maxFrameBytes: 16384}`，
加上业务频道合计不超过 8 个：

```ts
import { MeshSession, attachMesh } from "romzo/mesh";
const session = await MeshSession.connect(url, admission, identity,
  { autoReconnect: { signedDescriptor } },
  { signedDescriptor, rtcConfig: { iceServers: [{ urls: "stun:your-stun.example" }] },
    onPath: (peer, path) => console.log(peer, path) });
await session.subscribe("chat");
await session.send("chat", { seq: 1, text: "你好" });
// 已有中继会话：await attachMesh(relay, identity, {signedDescriptor})。
```

附加时校验描述符签名、配置哈希、冻结的 `relay.roomBinding`
（`origin/code/instance/digest`）与签名身份。signal 订阅成功即可返回，不等待 RTC。
一个 relay 只能附加一个 mesh；成功后 mesh 管理其生命周期。附加失败只清理
本次监听和订阅，不关闭调用方的 relay；`connect` 失败会关闭自己新建的 relay。

完整代理 `id/key/joinSeq/roomBinding`、`on/off`、订阅／取消订阅、发送、名册、
keepalive、`currentRecovery` 和关闭。`path(peer)` 返回 `relay/connecting/rtc`，
未知成员返回 null，`onPath` 通知变化。RTC 可以经过 TURN，不能把角标解释为网络直连。
signal 对包装层的事件和名册隐藏，不能经包装层发送、订阅或取消订阅；
`relay` 是显式逃生舱。Node 没有 WebRTC 时仍能加载和附加，使用中继。

**投递契约：**每条消息只选一条路径，不自动重试或重放。存续的单一路径有序、
至多一次；跨路径允许乱序和丢失。中继 `send()` 成功表示服务端 ack，RTC 成功
表示本地入队，都不表示接收方处理完成。应用须实现序号、ack、重排、去重、
缺口检测和历史同步。广播可能部分成功后 reject，已发送副本不撤销、不自动补发。

使用可靠、有序单 DC，封套 `{v:1,channel,value}`。身份元数据绑定 relay 名册，
双方必须订阅业务频道；value 按 UTF-8 JSON 字节数校验频道上限。
完整封套超过协商的 SCTP 上限时走中继。全中继广播只用一个原生广播帧，
混合广播按成员分别投递；排队期间原生广播的接收名册变化则拒绝，避免发给新成员。

**发送预算：**默认最多 128 个排队／在途投递项、合计 1 MiB、等待期限 15 秒。
中继发送与信令共享 32 帧/秒（突发 8 帧）、256 KiB/秒（突发 512 KiB）的令牌
桶；控制消息优先但同样有界。DC 高／低水位为 256／64 KiB，大于高水位的消息
等缓冲为空。

- 队列满则拒绝，不擅自合并或丢弃业务消息；混合广播先预留全部副本容量再分发。
- 可在 mesh 选项中配置 `maxQueuedItems`、`maxQueuedBytes`、`queueTimeoutMs`、
  `relayFramesPerSecond`、`relayFrameBurst`、`relayBytesPerSecond`、
  `relayByteBurst`、`bufferedAmountHighWaterMark` 与 `bufferedAmountLowWaterMark`。
- 单帧超过配置的字节突发容量则拒绝。
- 服务端使用自定义限额时，需相应调低这些预算；预算不包含底层自动
  keepalive、订阅和逃生舱发送，不能保证免疫全部服务端限流。

**信令与信任：**版本化 hello 请求每个 peer 只回应一次，回应不再次回应。
较小的 `(key,peerId)` 唯一发 offer 并分配 generation。offer／answer 使用
`romzo/mesh-sdp/v1` 签名，覆盖房间、双方 peer/key、generation、帧类型与 SDP。
信任 roster key；签名不抵御恶意 relay 替换名册、不隐藏 SDP，也不加密中继业务载荷。
candidate 绑定 generation 和 ICE ufrag，每代最多 64 条／64 KiB。
默认协商超时 10 秒，失败经 1–2 秒退避重试一次；连接成功后重置重试预算，仍未恢复的 peer 对维持中继，直到成员连接变化。
中继掉线立即关闭 PC、拒绝旧目标队列；重连后恢复名册并重新发现。bye 仅尽力发送。

官网 `play.html` 是唯一浏览器演示入口，包含路径角标。新房间声明 signal 并使用
mesh，并要求中继启用持久成员编号（`MEMBER_STATE_FILE`）。缺少 signal 的房间或
未提供成员编号的节点会拒绝连接。运行 `npm run build:website` 和
`npm run dev --prefix website` 可本地预览；正式页面连接 romzo.net，集成测试
仅替换本地中继地址并模拟验证。`npm run test:mesh` 覆盖本机真实 RTC、回退、relay 重启
和 SDK 包消费；公网 NAT、UDP 受限网络与 TURN 候选路径须另行实网验收。
ESM，TypeScript 严格模式。
行为与 Go 参考服务端逐字节兼容（canonical JSON、域分隔哈希/HMAC、Ed25519 签名域），并以 `protocol/relay-v1-vectors.json` 共享测试向量做契约校验。

## 概念

- **房间（room）** 由 10 位房间码标识，房主持 `host` 密钥对房间描述符（descriptor）签名确认。
- **票据（ticket）**：短期 admission 票据（60 秒、单次握手）用于 WebSocket 认证；长期 recovery 票据用于崩溃/重启后恢复房间。
- **通道（channel）**：房间 options 可声明至多 8 个频道（如 `{ "name": "table", "maxFrameBytes": 262144 }`）。
  peer 订阅所声明的名字后即可收发消息。
  成员变化经 join/leave 帧通知，负载经 receive 帧送达。
  options 不带 `channels` 时没有频道；SDK 不提供预置名称。
  中继只校验名字语法与数值边界；频道语义由应用自定。
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

同房所有 peer 必须认同同一份声明：描述符 `configHash` 逐字节覆盖 options。
超过频道声明 `maxFrameBytes` 的 `send` 会被中继以终端错误 `message_bound_or_unsubscribed` 拒绝。

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
const link = buildInviteLink("https://romzo.net", "ABCD123XYZ", "https://game.example.com/");
// https://game.example.com/#ABCD123XYZ/romzo.net
const address = parseInviteHash(new URL(link).hash);
// { origin: "https://romzo.net", code: "ABCD123XYZ" }
```

新邀请使用 `/` 分隔房间号与中继域名；旧的 `@` 邀请仍可解析。

邀请中省略端口 = 服务默认端口 **443**（`DEFAULT_RELAY_PORT`），即由反向代理终结的 HTTPS。
其他端口的中继必须显式写出——`buildInviteLink("https://romzo.net:9224", ...)` 会产出 `#ABCD123XYZ/romzo.net:9224`——否则会被解析回 443。
本地回环开发应始终显式写出端口。

函数不读写 DOM 或历史。
应用消费邀请后应清除地址栏 hash，并自行保留刷新和历史导航状态。
生产邀请隐含 HTTPS。
邀请函数处理本地回环地址时，须显式传入 `{ allowLoopbackHttp: true }` 才允许 http。
口令和恢复票据不得加入邀请。

局域网邀请在不变更房号的前提下扩展 host 位置；`parseInviteHash` 自动识别私网字面量，以 `lan` 候选替代 `origin` 返回：

- `#ABCD123XYZ/lan` —— 发现形态：`{ code, lan: [] }`；房号即局域网内的会合密钥。
- `#ABCD123XYZ/192.168.1.50,10.0.0.7:7777` —— 直连形态：至多八个私网候选共享一个端口，`{ code, lan: [...] }`。
- `#ABCD123XYZ/192.168.1.50:7777` —— 单个私网字面量自动识别为单候选直连。

候选仅限私网字面量（`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`100.64/10`、`fc00::/7`、`fe80::/10`、`*.local`）；公网 IP 字面量保持中继语义，回环保持中继 origin。 `buildLanInvite(code, hosts, client)` 构建两种形态（`hosts` 为空 = 发现形态），并经解析器往返校验。 `parseInviteText` 可解析完整链接、裸 fragment 和裸 `CODE/host` 文本；带凭据或 query 的链接一律不解析。

## 崩溃恢复

keepalive 应答会自动更新 `session.currentRecovery()`（也可经 `onRecovery` 回调持久化）。恢复流程：

```ts
import { restoreSession, RelaySession } from "romzo";

const restored = await restoreSession(saved.signedDescriptor, saved.recovery, saved.transport);
const session = await RelaySession.connect(wsUrl, restored.admission, restored.transport);
// 重新订阅并做信封层历史同步
```

## 分层 API

私有中继要求 WebSocket Origin 匹配 `CLIENT_ORIGINS`；公共中继配置 `CLIENT_ORIGINS=*` 时也允许非浏览器应用省略 Origin。
可注入 `webSocketFactory` 设置请求头（本仓库集成测试通过应用侧 `ws` 工厂实现，属测试开发依赖）。
SDK 不持久化密钥或历史状态。

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

HTTP 原语和导出的 `relayRequest(origin, path, body?, options?)` 默认每次尝试 10 秒（含读流）、网络故障重试一次、响应上限 16 KiB。
可用 `timeoutMs`、`retries`、`maxResponseBytes` 调整。
用户取消、HTTP 错误、非法 JSON、空响应和超限不重试。
网络重试复用同一序列化请求，不能重新生成 requestId、challenge、proof 或 Turnstile token。

`joinRoom` 在申请 admission 前执行 `verifyDescriptor`：字段白名单、origin/code、configHash、宿主 Ed25519 签名。
`createRoom` 也在确认前验证描述符。
通过 `validateOptions` 回调补充应用规则；SDK 不解读 options 内容。
签名只证明描述符由所载 host 密钥签署；确认邀请发出者身份仍需可信渠道。

```ts
import { createPasswordKeyCache, createRoom } from "romzo";
const passwordKeyProvider = createPasswordKeyCache(creationPassword);
const room = await createRoom(origin, options, { passwordKeyProvider, validateOptions });
// 口令变化：clear() 并丢弃旧实例，创建绑定新口令的实例。
passwordKeyProvider.clear(origin); // 或 clear() 清除全部派生密钥
```

缓存属于单一口令实例，按 origin、salt、iterations 区分。
派生失败自动删除，建房认证失败清除对应 origin。
不持久化口令或派生密钥。
持有缓存实例即持有口令闭包；用毕请清除并释放实例，JavaScript 不保证内存擦除。

## 会话与私钥责任

SDK 默认每 10 秒保活，应用应及时订阅频道；未订阅即 keepalive 会被服务端拒绝。
握手拒绝乱序、重复 challenge、origin/票据绑定不一致。
认证后出现握手帧、非法 JSON、二进制帧或版本错误将关闭并拒绝 pending 请求。

自动重连为 opt-in：在 `RelaySession.connect` 上配置 `autoReconnect: { signedDescriptor, maxAttempts?, baseDelayMs?, maxDelayMs? }`（`signedDescriptor` 必填，缺省直接 throw）。
开启后，传输断开或终端 error 帧触发重连循环：

1. 每次尝试用最新的 `currentRecovery()` 票据加上配置中的签名描述符，经 `restoreSession` 换新 admission 票据，然后重握手、自动重新订阅本会话订阅过的频道。
2. 成功的尝试 emit `reconnect`（带 `{ attempt }`）。
3. 退避从 `baseDelayMs`（默认 1000 ms）指数翻倍至 `maxDelayMs`（默认 15000 ms），带 ±20% 抖动，最多 `maxAttempts` 次（默认 8）。
4. 每次排定尝试都会 emit `reconnecting`（带 `{ attempt, delayMs, error }`）供应用观测。
5. 只有所有尝试失败后才 emit `close`（手动 `close()` 则立即 emit）。

重连期间 `send`/`subscribe` 以 reconnecting 错误立即拒绝、不悬挂；保活定时器暂停，恢复后重启。
不开 `autoReconnect` 行为不变：断开或终端 error 帧直接关闭会话并立即 emit `close`，重连、重新订阅和历史同步由调用方处理。

即使开启 `autoReconnect`，信封层历史同步仍由应用负责：SDK 只恢复传输与频道成员关系，不做缺口检测、去重或消息回补（投递为 at-most-once，见 FRAMES_zh.md）。
恢复票据请经 `onRecovery`/`currentRecovery()` 持久化，签名描述符与私钥同等保管。

`generateKeyPair()` 和 `importKeyPair()` 的私钥是 **extractable**，用于导出和恢复。
私钥导出值、口令及恢复票据不得出现在邀请 URL、遥测、日志或公开测试产物中；由应用选择受保护的持久化方式和清除策略。
调用方可以提供兼容的不可导出 CryptoKey，但这类密钥不能使用 `exportPrivateKey` 导出恢复。

断线后的缺口检测、操作去重及历史同步由应用层负责，投递契约见 FRAMES_zh.md。

频道名称由应用定义；未声明时房间没有频道。

恢复票据回执会等待 `onRecovery` 持久化回调完成；回调失败时请求以 `recovery_persistence_failed` 拒绝，连接仍可使用，不产生未处理的 Promise rejection。

### 稳定成员顺序

Discovery 声明 `stableMemberOrder` 时，`session.joinSeq` 是该身份在当前房间实例中的首次入房编号。`session.members(channel)` 返回不可修改、按编号排序的在线连接列表（`Member`：peer、key、可选 joinSeq）；同公钥多个连接共用编号，在线人数按公钥去重。`session.on("members", (members, {channel}) => ...)` 通知快照和增量变化，包括断线清空、订阅及自动重连后重建。`await session.subscribe(channel)` 返回后可读取完整列表。join/leave/receive 的事件元数据也包含可选 joinSeq。未启用持久编号时显示普通参与者标签，不自行伪造统一顺序。成员编号不等于游戏座位，也不意味着消息可靠送达。

```ts
await session.subscribe("chat");
console.log(session.joinSeq, session.members("chat"));
session.on("members", (_members, {channel}) => {
  if (channel === "chat") renderMembers(session.members("chat"));
});
```

## 浏览器持久身份

`romzo/storage` 使用应用来源下的 IndexedDB，不会自动存储身份，也不与验证页面共享私钥。身份持久化为 opt-in，在 Node 中导入也是安全的。`namespace` 区分同一网站上的不同游戏。默认有效期为 30 分钟，创建房间时把相同期限写入签名配置：

```ts
const options = {
  identityPolicy: { exclusive: true, ttlMs: 30 * 60 * 1000 },
  channels: [{ name: "chat", maxFrameBytes: 16384 }, { name: "signal", maxFrameBytes: 16384 }],
};
```

`openIdentityStore({ namespace, identityTtlMs? })` 返回具有 `list/get/latest/save/select/remove/track/cleanup/close` 的存储对象。记录保存房间绑定、身份标签、密钥、签名描述符、恢复票据及一个 `expiresAt`；没有最后使用时间字段。读写时清理过期记录。有效连接通过保活续期；异常关页使用最后成功保存的期限。浏览器删除网站数据后身份无法恢复。

```ts
import { MeshSession } from "romzo";
import { openIdentityStore, connectPersistentRoom } from "romzo/storage";

const store = await openIdentityStore({ namespace: "my-game" });
const active = await connectPersistentRoom(store, origin, code,
  (admission, identity, signedDescriptor, identityOptions) =>
    MeshSession.connect(origin.replace(/^http/, "ws") + "/ws", admission, identity,
      { ...identityOptions, autoReconnect: { signedDescriptor } }, { signedDescriptor }));
await active.session.subscribe("chat");
await active.session.keepalive();
// 手动退出删除当前身份和恢复资料。
await active.leave();
store.close();
```

加入者遵循房间签名配置的期限。新标签尝试最近成功连接的身份，只有明确返回 `identity_in_use` 才分配新密钥。本标签恢复遇到占用会重试最多 10 秒，之后由应用提供重试或 `{newIdentity:true}` 的入口。标签页标识不证明身份在线；复制标签也会经过中继检查。其他错误直接返回，不自动换身份。

房主创建后用 `store.save` 保存 `host/transport/signedDescriptor/recovery`，通过 `store.track(record).onRecovery` 接入会话选项；连接成功后调用 `bind(session)` 和 `select(record)`。`track.remove()` 会停止写入并删除记录，迟到回调不会复活身份。`flush()` 等待已排队的保存，保存失败会拒绝。自动保活保存失败也会发出 `error`，错误码为 `recovery_persistence_failed`。

中继需要配置 `MEMBER_STATE_FILE`，发现接口须声明 `persistentIdentity`。独占房间的公钥表最多保留两倍连接人数上限，清理过期离线身份后才分配新项；成员编号不会重用。SDK 不保存业务消息，恢复连接不等于恢复游戏历史。

## 内嵌建房验证

Turnstile 建房由中继的 `/api/v1/auth/turnstile` 页面完成。默认 `createRoom` 在页面内打开可取消弹层；也可以传入 `verification: { mount, signal, timeoutMs }` 挂载到自己的窗口。`requestEmbeddedGrant` 提供单独获取 grant 的接口。SDK 校验 iframe 来源、窗口和请求标识，创建凭据绑定房主公钥；取消或超时会清理窗口和监听。

验证域名是中继域名，因此游戏网页不需要登记到 Turnstile 域名白名单。游戏仍需符合中继的 `CLIENT_ORIGINS`；设置了 CSP 的游戏页面应允许 `frame-src` 加载中继来源。OAuth 使用原有流程。Node 调用者仍需显式提供 grant。
