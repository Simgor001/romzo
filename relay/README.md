# Relay server

Romzo 的 Go 服务端。源码与测试在本目录，管理页面资源在 `admin/`。

- [部署与配置](../docs/deployment_zh.md) · [Deployment guide](../docs/deployment.md)
- [WebSocket 协议](../protocol/FRAMES_zh.md) · [Frame protocol](../protocol/FRAMES.md)
- [HTTP OpenAPI](../protocol/openapi.yaml)

从本目录运行 `go test ./...` 或 `go test -race ./...`。
在仓库根目录运行 `npm run build:relay`，产物输出到 `dist/relay/`。
部署配置位于根目录 `deploy/`；运行密钥和记录不应提交到 Git。
