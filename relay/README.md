# Relay server

Romzo 的 Go 服务端，只提供 HTTP 与 WebSocket 接口。仓库 `website/admin/` 里有一个在线管理器的静态示例（纯前端，直接调用中继 API），部署与否、如何分发由部署者决定。

- [部署与配置](../docs/deployment_zh.md) · [Deployment guide](../docs/deployment.md)
- [WebSocket 协议](../protocol/FRAMES_zh.md) · [Frame protocol](../protocol/FRAMES.md)
- [HTTP OpenAPI](../protocol/openapi.yaml)

从本目录运行 `go test ./...` 或 `go test -race ./...`。
在仓库根目录运行 `npm run build:relay`，产物输出到 `dist/relay/`。
部署配置位于根目录 `deploy/`；运行密钥和记录不应提交到 Git。
