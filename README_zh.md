# Romzo

English: [README.md](README.md)

基于房间（room）的不透明 WebSocket 中继，附带零运行时依赖的 TypeScript SDK。中继负责房间注册、签名票据（ticket）、频道（channel）成员管理与有界转发；加密、游戏规则、持久化、重连与历史同步由应用负责。

服务端版本：**1.3.0**。SDK：**romzo 0.2.0**。线上协议（wire protocol）：**romzo/v1**（HTTP 位于 `/api/v1`，WebSocket 位于 `/ws`）。

## 组件

| 组件 | 路径 | 说明 |
| --- | --- | --- |
| 中继服务端 | `apps/relay` | 房间注册、签名票据、频道成员管理与有界转发。 |
| TypeScript SDK | `packages/romzo-client` | 零运行时依赖的客户端 SDK。 |
| 共享协议向量 | `protocol/` | 公开的确定性测试值。 |

## 快速开始

需要 Node.js 24 与 Go 1.26.1。全新检出后：

```sh
npm ci
npm run verify
```

## 使用

浏览器客户端中，从用户取得建房口令后：

中继地址可以不带协议写：裸域名默认走 https，回环地址默认走 http。

```ts
import { createRoom, buildInviteLink, RelaySession } from 'romzo';

const room = await createRoom('relay.example.com', {
  game: 'example', players: 2, rules: ['draft'],
  channels: [
    { name: 'table', maxFrameBytes: 262144 },
    { name: 'chat', maxFrameBytes: 16384 },
  ],
}, { password: creationPassword });
const invite = buildInviteLink(room.descriptor.origin, room.descriptor.code,
  'https://client.example.com/');
const session = await RelaySession.connect(
  room.descriptor.origin.replace(/^http/, 'ws') + '/ws',
  room.admission, room.transport);
await session.subscribe('table');
```

在本工作区用 `npm run build` 构建 SDK。

邀请格式为 `https://client/#ABCD123XYZ@relay.example.com`：省略端口 = 服务默认端口 9224，因此 443 中继必须显式写 `@relay.example.com:443`。口令、私钥与恢复票据不得进入 URL。

应用消费并清除 fragment，并负责浏览器历史恢复。HTTP 回环测试需要 SDK 显式例外；生产中继源站必须 HTTPS。

## 限制

| 限制 | 默认值 | 说明 |
| --- | --- | --- |
| options 大小 | 至多 4096 UTF-8 字节（可配置为更低） | 不透明 canonical JSON。应用须在申请 admission 前自行校验规则。 |
| 频道 | 在 options 中声明，至多 8 个 | 形如 `{"name": "table", "maxFrameBytes": 262144}`；未声明时使用兼容默认 `discovery`/`lobby`/`game`（send 上限 16 KiB/16 KiB/256 KiB）。 |
| 帧投递 | 至多一次 | 发送应答（ack）不代表接收方已应用操作。 |
| 重连 | opt-in（`autoReconnect`） | 默认关闭；开启后 SDK 自动重握手并重新订阅频道，信封层历史同步仍由应用负责（见 SDK 文档）。 |

## 开发

verify 检查公共文件边界与可达 Git 历史、SDK 单元测试与类型、Go 测试与竞态测试、共享协议向量、作为 HTTP 面唯一信源且由契约测试校验端点覆盖的 `openapi.yaml`、SDK 构建，以及一次真实本地中继集成。

`npm run build:relay` 额外构建 Linux amd64/arm64 与 Windows amd64 二进制、校验和及依赖许可声明，输出到 apps/relay/dist。

本地集成启动真实 Go 进程，创建并加入通用房间，认证两个 SDK 会话，转发消息，续期票据，重启中继并恢复房间。该集成仅覆盖本地 HTTP/WS；公网 WSS、浏览器实战、物理设备与多实例验收需另行测试。

## 文档

| 文档 | 路径 | 说明 |
| --- | --- | --- |
| SDK 文档 | [packages/romzo-client/README_zh.md](packages/romzo-client/README_zh.md) | |
| 部署指南 | [apps/relay/README_zh.md](apps/relay/README_zh.md) | |
| HTTP OpenAPI | [apps/relay/openapi.yaml](apps/relay/openapi.yaml) | HTTP 面的唯一信源。 |
| WebSocket 协议 | [apps/relay/FRAMES_zh.md](apps/relay/FRAMES_zh.md) | |
| 架构指南 | [docs/architecture_zh.md](docs/architecture_zh.md) | 应用职责与恢复边界。 |
| 示例 | [examples/](examples/) | 直连真实中继的最小浏览器（`examples/browser/`）与 Node.js（`examples/node/`）聊天客户端。 |
| 安全说明 | [SECURITY_zh.md](SECURITY_zh.md) | |

## 许可

[Apache-2.0](LICENSE)。第三方依赖保留各自许可；发布二进制附带其许可文件。见[安全说明](SECURITY_zh.md)。
