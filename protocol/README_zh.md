# 共享协议夹具

English: [README.md](README.md)

`relay-v1-vectors.json` 由 Go 与 TypeScript 测试共同消费。它包含公开的确定性夹具：具名口令 public-test-vector-password、重复的 ab 盐、由 RFC 8032 测试种子 1 派生的哈希与签名。这些绝不能用作部署密钥。Unicode canonical 字节、安全整数处理、哈希/签名域与通用 options 哈希按公共 `romzo/v1` 协议与 `romzo/` 域验证。

构建 SDK 后：`node scripts/generate-vectors.mjs --check` 验证全部向量输出；仅在有意更新夹具时才省略 --check。
