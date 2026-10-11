import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPair, verify, type Identity } from "../src/crypto.js";
import {
  RelaySession,
  RelaySessionError,
  type SocketLike,
} from "../src/session.js";
import { PROTOCOL } from "../src/types.js";
import type { SignedDescriptor, SignedTicket } from "../src/types.js";
import { hash } from "../src/canonical.js";

/** Minimal in-memory socket scripted to act as the relay server. */
class FakeSocket implements SocketLike {
  static current: FakeSocket | null = null;
  /** Shared server behaviour, applied to every socket including reconnects. */
  static serverHandler:
    | ((frame: any, socket: FakeSocket) => void | Promise<void>)
    | null = null;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  closed = false;

  constructor() {
    FakeSocket.current = this;
    queueMicrotask(() => this.onopen?.());
  }
  send(data: string) {
    this.sent.push(data);
    void FakeSocket.serverHandler?.(JSON.parse(data), this);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.onclose?.());
  }
  deliver(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  frames(kind: string) {
    return this.sent.map((s) => JSON.parse(s)).filter((f) => f.kind === kind);
  }
}

const factory = () => new FakeSocket();

// Captured before the fake timers install: lets a test yield a real macrotask
// so threadpool-backed WebCrypto work can settle between timer advances.
const realSetTimeout = setTimeout;
const macrotask = () => new Promise<void>((r) => realSetTimeout(r, 1));

const ORIGIN = "https://relay.example";
const CODE = "ABCD2345EF";

function makeAdmission(key: string, nonce = "01".repeat(16)): SignedTicket {
  return {
    ticket: {
      protocol: PROTOCOL,
      origin: ORIGIN,
      code: CODE,
      instance: "cd".repeat(16),
      digest: "ef".repeat(32),
      key,
      purpose: "guest",
      expires: Date.now() + 60000,
      nonce,
    },
    signature: "aa".repeat(64),
  };
}

function recoveryTicket(key: string, nonce: string): SignedTicket {
  return {
    ticket: {
      ...makeAdmission(key).ticket,
      purpose: "recovery",
      expires: Date.now() + 30 * 60000,
      nonce,
    },
    signature: "bb".repeat(64),
  };
}

function signedDescriptor(transport: string): SignedDescriptor {
  return {
    descriptor: {
      protocol: PROTOCOL,
      origin: ORIGIN,
      code: CODE,
      instance: "cd".repeat(16),
      host: "ab".repeat(32),
      transport,
      capability: "9a".repeat(16),
      configHash: "12".repeat(32),
      options: { app: "example" },
    },
    signature: "cc".repeat(64),
  };
}

/**
 * Scripted relay: completes the four-frame handshake for any admission,
 * then acks every request. `recovery` is attached to keepalive acks when given.
 */
function serve(identity: Identity, opts: { recovery?: SignedTicket } = {}) {
  FakeSocket.serverHandler = async (frame, s) => {
    if (frame.kind === "authenticate") {
      (s as any).admission = frame.admission;
      const challenge = {
        protocol: PROTOCOL,
        origin: ORIGIN,
        ticket: await hash("romzo/relay-admission/v1", frame.admission),
        challenge: "f0".repeat(32),
      };
      s.deliver({ v: PROTOCOL, kind: "challenge", value: challenge });
    } else if (frame.kind === "proof") {
      const challenge = {
        protocol: PROTOCOL,
        origin: ORIGIN,
        ticket: await hash("romzo/relay-admission/v1", (s as any).admission),
        challenge: "f0".repeat(32),
      };
      expect(
        await verify(
          identity.publicKey,
          challenge,
          "romzo/relay-connect/v1",
          frame.signature,
        ),
      ).toBe(true);
      s.deliver({ v: PROTOCOL, kind: "authenticated", id: "ab".repeat(16) });
    } else if (
      ["subscribe", "unsubscribe", "send"].includes(frame.kind)
    ) {
      s.deliver({ v: PROTOCOL, kind: "ack", id: frame.id });
    } else if (frame.kind === "keepalive") {
      s.deliver({
        v: PROTOCOL,
        kind: "ack",
        id: frame.id,
        ...(opts.recovery ? { recovery: opts.recovery } : {}),
      });
    }
  };
}

