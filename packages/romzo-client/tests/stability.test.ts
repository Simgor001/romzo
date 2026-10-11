import { describe, expect, it, vi } from "vitest";
import { allocate, relayRequest, RelayHttpError } from "../src/http.js";
import { createPasswordKeyCache, generateKeyPair, passwordProof, sign } from "../src/crypto.js";
import { joinRoom, createRoom, verifyDescriptor } from "../src/facade.js";
import { hash } from "../src/canonical.js";
import { PROTOCOL, type AllocationRequest } from "../src/types.js";

const origin = "https://relay.example";
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });

describe("bounded HTTP retry", () => {
  it("retries allocation after response loss without allocating twice", async () => {
    const request: AllocationRequest = { protocol: PROTOCOL, origin, challenge: "a", requestId: "b", host: "c", transport: "d", configHash: "e", capability: "f", options: {} };
    const rooms = new Map<string, unknown>();
    const bodies: string[] = [];
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body));
      const r = JSON.parse(String(init?.body)).request;
      if (!rooms.has(r.requestId)) rooms.set(r.requestId, { code: "ABCD2345EF" });
      if (bodies.length === 1) throw new TypeError("lost response");
      return json(rooms.get(r.requestId));
    });
    expect(await allocate(origin, request, "proof", "token", { fetch })).toEqual({ code: "ABCD2345EF" });
    expect(rooms.size).toBe(1);
    expect(bodies[0]).toBe(bodies[1]);
  });
  it("retries a response stream interrupted in transit", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(new ReadableStream({ start(c) { c.error(new TypeError("dropped stream")); } }))).mockResolvedValueOnce(json({ ok: true }));
    expect(await relayRequest(origin, "/test", {}, { fetch })).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("times out fetch and retries with a fresh signal", async () => {
    const signals: AbortSignal[] = [];
    const fetch = vi.fn((_url: string, init?: RequestInit) => {
      signals.push(init!.signal!);
      return signals.length === 1 ? new Promise<Response>(() => {}) : Promise.resolve(json({ ok: true }));
    });
    expect(await relayRequest(origin, "/test", {}, { fetch, timeoutMs: 10 })).toEqual({ ok: true });
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
  });
  it("times out a stalled response stream and cancels it", async () => {
    const cancel = vi.fn();
    const fetch = vi.fn().mockResolvedValueOnce(new Response(new ReadableStream({ cancel }))).mockResolvedValueOnce(json({ ok: true }));
    await relayRequest(origin, "/test", {}, { fetch, timeoutMs: 10 });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("never retries user cancellation, including before fetch", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async () => { controller.abort(); throw controller.signal.reason; });
    await expect(relayRequest(origin, "/test", {}, { fetch, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockClear();
    await expect(relayRequest(origin, "/test", {}, { fetch, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    [() => new Response("bad json"), "invalid_response"],
    [() => json({ error: "authorization_failed" }, 401), "authorization_failed"],
    [() => new Response("x".repeat(16385)), "response_too_large"],
    [() => new Response(null), "empty_response"],
  ] as const)("rejects semantic failures without retry", async (response, code) => {
    const fetch = vi.fn(async () => response());
    await expect(relayRequest(origin, "/test", {}, { fetch })).rejects.toMatchObject({ code });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("supports retry and response limit overrides", async () => {
    const fetch = vi.fn(async () => { throw new TypeError("offline"); });
    await expect(relayRequest(origin, "/test", {}, { fetch, retries: 0 })).rejects.toThrow("offline");
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(relayRequest(origin, "/test", {}, { fetch: async () => json({ a: 1 }), maxResponseBytes: 4 })).rejects.toBeInstanceOf(RelayHttpError);
  });
});

describe("credential-owned cache", () => {
  it("enforces application discovery policy before challenge or allocation", async () => {
    const fetch = vi.fn(async () => json({ protocol: PROTOCOL, origin, auth: "off", salt: "ab".repeat(32), iterations: 600000, algorithm: "PBKDF2-HMAC-SHA256" }));
    await expect(createRoom(origin, {}, { fetch, validateDiscovery: () => { throw new Error("unsupported auth"); } })).rejects.toThrow("unsupported auth");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("isolates passwords and derivation parameters, and clears by origin", async () => {
    const salt = "ab".repeat(32);
    const cache = createPasswordKeyCache("one");
    const a = cache.get(origin, salt, 1);
    expect(cache.get(origin, salt, 1)).toBe(a);
    expect(cache.get(origin, "cd".repeat(32), 1)).not.toBe(a);
    expect(cache.get(origin, salt, 2)).not.toBe(a);
    const other = cache.get("https://other.example", salt, 1);
    const b = createPasswordKeyCache("two").get(origin, salt, 1);
    expect(await passwordProof(await a, "test", {})).not.toBe(await passwordProof(await b, "test", {}));
    cache.clear(origin);
    expect(cache.get(origin, salt, 1)).not.toBe(a);
    expect(cache.get("https://other.example", salt, 1)).toBe(other);
    cache.clear();
    expect(cache.get("https://other.example", salt, 1)).not.toBe(other);
  });
  it("evicts rejected derivations", async () => {
    const cache = createPasswordKeyCache("one");
    const a = cache.get(origin, "ab".repeat(32), 0);
    await expect(a).rejects.toThrow();
    const b = cache.get(origin, "ab".repeat(32), 0);
    expect(b).not.toBe(a);
    await expect(b).rejects.toThrow();
  });
  it("createRoom clears the provider after authentication failure", async () => {
    const provider = { get: vi.fn(async () => await createPasswordKeyCache("wrong").get(origin, "ab".repeat(32), 1)), clear: vi.fn() };
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("relic-undertow")) return json({ protocol: PROTOCOL, origin, auth: "password", salt: "ab".repeat(32), iterations: 600000, algorithm: "PBKDF2-HMAC-SHA256" });
      if (url.endsWith("room-challenges")) return json({ challenge: "cc".repeat(32) });
      return json({ error: "authorization_failed" }, 401);
    });
    await expect(createRoom(origin, {}, { fetch, passwordKeyProvider: provider })).rejects.toMatchObject({ code: "authorization_failed" });
    expect(provider.get).toHaveBeenCalledWith(origin, "ab".repeat(32), 600000);
    expect(provider.clear).toHaveBeenCalledWith(origin);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

async function signedRoom() {
  const host = await generateKeyPair();
  const descriptor = { protocol: PROTOCOL, origin, code: "ABCD2345EF", instance: "ab".repeat(16), host: host.publicKey, transport: host.publicKey, capability: "cd".repeat(16), options: { players: 4 }, configHash: await hash("ru/lobby-options/v1", { players: 4 }) };
  return { descriptor, signature: await sign(host, descriptor, "ru/relay-descriptor/v1") };
}

describe("join-side descriptor trust", () => {
  it("validates signature/hash and runs application validation before admission", async () => {
    const signed = await signedRoom();
    const order: string[] = [];
    const fetch = vi.fn(async (url: string) => { order.push(url.endsWith("admissions") ? "admission" : "descriptor"); return json(url.endsWith("admissions") ? { admission: {} } : signed); });
    await joinRoom(origin, signed.descriptor.code, { fetch, validateOptions: (v) => { expect(v).toEqual({ players: 4 }); order.push("validate"); } });
    expect(order).toEqual(["descriptor", "validate", "admission"]);
  });
  it.each(["options", "configHash", "signature", "origin", "code", "extra", "outerExtra"])("rejects tampered %s without requesting admission", async (field) => {
    const signed: any = await signedRoom();
    if (field === "signature") signed.signature = "00".repeat(64);
    else if (field === "outerExtra") signed.extra = true;
    else if (field === "extra") signed.descriptor.extra = true;
    else if (field === "options") signed.descriptor.options = { players: 5 };
    else if (field === "configHash") signed.descriptor.configHash = "00".repeat(32);
    else signed.descriptor[field] = "wrong";
    const fetch = vi.fn(async () => json(signed));
    await expect(joinRoom(origin, "ABCD2345EF", { fetch })).rejects.toBeInstanceOf(RelayHttpError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects application-invalid options even with a valid host signature", async () => {
    const signed = await signedRoom();
    await expect(verifyDescriptor(signed, origin, signed.descriptor.code, () => { throw new Error("unsupported options"); })).rejects.toThrow("unsupported options");
  });
});
