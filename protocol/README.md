# Shared protocol fixtures

`relay-v1-vectors.json` is consumed by Go and TypeScript tests. It contains
public deterministic fixtures: the named public-test-vector-password, a
repeated ab salt, derived hashes and signatures from RFC 8032 test seed 1.
These must never be used as deployment secrets. Unicode canonical bytes,
safe-integer handling, hash/signature domains and generic options hashes
remain compatible with the frozen ru-relay/v1 protocol.

After building the SDK: `node scripts/generate-vectors.mjs --check` verifies
all vector outputs; omit --check only when intentionally updating fixtures.
