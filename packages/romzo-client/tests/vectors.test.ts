import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonical, hash, unhex } from "../src/canonical.js";
import {
  derivePasswordKey,
  hmacHex,
  passwordProof,
  verify,
} from "../src/crypto.js";

// Shared contract vectors verified by the Go and TypeScript implementations.
const vector = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../protocol/relay-v1-vectors.json", import.meta.url)),
    "utf8",
  ),
);

describe("relay-v1 shared vectors", () => {
  it('generic options retain the frozen v1 canonical hash contract', async () => {
    expect(vector.relayVersion).toBe('1.2.0');
    expect(await hash('ru/lobby-options/v1', vector.genericOptions)).toBe(vector.genericOptionsHash);
  });
  it("canonical encoding matches", () => {
    expect(canonical(vector.value)).toBe(vector.canonical);
  });

  it("domain-separated hash matches", async () => {
    expect(await hash(vector.domain, vector.value)).toBe(vector.digest);
  });

  it("PBKDF2 password derivation matches", async () => {
    const key = await derivePasswordKey(
      vector.password,
      unhex(vector.salt),
      vector.iterations,
    );
    expect(
      await hmacHex(key, vector.domain + "\0" + canonical(vector.value)),
    ).toBe(vector.hmac);
  });

  it("creation proof matches", async () => {
    const key = await derivePasswordKey(
      vector.password,
      unhex(vector.salt),
      vector.iterations,
    );
    expect(
      await passwordProof(key, "ru/relay-create/v1", vector.value),
    ).toBe(vector.createProof);
  });

  it("Ed25519 signature verifies against the advertised public key", async () => {
    expect(
      await verify(
        vector.publicKey,
        vector.value,
        vector.domain,
        vector.signature,
      ),
    ).toBe(true);
    // Sanity: wrong domain must fail.
    expect(
      await verify(
        vector.publicKey,
        vector.value,
        "ru/relay-connect/v1",
        vector.signature,
      ),
    ).toBe(false);
  });
});
