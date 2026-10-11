# Shared protocol fixtures

中文：[README_zh.md](README_zh.md)

`relay-v1-vectors.json` is consumed by Go and TypeScript tests. It contains
public deterministic fixtures: the named public-test-vector-password, a
repeated ab salt, derived hashes and signatures from RFC 8032 test seed 1.
These must never be used as deployment secrets. Unicode canonical bytes,
safe-integer handling, hash/signature domains and generic options hashes
are verified against the public `romzo/v1` protocol and its `romzo/` domains.

After building the SDK: `node scripts/generate-vectors.mjs --check` verifies
all vector outputs; omit --check only when intentionally updating fixtures.
