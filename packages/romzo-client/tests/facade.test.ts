import { describe, expect, it } from "vitest";
import { canonical, hash, unhex } from "../src/canonical.js";
import {
  derivePasswordKey,
  exportPrivateKey,
  importKeyPair,
  passwordProof,
  verify,
} from "../src/crypto.js";
import { createRoom } from "../src/facade.js";
import { PROTOCOL } from "../src/types.js";

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
};

/** Router-style fake fetch replaying a scripted relay. */
function scriptedFetch(handler: (url: string, body: unknown) => Response) {
  const calls: { url: string; body: unknown; raw: string }[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const raw = (init?.body as string) ?? "";
    calls.push({ url, body: raw ? JSON.parse(raw) : undefined, raw });
    return handler(url, raw ? JSON.parse(raw) : undefined);
  };
  return { fetch, calls };
}

const OPTIONS = { players: 4, identityMode: "mixed", threshold: 11 };

describe("createRoom facade (scripted fetch)", () => {
  it("runs challenge -> allocate -> confirm with password proof and turnstile", async () => {
    let allocated: any = null;
    const { fetch, calls } = scriptedFetch((url, body: any) => {
      if (url.endsWith("/.well-known/romzo"))
        return new Response(JSON.stringify(DISCOVERY), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      if (url.endsWith("/room-challenges"))
        return new Response(
          JSON.stringify({ challenge: "cc".repeat(32), expires: Date.now() + 30000 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      if (url.endsWith("/rooms") && !url.includes("/rooms/")) {
        allocated = body;
        return new Response(
          JSON.stringify({
            protocol: PROTOCOL,
            origin: ORIGIN,
            code: "ABCD2345EF",
            instance: "11".repeat(16),
            host: body.request.host,
            transport: body.request.transport,
            capability: body.request.capability,
            configHash: body.request.configHash,
            options: body.request.options,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/confirm")) {
        return new Response(
          JSON.stringify({
            admission: {
              ticket: {
                protocol: PROTOCOL,
                origin: ORIGIN,
                code: "ABCD2345EF",
                instance: "11".repeat(16),
                digest: "bb".repeat(64),
                key: body.descriptor.transport,
                purpose: "creator",
                expires: Date.now() + 60000,
                nonce: "dd".repeat(16),
              },
              signature: "ee".repeat(64),
            },
            recovery: {
              ticket: {
                protocol: PROTOCOL,
                origin: ORIGIN,
                code: "ABCD2345EF",
                instance: "11".repeat(16),
                digest: "bb".repeat(64),
                key: body.descriptor.transport,
                purpose: "recovery",
                expires: Date.now() + 600000,
                nonce: "dd".repeat(16),
              },
              signature: "ee".repeat(64),
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error("unexpected url " + url);
    });
    const room = await createRoom(ORIGIN, OPTIONS, {
      fetch,
      password: "vector-password",
      turnstileToken: "tok",
    });
    expect(calls.map((c) => c.url)).toEqual([
      ORIGIN + "/.well-known/romzo",
      ORIGIN + "/api/v1/room-challenges",
      ORIGIN + "/api/v1/rooms",
      ORIGIN + "/api/v1/rooms/ABCD2345EF/confirm",
    ]);
    // Allocate body: request + proof + turnstile.
    expect(Object.keys(allocated).sort()).toEqual(["proof", "request", "turnstile"]);
    expect(allocated.turnstile).toBe("tok");
    const key = await derivePasswordKey(
      "vector-password",
      unhex(DISCOVERY.salt),
      600000,
    );
    expect(allocated.proof).toBe(
      await passwordProof(key, "romzo/relay-create/v1", allocated.request),
    );
    expect(allocated.request.configHash).toBe(
      await hash("romzo/lobby-options/v1", OPTIONS),
    );
    expect(canonical(allocated.request.options)).toBe(canonical(OPTIONS));
    // Confirm body: host-signed descriptor, signature verifies.
    const confirm = calls[3].body as any;
    expect(confirm.descriptor.host).toBe(room.host.publicKey);
    expect(
      await verify(
        room.host.publicKey,
        confirm.descriptor,
        "romzo/relay-descriptor/v1",
        confirm.signature,
      ),
    ).toBe(true);
    expect(room.signedDescriptor.signature).toBe(confirm.signature);
    expect(room.admission.ticket.purpose).toBe("creator");
    expect(room.recovery.ticket.purpose).toBe("recovery");
    // Key material round-trips through hex export/import.
    const restored = await importKeyPair(
      room.transport.publicKey,
      await exportPrivateKey(room.transport.privateKey),
    );
    expect(restored.publicKey).toBe(room.transport.publicKey);
  });

  it("requires a password when the relay uses password auth", async () => {
    const { fetch } = scriptedFetch((url) => {
      if (url.endsWith("/.well-known/romzo"))
        return new Response(JSON.stringify(DISCOVERY), { status: 200 });
      throw new Error("unexpected");
    });
    await expect(createRoom(ORIGIN, OPTIONS, { fetch })).rejects.toThrow(
      "password",
    );
  });
});
