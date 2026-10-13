# Romzo

English: [README.md](README.md)

基于房间（room）的不透明 WebSocket 中继，附带支持移动浏览器的 TypeScript SDK。中继负责房间注册、签名票据（ticket）、频道（channel）成员管理与有界转发；加密、游戏规则、持久化、重连与历史同步由应用负责。

服务端版本：**1.5.0**。SDK：**romzo 0.4.0**。线上协议（wire protocol）：**romzo/v1**（HTTP 位于 `/api/v1`，WebSocket 位于 `/ws`）。

## 组件

1.5.0 新增：

- 容器负载下保持连接活性与监控时间不变性，
- relay 增加 `-health` 健康探测，镜像内建 HEALTHCHECK，编排器可据此自动回滚。

1.4.0 新增：

- 可插拔建房真人校验——`CREATE_AUTH=turnstile`、`oauth` 或组合 `turnstile+oauth`——统一兑换为 relay 签名、一次性、绑定建房公钥的 grant，
- Turnstile 校验固定 siteverify 的 hostname，
- 内置通用 OAuth2 客户端（GitHub、itch.io、OIDC 提供方）签发的 grant 携带登录名作为配额主体，接入 OAuth 的节点即私服；SDK 自动通过验证弹窗完成 token 兑换与登录回跳。

1.3.1 新增：

- 公共节点支持 `CLIENT_ORIGINS=*`，管理访问由 `ADMIN_ORIGINS` 隔离。

| 组件 | 路径 | 说明 |
| --- | --- | --- |
| 中继服务端 | `relay` | 房间注册、签名票据、频道成员管理与有界转发。 |
| TypeScript SDK | `packages/romzo-client` | 带 Ed25519 兼容实现的客户端 SDK。 |
| 协议 | `protocol/` | WebSocket 规范、HTTP OpenAPI 与共享测试向量。 |
| 部署配置 | `deploy/` | Docker、环境模板与反向代理示例。 |
| 文档 | `docs/` | 部署、架构与发布指南。 |

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

邀请格式为 `https://client/#ABCD123XYZ/relay.example.com`：

- 省略端口 = 服务默认端口 443；其他端口的中继必须显式写出，如 `/relay.example.com:9224`。
- 口令、私钥与恢复票据不得进入 URL。

局域网对局不使用中继地址，而是直连候选：`#CODE/lan` 在局域网内按房间码发现房间，`#CODE/host1,host2:port` 则列出至多 8 个共享同一端口的内网候选（见 SDK 的 `buildLanInvite`）。

应用消费并清除 fragment，并负责浏览器历史恢复。SDK 只对回环地址放行 http；生产中继源站必须是 HTTPS。

## 限制

| 限制 | 默认值 | 说明 |
| --- | --- | --- |
| options 大小 | 至多 4096 UTF-8 字节（可配置为更低） | 不透明 canonical JSON。应用须在申请 admission 前自行校验规则。 |
| 频道 | 在 options 中声明，至多 8 个 | 形如 `{"name": "table", "maxFrameBytes": 262144}`；未声明时没有频道，中继不提供默认值。 |
| 帧投递 | 至多一次 | 发送应答（ack）不代表接收方已应用操作。 |
| 重连 | opt-in（`autoReconnect`） | 默认关闭；开启后 SDK 自动重握手并重新订阅频道，信封层历史同步仍由应用负责（见 SDK 文档）。 |

## 开发

`npm run test:docker-load` 构建当前 relay 镜像并在隔离的 Docker 内部网络中打流。
测试使用 2 CPU／256 MiB 的 relay 容器，覆盖 8／32／64 个客户端、持续广播、
慢接收端、超帧率断开及容器重启后的成员恢复。报告保存到
`test-results/docker-load/<时间>/report.md` 和 `report.json`；测试结束只清理本次
创建的容器、网络、临时状态卷，不影响其他服务。此测试不验证公网或浏览器 RTC。

`npm run test:mobile` 使用 Chromium 与 WebKit 手机配置验证体验页。
若要在已连接的 Android 模拟器内使用 Chrome，先执行
`adb -s <设备序列号> shell am set-debug-app --persistent com.android.chrome`，
将环境变量 `ROMZO_ANDROID_SERIAL` 设置为该序列号，再运行 `npm run test:mobile`。
Android 模式运行设备内的浏览器，测试结束后移除临时 `adb reverse` 端口。
两种模式均连接真实本地 Go 中继，Turnstile 使用测试替身；不代表公网验证码或 WSS 验收。
调试完成后执行 `adb -s <设备序列号> shell am clear-debug-app` 清理模拟器的调试设置。

verify 依次检查：

- 公共文件边界与可达 Git 历史，
- SDK 单元测试与类型，
- Go 测试与竞态测试，
- 共享协议向量，
- `openapi.yaml`——HTTP 面的唯一信源，契约测试覆盖每个端点，
- SDK 构建，
- 一次真实本地中继集成。

`npm run build:relay` 额外构建 Linux amd64/arm64 与 Windows amd64 二进制、校验和及依赖许可声明，输出到 dist/relay。

本地集成启动真实 Go 进程，创建并加入通用房间，认证两个 SDK 会话，转发消息，续期票据，重启中继并恢复房间。该集成仅覆盖本地 HTTP/WS；公网 WSS、浏览器环境、真实网络与多实例验收需另行测试。

## 文档

| 文档 | 路径 | 说明 |
| --- | --- | --- |
| SDK 文档 | [packages/romzo-client/README_zh.md](packages/romzo-client/README_zh.md) | |
| 部署指南 | [docs/deployment_zh.md](docs/deployment_zh.md) | |
| HTTP OpenAPI | [protocol/openapi.yaml](protocol/openapi.yaml) | HTTP 面的唯一信源。 |
| WebSocket 协议 | [protocol/FRAMES_zh.md](protocol/FRAMES_zh.md) | |
| 架构指南 | [docs/architecture_zh.md](docs/architecture_zh.md) | 应用职责与恢复边界。 |
| 示例 | [examples/node/](examples/node/) | 直连真实中继的最小 Node.js 聊天客户端；浏览器演示统一使用官网的 [在线体验](website/play.html)。 |
| 安全说明 | [SECURITY_zh.md](SECURITY_zh.md) | |

## 许可

[Apache-2.0](LICENSE)。第三方依赖保留各自许可；发布二进制附带其许可文件。见[安全说明](SECURITY_zh.md)。
