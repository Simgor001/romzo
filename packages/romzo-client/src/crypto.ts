import { bytes, hex, unhex, canonical } from "./canonical.js";

const encoder = new TextEncoder();

/** An Ed25519 identity: hex public key plus a private CryptoKey. */
export interface Identity {
  publicKey: string;
  privateKey: CryptoKey;
}

/** Generate a fresh Ed25519 key pair. Extractable so it can be persisted. */
export async function generateKeyPair(): Promise<Identity> {
  const keys = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return {
    publicKey: hex(await crypto.subtle.exportKey("raw", keys.publicKey)),
    privateKey: keys.privateKey,
  };
}

/** Export a private key as hex (pkcs8). Requires an extractable key. */
export async function exportPrivateKey(privateKey: CryptoKey): Promise<string> {
  return hex(await crypto.subtle.exportKey("pkcs8", privateKey));
}

/** Re-import a key pair from hex (see exportPrivateKey / Identity.publicKey). */
export async function importKeyPair(
  publicKey: string,
  privateKeyHex: string,
): Promise<Identity> {
  if (!/^(?:[0-9a-f]{2})+$/.test(publicKey) || publicKey.length !== 64)
    throw new Error("invalid public key hex");
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    bytes(unhex(privateKeyHex)),
    "Ed25519",
    true,
    ["sign"],
  );
  return { publicKey, privateKey };
}

/** Import a raw (32-byte) public key for signature verification. */
export async function importPublicKey(publicKey: string): Promise<CryptoKey> {
  if (!/^(?:[0-9a-f]{2})+$/.test(publicKey) || publicKey.length !== 64)
    throw new Error("invalid public key hex");
  return crypto.subtle.importKey(
    "raw",
    bytes(unhex(publicKey)),
    "Ed25519",
    false,
    ["verify"],
  );
}

/** Ed25519 signature over (domain + "\0" + canonical(value)), hex-encoded. */
export async function sign(
  identity: Identity,
  value: unknown,
  domain: string,
): Promise<string> {
  return hex(
    await crypto.subtle.sign(
      "Ed25519",
      identity.privateKey,
      encoder.encode(domain + "\0" + canonical(value)),
    ),
  );
}

/** Verify an Ed25519 signature produced by sign(). */
export async function verify(
  publicKey: string,
  value: unknown,
  domain: string,
  signature: string,
): Promise<boolean> {
  try {
    const key = await importPublicKey(publicKey);
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      bytes(unhex(signature)),
      encoder.encode(domain + "\0" + canonical(value)),
    );
  } catch {
    return false;
  }
}

/**
 * PBKDF2-HMAC-SHA256 password derivation, exactly as the relay's
 * password creation auth requires (default 600000 iterations, 32-byte key).
 * Returns an HMAC-SHA256 CryptoKey suitable for passwordProof().
 */
export async function derivePasswordKey(
  password: string,
  salt: Uint8Array,
  iterations = 600000,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: bytes(salt), iterations, hash: "SHA-256" },
    material,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
}

export interface PasswordKeyProvider {
  get(origin: string, salt: string, iterations: number): Promise<CryptoKey>;
  clear(origin?: string): void;
}

/** Memory-only cache owned by one credential. Replace it when the password changes. */
export function createPasswordKeyCache(password: string): PasswordKeyProvider {
  const keys = new Map<string, { origin: string; key: Promise<CryptoKey> }>();
  return {
    get(origin, salt, iterations) {
      const id = JSON.stringify([origin, salt, iterations]);
      const cached = keys.get(id);
      if (cached) return cached.key;
      const key = derivePasswordKey(password, unhex(salt), iterations);
      keys.set(id, { origin, key });
      void key.catch(() => { if (keys.get(id)?.key === key) keys.delete(id); });
      return key;
    },
    clear(origin) {
      for (const [id, entry] of keys) if (origin === undefined || entry.origin === origin) keys.delete(id);
    },
  };
}

/**
 * Password creation proof: HMAC-SHA256 of (domain + "\0" + canonical(value))
 * under the derived password key. Domain is "romzo/relay-create/v1" for room
 * allocation; the helper accepts any domain for forward compatibility.
 */
export async function passwordProof(
  key: CryptoKey,
  domain: string,
  value: unknown,
): Promise<string> {
  return hex(
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(domain + "\0" + canonical(value)),
    ),
  );
}

/** Hex-encoded HMAC-SHA256 of raw string data (not domain-separated). */
export async function hmacHex(key: CryptoKey, data: string): Promise<string> {
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
}
