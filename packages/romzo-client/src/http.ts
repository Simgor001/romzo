import { API, DISCOVERY_PATH, PROTOCOL } from "./types.js";
import type {
  AdmissionResponse,
  AllocationRequest,
  ChallengeResponse,
  ConfirmResponse,
  Descriptor,
  Discovery,
  RestoreResponse,
  SignedDescriptor,
  SignedTicket,
} from "./types.js";

/** Minimal fetch surface so tests can inject a fake transport. */
export type FetchLike = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export interface HttpOptions {
  fetch?: FetchLike;
  signal?: AbortSignal;
  /** Per-attempt timeout, including reading the response. Default: 10000 ms. */
  timeoutMs?: number;
  /** Additional attempts after transport failures. Default: 1. */
  retries?: number;
  /** Streaming response limit. Default: 16 KiB. */
  maxResponseBytes?: number;
}

/** Error carrying the relay's machine-readable `error` code and HTTP status. */
export class RelayHttpError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(`relay request failed: ${code} (HTTP ${status})`);
    this.name = "RelayHttpError";
  }
}

const loopbackHosts = ["localhost", "127.0.0.1", "::1"];

/**
 * Canonicalize a relay origin. A bare host (`romzo.net`, `romzo.net:9224`)
 * defaults to https, loopback hosts default to http; an explicit scheme is
 * kept as written. Trailing slashes are stripped. Throws on garbage input.
 */
export function normalizeOrigin(origin: string): string {
  const value = origin.trim().replace(/\/+$/, "");
  if (!value) throw new RangeError("invalid relay origin");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value
    : (loopbackHosts.includes(
        (value.startsWith("[") ? value.slice(1, value.indexOf("]"))
          : value.split(":")[0]).toLowerCase(),
      ) ? "http://" : "https://") + value;
  const url = new URL(withScheme);
  if (url.username || url.password || url.search || url.hash ||
      url.pathname !== "/") throw new RangeError("invalid relay origin");
  return url.origin;
}

function resolveFetch(options?: HttpOptions): FetchLike {
  const f = options?.fetch ?? globalThis.fetch;
  if (!f) throw new Error("no fetch implementation available");
  return f.bind(globalThis) as FetchLike;
}

export async function relayRequest<T>(
  origin: string,
  path: string,
  body?: unknown,
  options?: HttpOptions,
): Promise<T> {
  const init: RequestInit = {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
    redirect: "error",
    credentials: "omit",
    cache: "no-store",
  };
  const timeoutMs = options?.timeoutMs ?? 10000;
  const retries = options?.retries ?? 1;
  const maxBytes = options?.maxResponseBytes ?? 16 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
      !Number.isSafeInteger(retries) || retries < 0 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new RangeError("invalid HTTP request limits");
  const fetch = resolveFetch(options);
  origin = normalizeOrigin(origin);
  for (let attempt = 0; ; attempt++) {
    options?.signal?.throwIfAborted();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("relay request timeout", "TimeoutError")), timeoutMs);
    const signal = options?.signal
      ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    // Racing also supports injected transports that do not implement abort.
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const response = await Promise.race([fetch(origin + path, { ...init, signal }), aborted]);
      signal.throwIfAborted();
      reader = response.body?.getReader();
      if (!reader) throw new RelayHttpError("empty_response", response.status || 400);
      const chunks: Uint8Array[] = [];
      let length = 0;
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), aborted]);
        if (done) break;
        length += value.byteLength;
        if (length > maxBytes) throw new RelayHttpError("response_too_large", 400);
        chunks.push(value);
      }
      const joined = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
      let result: unknown;
      try { result = JSON.parse(new TextDecoder().decode(joined)); }
      catch { throw new RelayHttpError("invalid_response", response.ok ? 400 : response.status); }
      if (!response.ok) {
        const error = (result as { error?: unknown } | null)?.error;
        const code = typeof error === "string" && /^[a-z_]{1,64}$/.test(error) ? error : "connection_failed";
        throw new RelayHttpError(code, response.status);
      }
      return result as T;
    } catch (error) {
      if (reader) void reader.cancel().catch(() => {});
      if (error instanceof RelayHttpError || options?.signal?.aborted || attempt >= retries) throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * Discover relay metadata. Validates that the advertised origin and protocol
 * match the requested origin, so a misdirected origin cannot be used silently.
 */
export async function discover(
  origin: string,
  options?: HttpOptions,
): Promise<Discovery> {
  const base = normalizeOrigin(origin);
  const v = await relayRequest<Discovery>(
    base,
    DISCOVERY_PATH,
    undefined,
    options,
  );
  if (v.origin !== base || v.protocol !== PROTOCOL)
    throw new RelayHttpError("protocol_mismatch", 400);
  if (
    v.algorithm !== "PBKDF2-HMAC-SHA256" ||
    v.iterations !== 600000 ||
    !/^[a-f0-9]{64}$/.test(v.salt)
  )
    throw new RelayHttpError("invalid_discovery", 400);
  return { ...v, turnstile: Boolean(v.turnstile) };
}

/** Mint a single-use challenge for room allocation (30 s validity). */
export function createChallenge(
  origin: string,
  options?: HttpOptions,
): Promise<ChallengeResponse> {
  return relayRequest(origin, API + "room-challenges", {}, options);
}

/**
 * Allocate a room. The same request object replayed with the same requestId
 * is idempotent on the server; keep the challenge/proof pairing stable when
 * retrying. `turnstile` is the Cloudflare Turnstile token when the relay
 * requires it (see Discovery.turnstile). Omitted when absent for compatibility
 * with older relays that reject unknown request fields.
 */
export function allocate(
  origin: string,
  request: AllocationRequest,
  proof: string,
  turnstile?: string,
  options?: HttpOptions,
): Promise<Descriptor> {
  return relayRequest(
    origin,
    API + "rooms",
    { request, proof, ...(turnstile ? { turnstile } : {}) },
    options,
  );
}

/**
 * Confirm an allocated room by countersigning its descriptor with the host
 * key (domain romzo/relay-descriptor/v1). Returns the first admission ticket and
 * the long-lived recovery ticket.
 */
export function confirmRoom(
  origin: string,
  code: string,
  signed: SignedDescriptor,
  options?: HttpOptions,
): Promise<ConfirmResponse> {
  return relayRequest(origin, `${API}rooms/${code}/confirm`, signed, options);
}

/** Fetch a fresh guest admission ticket for an existing peer key. */
export function requestAdmission(
  origin: string,
  code: string,
  key: string,
  options?: HttpOptions,
): Promise<AdmissionResponse> {
  return relayRequest(
    origin,
    `${API}rooms/${code}/admissions`,
    { key },
    options,
  );
}

/** Fetch the published signed descriptor of a confirmed room. */
export function fetchDescriptor(
  origin: string,
  code: string,
  options?: HttpOptions,
): Promise<SignedDescriptor> {
  return relayRequest(origin, `${API}rooms/${code}`, undefined, options);
}

/**
 * Restore a room from a recovery ticket after relay restart / room eviction.
 * `signature` must sign the recovery ticket under domain romzo/relay-restore/v1
 * with the transport private key (see crypto.sign).
 */
export function restoreRoom(
  origin: string,
  code: string,
  signed: SignedDescriptor,
  recovery: SignedTicket,
  signature: string,
  options?: HttpOptions,
): Promise<RestoreResponse> {
  return relayRequest(
    origin,
    `${API}rooms/${code}/restore`,
    { signed, recovery, signature },
    options,
  );
}
