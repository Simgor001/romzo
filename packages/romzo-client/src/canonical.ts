const encoder = new TextEncoder();

/** Wrap a byte source in a fresh ArrayBuffer (WebCrypto requires exact types). */
export const bytes = (value: Uint8Array): ArrayBuffer =>
  new Uint8Array(value).buffer;

export function hex(value: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(value), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
}

export function unhex(value: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/.test(value)) throw new Error("invalid hex encoding");
  return Uint8Array.from(value.match(/../g)!, (x) => parseInt(x, 16));
}

export function randomHex(size = 16): string {
  return hex(crypto.getRandomValues(new Uint8Array(size)));
}

// JSON.stringify escapes U+2028/U+2029; the Go canonical encoder emits them
// literally, so undo those two escapes (split/join matches Go's replacer).
function quote(value: string): string {
  return JSON.stringify(value)
    .split("\\u2028")
    .join(" ")
    .split("\\u2029")
    .join(" ");
}

/**
 * Canonical JSON, byte-compatible with the romzo/v1 Go implementation:
 * object keys sorted by UTF-16 code unit, HTML characters not escaped,
 * U+2028/U+2029 literal, and only safe integers accepted.
 */
export function canonical(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "string") return quote(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new Error("canonical value must be a safe integer");
    return String(value);
  }
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => quote(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  }
  throw new Error(
    "canonical value must be integer, string, boolean, array or plain object",
  );
}

function signingBytes(domain: string, value: unknown): Uint8Array<ArrayBuffer> {
  return encoder.encode(domain + "\0" + canonical(value));
}

/** sha256(domain + "\0" + canonical(value)) as lowercase hex. */
export async function hash(domain: string, value: unknown): Promise<string> {
  return hex(
    await crypto.subtle.digest("SHA-256", signingBytes(domain, value)),
  );
}

/** HMAC-SHA256(key, domain + "\0" + canonical(value)) as lowercase hex. */
export async function mac(
  key: Uint8Array,
  domain: string,
  value: unknown,
): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    bytes(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(
    await crypto.subtle.sign("HMAC", cryptoKey, signingBytes(domain, value)),
  );
}
