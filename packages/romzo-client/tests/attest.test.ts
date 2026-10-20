import { describe, expect, it } from "vitest";
import {
  GRANT_ERROR_MESSAGE,
  GRANT_MESSAGE,
  attestationMode,
  receiveGrant,
  validateGrant,
} from "../src/attest.js";
import { RelayHttpError } from "../src/http.js";
import { PROTOCOL } from "../src/types.js";
import type { Discovery, SignedGrant } from "../src/types.js";

const ORIGIN = "https://relay.test";

function discovery(auth: string): Discovery {
  return {
    protocol: PROTOCOL,
    version: "1.6.0",
    origin: ORIGIN,
    auth,
    salt: "ab".repeat(32),
    iterations: 600000,
    algorithm: "PBKDF2-HMAC-SHA256",
    turnstile: auth.includes("turnstile"),
    turnstileSiteKey: auth.includes("turnstile") ? "sitekey" : undefined,
    oauthLogin: auth.includes("oauth") ? "/api/v1/auth/oauth/login" : undefined,
    verify: auth.includes("turnstile") ? "/api/v1/verify" : undefined,
  };
}

function grant(provider: string, host: string, expires = Date.now() + 300_000): SignedGrant {
  return {
    grant: {
      protocol: PROTOCOL,
      origin: ORIGIN,
      provider,
      subject: provider.startsWith("oauth") ? "octocat" : "",
      host,
      expires,
      nonce: "cd".repeat(16),
    },
    signature: "ef".repeat(32),
  };
}

describe("attestationMode", () => {
  it("maps discovery auth values", () => {
    expect(attestationMode("anonymous")).toEqual({ turnstile: false, oauth: false });
    expect(attestationMode("password")).toEqual({ turnstile: false, oauth: false });
    expect(attestationMode("turnstile")).toEqual({ turnstile: true, oauth: false });
    expect(attestationMode("oauth")).toEqual({ turnstile: false, oauth: true });
    expect(attestationMode("turnstile+oauth")).toEqual({ turnstile: true, oauth: true });
  });
});

describe("validateGrant", () => {
  const host = "12".repeat(32);

  it("accepts a well-formed grant matching mode and host", () => {
    expect(validateGrant(discovery("turnstile"), grant("turnstile", host), host, ORIGIN)).toBeTruthy();
    expect(validateGrant(discovery("oauth"), grant("oauth:github", host), host, ORIGIN)).toBeTruthy();
    expect(
      validateGrant(discovery("turnstile+oauth"), grant("turnstile+oauth:github", host), host, ORIGIN),
    ).toBeTruthy();
  });

  it("rejects cross-host, cross-origin, expired and provider-mismatched grants", () => {
    const other = "ab".repeat(32);
    const cases: Array<[string, string, SignedGrant, string]> = [
      ["wrong host", "turnstile", grant("turnstile", other), host],
      ["wrong origin", "turnstile", { ...grant("turnstile", host), grant: { ...grant("turnstile", host).grant, origin: "https://evil.test" } }, host],
      ["expired", "turnstile", grant("turnstile", host, Date.now() - 1000), host],
      ["turnstile grant on oauth relay", "oauth", grant("turnstile", host), host],
      ["oauth grant on turnstile relay", "turnstile", grant("oauth:github", host), host],
      ["combined grant on turnstile relay", "turnstile", grant("turnstile+oauth:github", host), host],
      ["forged signature shape", "turnstile", { ...grant("turnstile", host), signature: "zz" }, host],
    ];
    for (const [name, auth, g, h] of cases) {
      expect(() => validateGrant(discovery(auth), g, h, ORIGIN), name).toThrow(RelayHttpError);
    }
  });

  it("rejects malformed payloads", () => {
    for (const bad of [null, undefined, {}, { grant: null }, grant("turnstile", "12".repeat(32))]) {
      expect(() => validateGrant(discovery("turnstile"), bad as SignedGrant, "34".repeat(32), ORIGIN)).toThrow(RelayHttpError);
    }
  });
});

describe("receiveGrant", () => {
  function fakeWindow() {
    const listeners: Array<(event: MessageEvent) => void> = [];
    const listener = {
      addEventListener: (_: string, fn: (event: MessageEvent) => void) => listeners.push(fn),
      removeEventListener: (_: string, fn: (event: MessageEvent) => void) => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      },
    } as unknown as Window;
    const source = {} as Window;
    const emit = (data: unknown, from: Window = source) =>
      listeners.forEach((fn) => fn({ data, source: from } as MessageEvent));
    return { listener, source, emit };
  }

  it("resolves on a valid grant message from the popup", async () => {
    const { listener, source, emit } = fakeWindow();
    const host = "56".repeat(32);
    const promise = receiveGrant(listener, source, ORIGIN, discovery("turnstile"), host, 1000);
    emit({ type: GRANT_MESSAGE, grant: grant("turnstile", host) });
    await expect(promise).resolves.toBeTruthy();
  });

  it("ignores messages from other windows and rejects relay errors", async () => {
    const { listener, source, emit } = fakeWindow();
    const other = {} as Window;
    const promise = receiveGrant(listener, source, ORIGIN, discovery("turnstile"), "56".repeat(32), 1000);
    emit({ type: GRANT_MESSAGE, grant: grant("turnstile", "56".repeat(32)) }, other);
    emit({ type: GRANT_ERROR_MESSAGE, error: "oauth_denied" });
    await expect(promise).rejects.toMatchObject({ code: "oauth_denied", status: 403 });
  });

  it("times out when the popup never answers", async () => {
    const { listener, source } = fakeWindow();
    await expect(
      receiveGrant(listener, source, ORIGIN, discovery("turnstile"), "56".repeat(32), 20),
    ).rejects.toMatchObject({ code: "attestation_timeout" });
  });
});
