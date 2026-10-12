import { describe, expect, it } from "vitest";
import { canonical, unhex } from "../src/canonical.js";
import { derivePasswordKey, generateKeyPair, passwordProof } from "../src/crypto.js";
import {
  allocate,
  confirmRoom,
  discover,
  normalizeOrigin,
  RelayHttpError,
  requestAdmission,
  restoreRoom,
} from "../src/http.js";
import { PROTOCOL } from "../src/types.js";
import type { AllocationRequest, SignedTicket } from "../src/types.js";

type RecordedCall = { url: string; init?: RequestInit };

/** Queue-backed fake fetch; shift responses per call. */
function fakeFetch(responses: (() => Response)[]) {
  const calls: RecordedCall[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("fake fetch: no response queued");
    return next();
  };
  return { fetch, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const ORIGIN = "https://relay.example";

const DISCOVERY = {
  protocol: PROTOCOL,
  version: "1.1.0",
  origin: ORIGIN,
  auth: "password",
  salt: "ab".repeat(32),
  iterations: 600000,
  algorithm: "PBKDF2-HMAC-SHA256",
  turnstile: true,
  limits: { framesPerSecond: 64, bytesPerSecond: 1048576 },
};

function allocationRequest(): AllocationRequest {
  return {
    protocol: PROTOCOL,
    origin: ORIGIN,
    challenge: "cc".repeat(32),
    requestId: "dd".repeat(16),
    host: "ee".repeat(32),
    transport: "ff".repeat(32),
    configHash: "01".repeat(32),
    capability: "02".repeat(16),
    options: { players: 4, identityMode: "mixed", threshold: 11 },
  };
}

describe("HTTP face (fake fetch)", () => {
  it("discovers relay metadata including the turnstile flag", async () => {
    const { fetch, calls } = fakeFetch([() => json(DISCOVERY)]);
    const info = await discover(ORIGIN, { fetch });
    expect(info.turnstile).toBe(true);
    expect(info.auth).toBe("password");
    expect(calls[0].url).toBe(ORIGIN + "/.well-known/romzo");
    expect(calls[0].init?.method).toBe("GET");
  });

  it("discovers turnstile=false when the relay does not require it", async () => {
    const { fetch } = fakeFetch([() => json({ ...DISCOVERY, turnstile: false })]);
    expect((await discover(ORIGIN, { fetch })).turnstile).toBe(false);
  });

  it("rejects a discovery document for a different origin", async () => {
    const { fetch } = fakeFetch([() => json({ ...DISCOVERY, origin: "https://evil.example" })]);
    await expect(discover(ORIGIN, { fetch })).rejects.toMatchObject({
      code: "protocol_mismatch",
    });
  });

  it("sends allocate requests with request/proof/turnstile fields", async () => {
    const request = allocationRequest();
    const key = await derivePasswordKey(
      "vector-password",
      unhex(DISCOVERY.salt),
      600000,
    );
    const proof = await passwordProof(key, "romzo/relay-create/v1", request);
    const { fetch, calls } = fakeFetch([
      () =>
        json({
          protocol: PROTOCOL,
          origin: ORIGIN,
          code: "ABCD2345EF",
          instance: "11".repeat(16),
          host: request.host,
          transport: request.transport,
          capability: request.capability,
          configHash: request.configHash,
          options: request.options,
        }),
    ]);
    await allocate(ORIGIN, request, { proof, turnstile: "turnstile-token" }, { fetch });
    const call = calls[0];
    expect(call.url).toBe(ORIGIN + "/api/v1/rooms");
    expect(call.init?.method).toBe("POST");
    expect(call.init?.headers).toMatchObject({ "Content-Type": "application/json" });
    const body = JSON.parse(call.init?.body as string);
    expect(Object.keys(body).sort()).toEqual(["proof", "request", "turnstile"]);
    expect(body.turnstile).toBe("turnstile-token");
    // Proof is the HMAC of the canonical request under the derived key.
    expect(body.proof).toBe(
      await passwordProof(key, "romzo/relay-create/v1", body.request),
    );
    expect(canonical(body.request)).toBe(canonical(request));
  });

  it("omits absent turnstile for strict older relays", async () => {
    const request = allocationRequest();
    const { fetch, calls } = fakeFetch([
      () => json({ code: "ABCD2345EF" }),
    ]);
    await allocate(ORIGIN, request, { proof: "proof" }, { fetch });
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body).not.toHaveProperty("turnstile");
    expect(body.proof).toBe("proof");
  });

  it("replays an idempotent allocation with a byte-identical body", async () => {
    const request = allocationRequest();
    const descriptor = { code: "ABCD2345EF" };
    const { fetch, calls } = fakeFetch([
      () => json(descriptor),
      () => json(descriptor),
    ]);
    const proof = "deadbeef".repeat(8);
    await allocate(ORIGIN, request, { proof }, { fetch });
    await allocate(ORIGIN, request, { proof }, { fetch });
    expect(calls[1].init?.body).toBe(calls[0].init?.body);
  });

  it("maps server error codes onto RelayHttpError", async () => {
    const { fetch } = fakeFetch([
      () => json({ error: "authorization_failed" }, 401),
    ]);
    try {
      await allocate(ORIGIN, allocationRequest(), { proof: "bad" }, { fetch });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(RelayHttpError);
      expect((e as RelayHttpError).code).toBe("authorization_failed");
      expect((e as RelayHttpError).status).toBe(401);
      expect((e as Error).message).toContain("authorization_failed");
    }
  });

  it("confirm, admissions and restore hit their routes with the right bodies", async () => {
    const signed = {
      descriptor: {
        protocol: PROTOCOL,
        origin: ORIGIN,
        code: "ABCD2345EF",
        instance: "11".repeat(16),
        host: "ee".repeat(32),
        transport: "ff".repeat(32),
        capability: "02".repeat(16),
        configHash: "01".repeat(32),
        options: {},
      },
      signature: "aa".repeat(128),
    };
    const recovery = {
      ticket: {
        protocol: PROTOCOL,
        origin: ORIGIN,
        code: "ABCD2345EF",
        instance: "11".repeat(16),
        digest: "bb".repeat(64),
        key: "ff".repeat(32),
        purpose: "recovery",
        expires: Date.now() + 60000,
        nonce: "cc".repeat(16),
      },
      signature: "dd".repeat(64),
    } satisfies SignedTicket;
    const admission = { admission: { ...recovery, ticket: { ...recovery.ticket, purpose: "creator" } } };
    const { fetch, calls } = fakeFetch([
      () => json(admission),
      () => json(admission),
      () => json(admission),
    ]);
    await confirmRoom(ORIGIN, "ABCD2345EF", signed, { fetch });
    await requestAdmission(ORIGIN, "ABCD2345EF", "ff".repeat(32), { fetch });
    await restoreRoom(ORIGIN, "ABCD2345EF", signed, recovery, "sig", { fetch });
    expect(calls[0].url).toBe(ORIGIN + "/api/v1/rooms/ABCD2345EF/confirm");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual(signed);
    expect(calls[1].url).toBe(ORIGIN + "/api/v1/rooms/ABCD2345EF/admissions");
    expect(JSON.parse(calls[1].init?.body as string)).toEqual({ key: "ff".repeat(32) });
    expect(calls[2].url).toBe(ORIGIN + "/api/v1/rooms/ABCD2345EF/restore");
    expect(JSON.parse(calls[2].init?.body as string)).toEqual({
      signed,
      recovery,
      signature: "sig",
    });
  });

  it("generates key pairs compatible with the wire format", async () => {
    const identity = await generateKeyPair();
    expect(identity.publicKey).toMatch(/^[a-f0-9]{64}$/);
  });

  it("discovers against a bare host by defaulting to https", async () => {
    const { fetch, calls } = fakeFetch([() => json(DISCOVERY)]);
    const info = await discover("relay.example", { fetch });
    expect(info.auth).toBe("password");
    expect(calls[0].url).toBe(ORIGIN + "/.well-known/romzo");
  });

  it("rejects a discovery document that does not match the normalized origin", async () => {
    const { fetch } = fakeFetch([
      () => json({ ...DISCOVERY, origin: "https://relay.example:8443" }),
    ]);
    await expect(discover("relay.example", { fetch })).rejects.toMatchObject({
      code: "protocol_mismatch",
    });
  });
});

describe("normalizeOrigin", () => {
  it("defaults bare hosts to https", () => {
    expect(normalizeOrigin("romzo.net")).toBe("https://romzo.net");
    expect(normalizeOrigin("romzo.net:9224")).toBe("https://romzo.net:9224");
  });

  it("defaults loopback hosts to http", () => {
    expect(normalizeOrigin("localhost:9224")).toBe("http://localhost:9224");
    expect(normalizeOrigin("127.0.0.1:9224")).toBe("http://127.0.0.1:9224");
    expect(normalizeOrigin("[::1]:9224")).toBe("http://[::1]:9224");
  });

  it("keeps an explicit scheme and strips trailing slashes", () => {
    expect(normalizeOrigin("https://romzo.net/")).toBe("https://romzo.net");
    expect(normalizeOrigin("http://localhost:9224/")).toBe("http://localhost:9224");
  });

  it("drops default ports and rejects malformed input", () => {
    expect(normalizeOrigin("https://romzo.net:443")).toBe("https://romzo.net");
    expect(() => normalizeOrigin("")).toThrow(RangeError);
    expect(() => normalizeOrigin("https://romzo.net/x")).toThrow(RangeError);
    expect(() => normalizeOrigin("https://romzo.net?q=1")).toThrow(RangeError);
  });
});
