# 架构

English: [architecture.md](architecture.md)

Romzo 有两个组件：Go 中继服务与 TypeScript 客户端 SDK。服务管理房间、签名 admission/恢复票据和 WebSocket 频道成员关系，转发应用 JSON 但不解释游戏规则。SDK 实现对应的 HTTP 流程、密码学契约与带认证的 socket 会话。

## 房间生命周期

1. 发现中继的规范源站（canonical origin）、认证策略与限制。
2. 获取建房质询（challenge），分配房间并确认其宿主签名的 descriptor。分配重试复用同一请求体与 request ID。
3. 访客在申请 admission 前核对 descriptor、configHash 与宿主签名。应用提供自己的 options 校验器。
4. 通过 authenticate → challenge → proof → authenticated 认证 socket，然后订阅 discovery、lobby 或 game 频道。
5. keepalive 续期恢复票据。断线或服务重启后，恢复房间、重连、重新订阅并同步应用状态。

房间与消息都在内存中。发送应答只表示中继接受了请求，不代表接收方已应用。投递至多一次。加密、持久化、排序、重试、去重与重连策略由应用层实现。SDK 生成的私钥是可导出的（extractable），应用可导出以用于恢复；存储保护是应用的责任。

## 边界

- options 为不透明 canonical JSON，允许任何 JSON 根类型，上限可配置，最大 4096 UTF-8 字节。数字必须是安全整数。
- 建房口令与可选 Turnstile 校验各自独立地保护分配环节；访客通过房间能力与签名票据加入。源站检查不建立用户身份。
- 帧、队列、连接与每 IP 入站限制约束单个资源使用；出站扇出带宽不在其列。
- TLS 在部署代理处终结。只有显式可信的代理 CIDR 可提供客户端 IP，允许的客户端源站为精确匹配。
- 多服务器恢复还需要共享票据密钥、统一源站与协调的房间路由；多实例一致性与故障迁移仅靠恢复票据不够。

## 兼容性与验证

服务端 1.2.0 与 SDK 0.2.0 使用公共协议 `romzo/v1`，HTTP 接口为 `/api/v1/`，WebSocket 为 `/ws`，发现接口为 `/.well-known/romzo`。密码学域使用 `romzo/` 前缀。服务端与客户端必须使用同一协议，其他协议的票据与签名不能复用。共享夹具在 Go 与 TypeScript 中验证 canonical 编码与密码学输出；`openapi.yaml` 是 HTTP 面的唯一信源，契约测试校验端点覆盖。

`npm run verify` 运行 SDK 与 Go 测试、竞态检查、发布边界检查和一次真实本地集成（经过两个 SDK 客户端，含票据续期与服务重启恢复）。这提供本地 HTTP/WS 证据；公网 WSS 与多实例部署需要单独的验收测试。
