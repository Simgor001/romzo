import { bytes, hex, unhex, canonical } from "./canonical.js";
import { ed25519 } from "@noble/curves/ed25519.js";

const encoder = new TextEncoder();
const pkcs8Prefix = "302e020100300506032b657004220420";
/** Opaque software keys used only when native Ed25519 is unavailable. */
export interface SoftwareEd25519Key { readonly algorithm: { readonly name: "Ed25519" }; readonly type: "private" | "public" }
/** Web Crypto key structure usable by browser and Node consumers without DOM types. */
export interface RomzoCryptoKey {
  readonly algorithm: { readonly name: string };
  readonly extractable: boolean;
  readonly type: "private" | "public" | "secret";
  readonly usages: ("decrypt" | "deriveBits" | "deriveKey" | "encrypt" | "sign" | "unwrapKey" | "verify" | "wrapKey")[];
}
export type Ed25519Key = RomzoCryptoKey | SoftwareEd25519Key;
const softwareKeys = new WeakMap<Ed25519Key, Uint8Array>();
function softwareKey(type: "private" | "public", data: Uint8Array): SoftwareEd25519Key {
  const key = Object.freeze({ algorithm: Object.freeze({ name: "Ed25519" as const }), type });
  softwareKeys.set(key, data.slice());
  return key;
}
function unsupported(error: unknown): boolean {
  return error instanceof Error && error.name === "NotSupportedError";
}
function requireCrypto(): void {
  if (!globalThis.crypto?.subtle) throw new Error("Romzo requires HTTPS and Web Crypto. Open this link in your browser.");
}

/** An Ed25519 identity: hex public key plus an opaque private key. */
export interface Identity {
  publicKey: string;
  privateKey: Ed25519Key;
}

/** Generate a fresh Ed25519 key pair. Extractable so it can be persisted. */
export async function generateKeyPair(): Promise<Identity> {
  requireCrypto();
  try {
    const keys = (await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    return {
      publicKey: hex(await crypto.subtle.exportKey("raw", keys.publicKey)),
      privateKey: keys.privateKey,
    };
  } catch (error) {
    if (!unsupported(error)) throw error;
    const seed = crypto.getRandomValues(new Uint8Array(32));
    return { publicKey: hex(ed25519.getPublicKey(seed)), privateKey: softwareKey("private", seed) };
  }
}

/** Export a private key as hex (pkcs8). Requires an extractable key. */
export async function exportPrivateKey(privateKey: Ed25519Key): Promise<string> {
  const seed = softwareKeys.get(privateKey);
  if (seed) return pkcs8Prefix + hex(seed);
  return hex(await crypto.subtle.exportKey("pkcs8", privateKey as CryptoKey));
}

/** Re-import a key pair from hex (see exportPrivateKey / Identity.publicKey). */
export async function importKeyPair(
  publicKey: string,
  privateKeyHex: string,
): Promise<Identity> {
  requireCrypto();
  if (!/^(?:[0-9a-f]{2})+$/.test(publicKey) || publicKey.length !== 64)
    throw new Error("invalid public key hex");
  try {
    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      bytes(unhex(privateKeyHex)),
      "Ed25519",
      true,
      ["sign"],
    );
    return { publicKey, privateKey };
  } catch (error) {
    if (!unsupported(error)) throw error;
    if (!new RegExp("^" + pkcs8Prefix + "[0-9a-f]{64}$").test(privateKeyHex)) throw new Error("invalid private key pkcs8");
    const seed = unhex(privateKeyHex.slice(pkcs8Prefix.length));
    if (hex(ed25519.getPublicKey(seed)) !== publicKey) throw new Error("key pair mismatch");
    return { publicKey, privateKey: softwareKey("private", seed) };
  }
}

/** Import a raw (32-byte) public key for signature verification. */
export async function importPublicKey(publicKey: string): Promise<Ed25519Key> {
  requireCrypto();
  if (!/^(?:[0-9a-f]{2})+$/.test(publicKey) || publicKey.length !== 64)
    throw new Error("invalid public key hex");
  try {
    return await crypto.subtle.importKey(
      "raw",
      bytes(unhex(publicKey)),
      "Ed25519",
      false,
      ["verify"],
    );
  } catch (error) {
    if (!unsupported(error)) throw error;
    return softwareKey("public", unhex(publicKey));
  }
}

/** Ed25519 signature over (domain + "\0" + canonical(value)), hex-encoded. */
export async function sign(
  identity: Identity,
  value: unknown,
  domain: string,
): Promise<string> {
  const payload = encoder.encode(domain + "\0" + canonical(value));
  const seed = softwareKeys.get(identity.privateKey);
  if (seed) return hex(ed25519.sign(payload, seed));
  return hex(
    await crypto.subtle.sign(
      "Ed25519",
      identity.privateKey as CryptoKey,
      payload,
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
    const raw = softwareKeys.get(key);
    if (raw) return ed25519.verify(unhex(signature), encoder.encode(domain + "\0" + canonical(value)), raw, { zip215: false });
    return await crypto.subtle.verify(
      "Ed25519",
      key as CryptoKey,
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
): Promise<RomzoCryptoKey> {
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
  get(origin: string, salt: string, iterations: number): Promise<RomzoCryptoKey>;
  clear(origin?: string): void;
}

/** Memory-only cache owned by one credential. Replace it when the password changes. */
export function createPasswordKeyCache(password: string): PasswordKeyProvider {
  const keys = new Map<string, { origin: string; key: Promise<RomzoCryptoKey> }>();
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
  key: RomzoCryptoKey,
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
export async function hmacHex(key: RomzoCryptoKey, data: string): Promise<string> {
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
}