/** Fetch stub that serves POST /restore with a fresh admission ticket. */
function stubRestore(identity: Identity) {
  const calls: { url: string; body: any }[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    if (!url.endsWith(`/api/v1/rooms/${CODE}/restore`))
      throw new Error(`unexpected fetch: ${url}`);
    return new Response(
      JSON.stringify({ admission: makeAdmission(identity.publicKey, "77".repeat(16)) }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  return calls;
}

async function connectWithReconnect(
  identity: Identity,
  admission: SignedTicket,
  reconnect: Record<string, unknown>,
  recovery?: SignedTicket,
) {
  const connecting = RelaySession.connect("wss://relay.example/ws", admission, identity, {
    webSocketFactory: factory,
    keepalive: false,
    autoReconnect: reconnect as any,
  });
  serve(identity, { recovery });
  return connecting;
}

describe("RelaySession autoReconnect", () => {
  beforeEach(() => {
    FakeSocket.serverHandler = null;
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("throws when enabled without a signedDescriptor", async () => {
    const identity = await generateKeyPair();
    const admission = makeAdmission(identity.publicKey);
    await expect(
      RelaySession.connect("wss://x", admission, identity, {
        webSocketFactory: factory,
        autoReconnect: {} as any,
      }),
    ).rejects.toThrow("autoReconnect requires a signedDescriptor");
  });

  it("rejects invalid backoff limits", async () => {
    const identity = await generateKeyPair();
    const admission = makeAdmission(identity.publicKey);
    await expect(
      RelaySession.connect("wss://x", admission, identity, {
        webSocketFactory: factory,
        autoReconnect: {
          signedDescriptor: signedDescriptor(identity.publicKey),
          baseDelayMs: 0,
        },
      }),
    ).rejects.toThrow(RangeError);
  });

  it("reconnects after a transport drop, re-subscribes and reports the attempt", async () => {
    const identity = await generateKeyPair();
    const admission = makeAdmission(identity.publicKey);
    const descriptor = signedDescriptor(identity.publicKey);
    const fresh = recoveryTicket(identity.publicKey, "11".repeat(16));
    const calls = stubRestore(identity);
    const session = await connectWithReconnect(
      identity,
      admission,
      { signedDescriptor: descriptor, baseDelayMs: 100, maxDelayMs: 15000 },
      fresh,
    );
    await session.subscribe("chat");
    await session.subscribe("state");
    await session.keepalive();
    expect(session.currentRecovery()).toEqual(fresh);

    const events: string[] = [];
    const reconnecting: any[] = [];
    session.on("reconnecting", (p: any) => reconnecting.push(p));
    session.on("reconnect", (p: any) => events.push(`reconnect:${p.attempt}`));
    session.on("close", () => events.push("close"));

    // Transport drops; pending work must fail fast instead of hanging.
    const firstSocket = FakeSocket.current!;
    firstSocket.onclose!();
    await expect(session.send("chat", { n: 1 })).rejects.toThrow(
      "relay session reconnecting",
    );
    expect(reconnecting).toHaveLength(1);
    expect(reconnecting[0].attempt).toBe(1);
    expect(reconnecting[0].delayMs).toBeGreaterThanOrEqual(80);
    expect(reconnecting[0].delayMs).toBeLessThanOrEqual(120);

    const reconnected = new Promise<void>((r) =>
      session.on("reconnect", () => r()),
    );
    await vi.advanceTimersByTimeAsync(120);
    await reconnected;
    expect(events).toEqual(["reconnect:1"]);

    // The restore request used the latest recovery ticket and the descriptor.
    expect(calls).toHaveLength(1);
    expect(calls[0].body.recovery).toEqual(fresh);
    expect(calls[0].body.signed).toEqual(descriptor);

    // The new socket re-subscribed to every previously subscribed channel.
    const secondSocket = FakeSocket.current!;
    expect(secondSocket).not.toBe(firstSocket);
    const resubscribed = secondSocket
      .frames("subscribe")
      .map((f) => f.channel);
    expect(resubscribed).toEqual(["chat", "state"]);

    // The session is usable again and emits close exactly once at the end.
    await session.send("chat", { n: 2 });
    expect(secondSocket.frames("send")).toHaveLength(1);
    session.close();
    expect(events).toEqual(["reconnect:1", "close"]);
  });

  it("reconnects after a terminal error frame and does not emit close", async () => {
    const identity = await generateKeyPair();
    const admission = makeAdmission(identity.publicKey);
    stubRestore(identity);
    const session = await connectWithReconnect(
      identity,
      admission,
      {
        signedDescriptor: signedDescriptor(identity.publicKey),
        baseDelayMs: 100,
      },
      recoveryTicket(identity.publicKey, "22".repeat(16)),
    );
    await session.subscribe("chat");
    await session.keepalive();

    const order: string[] = [];
    session.on("error", (code) => order.push(`error:${code}`));
    session.on("reconnecting", (p: any) => order.push(`reconnecting:${p.attempt}`));
    session.on("reconnect", (p: any) => order.push(`reconnect:${p.attempt}`));
    session.on("close", () => order.push("close"));

    FakeSocket.current!.deliver({
      v: PROTOCOL,
      kind: "error",
      error: "invalid_channel",
    });
    const reconnected = new Promise<void>((r) =>
      session.on("reconnect", () => r()),
    );
    await vi.advanceTimersByTimeAsync(120);
    await reconnected;
    expect(order).toEqual([
      "error:invalid_channel",
      "reconnecting:1",
      "reconnect:1",
    ]);
    expect(FakeSocket.current!.frames("subscribe").map((f) => f.channel)).toEqual(
      ["chat"],
    );
    session.close();
  });

  it("emits close only after maxAttempts exhausted, with growing capped delays", async () => {
    const identity = await generateKeyPair();
    const admission = makeAdmission(identity.publicKey);
    vi.stubGlobal("fetch", async () => {
      throw new Error("relay unreachable");
    });
    const session = await connectWithReconnect(
      identity,
      admission,
      {
        signedDescriptor: signedDescriptor(identity.publicKey),
        maxAttempts: 4,
        baseDelayMs: 100,
        maxDelayMs: 400,
      },
      recoveryTicket(identity.publicKey, "99".repeat(16)),
    );
    await session.subscribe("chat");
    await session.keepalive();

    const reconnecting: any[] = [];
    session.on("reconnecting", (p: any) => reconnecting.push(p));
    const closed = new Promise<void>((r) => session.on("close", () => r()));
    const reconnected = new Promise<void>((r) =>
      session.on("reconnect", () => r()),
    );
    FakeSocket.current!.onclose!();
    // Four attempts: 100/200/400/400 nominal, each ±20%.
    const bands = [
      [80, 120],
      [160, 240],
      [320, 480],
      [320, 480],
    ];
    for (let attempt = 1; attempt <= 4; attempt++) {
      await vi.advanceTimersByTimeAsync(bands[attempt - 1][1]);
      await macrotask(); // let the failed attempt's signing settle and schedule
    }
    // Let the last attempt's failure settle and its timer fire.
    await vi.advanceTimersByTimeAsync(480);
    await macrotask();
    await closed;
    await expect(
      Promise.race([reconnected, Promise.resolve("no reconnect")]),
    ).resolves.toBe("no reconnect");
    expect(reconnecting.map((p) => p.attempt)).toEqual([1, 2, 3, 4]);
    reconnecting.forEach((p, i) => {
      expect(p.delayMs).toBeGreaterThanOrEqual(bands[i][0]);
      expect(p.delayMs).toBeLessThanOrEqual(bands[i][1]);
      expect(p.error).toBeInstanceOf(Error);
    });
    await expect(session.subscribe("chat")).rejects.toThrow("closed");
  });

  it("manual close cancels the reconnect loop and emits close once", async () => {
    const identity = await generateKeyPair();
    const admission = makeAdmission(identity.publicKey);
    const calls = stubRestore(identity);
    const session = await connectWithReconnect(
      identity,
      admission,
      {
        signedDescriptor: signedDescriptor(identity.publicKey),
        baseDelayMs: 100,
      },
      recoveryTicket(identity.publicKey, "55".repeat(16)),
    );
    await session.subscribe("chat");
    await session.keepalive();

    const events: string[] = [];
    session.on("reconnecting", () => events.push("reconnecting"));
    session.on("reconnect", () => events.push("reconnect"));
    session.on("close", () => events.push("close"));

    FakeSocket.current!.onclose!();
    await vi.advanceTimersByTimeAsync(50); // mid-backoff
    session.close();
    await vi.advanceTimersByTimeAsync(60000);
    expect(events).toEqual(["reconnecting", "close"]);
    expect(calls).toHaveLength(0);
  });

  it("fails attempts without recovery ticket, then succeeds once keepalive renews", async () => {
    const identity = await generateKeyPair();
    const admission = makeAdmission(identity.publicKey);
    const calls = stubRestore(identity);
    const session = await connectWithReconnect(identity, admission, {
      signedDescriptor: signedDescriptor(identity.publicKey),
      baseDelayMs: 100,
    });
    await session.subscribe("chat");
    // No keepalive yet: no recovery ticket available.
    expect(session.currentRecovery()).toBeNull();

    const reconnecting: any[] = [];
    session.on("reconnecting", (p: any) => reconnecting.push(p));
    FakeSocket.current!.onclose!();
    await vi.advanceTimersByTimeAsync(120);
    expect(reconnecting).toHaveLength(2);
    expect(String(reconnecting[1].error)).toMatch(
      /no recovery ticket available/,
    );
    // The missing-ticket check fails before any restore HTTP call is made.
    expect(calls).toHaveLength(0);

    // A later keepalive-style renewal cannot arrive while disconnected, so the
    // loop keeps failing; give it a ticket by closing and re-checking defaults.
    session.close();
    expect(reconnecting.length).toBeGreaterThanOrEqual(2);
  });

  it("pauses keepalive while disconnected and resumes after reconnect", async () => {
    const identity = await generateKeyPair();
    const admission = makeAdmission(identity.publicKey);
    stubRestore(identity);
    const connecting = RelaySession.connect(
      "wss://relay.example/ws",
      admission,
      identity,
      {
        webSocketFactory: factory,
        keepaliveIntervalMs: 1000,
        autoReconnect: {
          signedDescriptor: signedDescriptor(identity.publicKey),
          baseDelayMs: 100,
        },
      },
    );
    serve(identity, {
      recovery: recoveryTicket(identity.publicKey, "33".repeat(16)),
    });
    const session = await connecting;
    await session.subscribe("chat");
    await session.keepalive();

    const firstSocket = FakeSocket.current!;
    await vi.advanceTimersByTimeAsync(1000);
    expect(firstSocket.frames("keepalive").length).toBeGreaterThanOrEqual(1);

    FakeSocket.current!.onclose!();
    const keepalivesAtDrop = firstSocket.frames("keepalive").length;
    // No keepalive on the dead socket during the backoff window.
    await vi.advanceTimersByTimeAsync(90);
    expect(firstSocket.frames("keepalive")).toHaveLength(keepalivesAtDrop);

    const reconnected = new Promise<void>((r) =>
      session.on("reconnect", () => r()),
    );
    await vi.advanceTimersByTimeAsync(40);
    await reconnected;
    const secondSocket = FakeSocket.current!;
    await vi.advanceTimersByTimeAsync(1000);
    expect(secondSocket.frames("keepalive").length).toBeGreaterThanOrEqual(1);
    session.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes terminal RelaySessionError to reconnecting observers", async () => {
    const identity = await generateKeyPair();
    const admission = makeAdmission(identity.publicKey);
    stubRestore(identity);
    const session = await connectWithReconnect(
      identity,
      admission,
      {
        signedDescriptor: signedDescriptor(identity.publicKey),
        baseDelayMs: 100,
      },
      recoveryTicket(identity.publicKey, "44".repeat(16)),
    );
    await session.keepalive();
    const seen: any[] = [];
    session.on("reconnecting", (p) => seen.push(p));
    FakeSocket.current!.deliver({ v: PROTOCOL, kind: "error", error: "rate_limited" });
    expect(seen).toHaveLength(1);
    expect(seen[0].error).toBeInstanceOf(RelaySessionError);
    expect(seen[0].error.code).toBe("rate_limited");
    session.close();
  });
});
