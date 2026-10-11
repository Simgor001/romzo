import { describe, expect, it, vi } from "vitest";
import { generateKeyPair, verify, type Identity } from "../src/crypto.js";
import {
  RelaySession,
  RelaySessionError,
  type SocketLike,
} from "../src/session.js";
import { PROTOCOL } from "../src/types.js";
import type { SignedTicket } from "../src/types.js";
import { hash } from "../src/canonical.js";

/** Minimal in-memory socket scripted to act as the relay server. */
class FakeSocket implements SocketLike {
  static current: FakeSocket | null = null;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  /** Server behaviour: called with each parsed client frame. */
  handler: ((frame: any, socket: FakeSocket) => void | Promise<void>) | null =
    null;
  closed = false;

  constructor() {
    FakeSocket.current = this;
    queueMicrotask(() => this.onopen?.());
  }
  send(data: string) {
    this.sent.push(data);
    void this.handler?.(JSON.parse(data), this);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.onclose?.());
  }
  deliver(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  deliverRaw(data: string) {
    this.onmessage?.({ data });
  }
  lastFrame() {
    return JSON.parse(this.sent[this.sent.length - 1]);
  }
}

const factory = () => new FakeSocket();

const PEER_ID = "ab".repeat(16);

function makeAdmission(key: string, purpose = "guest"): SignedTicket {
  return {
    ticket: {
      protocol: PROTOCOL,
      origin: "https://relay.example",
      code: "ABCD2345EF",
      instance: "cd".repeat(16),
      digest: "ef".repeat(32),
      key,
      purpose,
      expires: Date.now() + 60000,
      nonce: "01".repeat(16),
    },
    signature: "aa".repeat(64),
  };
}

function recoveryTicket(key: string, nonce: string): SignedTicket {
  return {
    ticket: {
      protocol: PROTOCOL,
      origin: "https://relay.example",
      code: "ABCD2345EF",
      instance: "cd".repeat(16),
      digest: "ef".repeat(32),
      key,
      purpose: "recovery",
      expires: Date.now() + 30 * 60000,
      nonce,
    },
    signature: "bb".repeat(64),
  };
}

/** Standard scripted server: answers the handshake and then follows `script`. */
function serve(identity: Identity, admission: SignedTicket, script: (socket: FakeSocket) => void) {
  const socket = FakeSocket.current!;
  socket.handler = async (frame, s) => {
    if (frame.kind === "authenticate") {
      expect(frame.admission).toEqual(admission);
      const challenge = {
        protocol: PROTOCOL,
        origin: "https://relay.example",
        ticket: await hash("ru/relay-admission/v1", admission),
        challenge: "f0".repeat(32),
      };
      // Stash for proof verification.
      (s as any).challenge = challenge;
      s.deliver({ v: PROTOCOL, kind: "challenge", value: challenge });
    } else if (frame.kind === "proof") {
      const challenge = (s as any).challenge;
      const ok = await verify(
        identity.publicKey,
        challenge,
        "ru/relay-connect/v1",
        frame.signature,
      );
      expect(ok).toBe(true);
      s.deliver({ v: PROTOCOL, kind: "authenticated", id: PEER_ID });
      script(s);
    }
  };
}

describe("RelaySession (fake socket)", () => {
  it("performs the four-frame handshake and binds the proof to the challenge", async () => {
    const identity = await generateKeyPair();
    const admission = makeAdmission(identity.publicKey);
    const connecting = RelaySession.connect("wss://relay.example/_relic/v1/ws", admission, identity, {
      webSocketFactory: factory,
      keepalive: false,
    });
    serve(identity, admission, () => {});
    const session = await connecting;
    expect(session.id).toBe(PEER_ID);
    session.close();
  });

  it("rejects a challenge that is not bound to the admission ticket", async () => {
    const identity = await generateKeyPair();
    const admission = makeAdmission(identity.publicKey);
    const socket = new FakeSocket();
    socket.handler = (frame, s) => {
      if (frame.kind === "authenticate")
        s.deliver({
          v: PROTOCOL,
          kind: "challenge",
          value: {
            protocol: PROTOCOL,
            origin: "https://relay.example",
            ticket: "00".repeat(32), // wrong digest
            challenge: "f0".repeat(32),
          },
        });
    };
    await expect(
      RelaySession.connect("wss://x", admission, identity, {
        webSocketFactory: () => socket,
        keepalive: false,
      }),
    ).rejects.toThrow("challenge_binding_failed");
  });

  it("subscribes and receives join/leave events", async () => {
    const identity = await generateKeyPair();
    const admission = makeAdmission(identity.publicKey);
    const connecting = RelaySession.connect("wss://x", admission, identity, {
      webSocketFactory: factory,
      keepalive: false,
    });
    serve(identity, admission, (s) => {
      s.handler = (frame) => {
        if (frame.kind === "subscribe")
          s.deliver({ v: PROTOCOL, kind: "ack", id: frame.id });
      };
    });
    const session = await connecting;
    const events: string[] = [];
    session.on("join", (_p, meta) => events.push(`join:${meta.peer}:${meta.key}`));
    session.on("leave", (_p, meta) => events.push(`leave:${meta.peer}`));
    await session.subscribe("lobby");
    const socket = FakeSocket.current!;
    socket.deliver({ v: PROTOCOL, kind: "join", channel: "lobby", peer: "cafe", key: "beef".repeat(16) });
    socket.deliver({ v: PROTOCOL, kind: "leave", channel: "lobby", peer: "cafe" });
    expect(events).toEqual(["join:cafe:" + "beef".repeat(16), "leave:cafe"]);
    session.close();
  });

  it("broadcasts sends and receives payloads", async () => {
    const identity = await generateKeyPair();
    const admission = makeAdmission(identity.publicKey);
    const connecting = RelaySession.connect("wss://x", admission, identity, {
      webSocketFactory: factory,
      keepalive: false,
    });
    serve(identity, admission, (s) => {
      s.handler = (frame) => {
        if (frame.kind === "subscribe" || frame.kind === "send")
          s.deliver({ v: PROTOCOL, kind: "ack", id: frame.id });
      };
    });
    const session = await connecting;
    await session.subscribe("game");
    await session.send("game", { move: 1 });
    const sent = FakeSocket.current!.sent
      .map((s) => JSON.parse(s))
      .find((f) => f.kind === "send");
    expect(sent).toMatchObject({ kind: "send", channel: "game", value: { move: 1 } });
    expect(typeof sent.id).toBe("string");
    const received: unknown[] = [];
    session.on("receive", (value, meta) =>
      received.push([value, meta.peer, meta.channel]),
    );
    FakeSocket.current!.deliver({
      v: PROTOCOL,
      kind: "receive",
      channel: "game",
      peer: "cafe",
      value: { move: 2 },
    });
    expect(received).toEqual([[{ move: 2 }, "cafe", "game"]]);
    session.close();
  });

  it("rejects sends with an application-level error frame (invalid_target)", async () => {
    const identity = await generateKeyPair();
    const admission = makeAdmission(identity.publicKey);
    const connecting = RelaySession.connect("wss://x", admission, identity, {
      webSocketFactory: factory,
      keepalive: false,
    });
    serve(identity, admission, (s) => {
      s.handler = (frame) => {
        if (frame.kind === "subscribe")
          s.deliver({ v: PROTOCOL, kind: "ack", id: frame.id });
        if (frame.kind === "send")
          s.deliver({ v: PROTOCOL, kind: "error", id: frame.id, error: "invalid_target" });
      };
    });
    const session = await connecting;
    await session.subscribe("lobby");
    await expect(session.send("lobby", { x: 1 }, "cafe")).rejects.toThrow(
      RelaySessionError,
    );
    await expect(session.send("lobby", { x: 1 }, "cafe")).rejects.toMatchObject({
      code: "invalid_target",
    });
    session.close();
  });

  it("emits error then close on a terminal error frame", async () => {
    const identity = await generateKeyPair();
    const admission = makeAdmission(identity.publicKey);
    const connecting = RelaySession.connect("wss://x", admission, identity, {
      webSocketFactory: factory,
      keepalive: false,
    });
    serve(identity, admission, () => {});
    const session = await connecting;
    const order: string[] = [];
    session.on("error", (code) => order.push(`error:${code}`));
    session.on("close", () => order.push("close"));
    FakeSocket.current!.deliver({ v: PROTOCOL, kind: "error", error: "invalid_channel" });
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["error:invalid_channel", "close"]);
    expect(session.currentRecovery()).toBeNull();
  });

  it("stores the recovery ticket from keepalive acks", async () => {
    const identity = await generateKeyPair();
    const admission = makeAdmission(identity.publicKey);
    const connecting = RelaySession.connect("wss://x", admission, identity, {
      webSocketFactory: factory,
      keepalive: false,
    });
    const fresh = recoveryTicket(identity.publicKey, "11".repeat(16));
    const saved: SignedTicket[] = [];
    serve(identity, admission, (s) => {
      s.handler = (frame) => {
        if (frame.kind === "subscribe")
          s.deliver({ v: PROTOCOL, kind: "ack", id: frame.id });
        if (frame.kind === "keepalive")
          s.deliver({ v: PROTOCOL, kind: "ack", id: frame.id, recovery: fresh });
      };
    });
    const session = await connecting;
    await session.subscribe("lobby");
    const returned = await session.keepalive();
    expect(returned).toEqual(fresh);
    expect(session.currentRecovery()).toEqual(fresh);
    session.close();
    // onRecovery callback wiring
    expect(saved).toEqual([]);
  });

  it("invokes onRecovery for accepted tickets and ignores mismatched ones", async () => {
    const identity = await generateKeyPair();
    const admission = makeAdmission(identity.publicKey);
    const saved: SignedTicket[] = [];
    const connecting = RelaySession.connect("wss://x", admission, identity, {
      webSocketFactory: factory,
      keepalive: false,
      onRecovery: (t) => void saved.push(t),
    });
    const good = recoveryTicket(identity.publicKey, "22".repeat(16));
    const wrongPurpose = {
      ...recoveryTicket(identity.publicKey, "33".repeat(16)),
    };
    wrongPurpose.ticket = { ...wrongPurpose.ticket, purpose: "guest" };
    serve(identity, admission, (s) => {
      s.handler = (frame) => {
        if (frame.kind === "subscribe")
          s.deliver({ v: PROTOCOL, kind: "ack", id: frame.id });
        if (frame.kind === "keepalive") {
          // Alternate good and mismatched tickets.
          s.deliver({
            v: PROTOCOL,
            kind: "ack",
            id: frame.id,
            recovery: frame.id === "2" ? wrongPurpose : good,
          });
        }
      };
    });
    const session = await connecting;
    await session.subscribe("lobby");
    await session.keepalive();
    await session.keepalive();
    expect(saved).toEqual([good]);
    expect(session.currentRecovery()).toEqual(good);
    session.close();
  });

  it("emits close and rejects pending requests when the transport drops", async () => {
    const identity = await generateKeyPair();
    const admission = makeAdmission(identity.publicKey);
    const connecting = RelaySession.connect("wss://x", admission, identity, {
      webSocketFactory: factory,
      keepalive: false,
    });
    serve(identity, admission, () => {});
    const session = await connecting;
    const closed = new Promise<void>((r) => session.on("close", () => r()));
    FakeSocket.current!.onclose!();
    await closed;
    await expect(session.subscribe("lobby")).rejects.toThrow("closed");
  });
});


describe("handshake state and cleanup", () => {
  it.each(["early authenticated", "duplicate challenge", "wrong origin"])("rejects %s", async (scenario) => {
    const identity = await generateKeyPair();
    const admission = makeAdmission(identity.publicKey);
    const value = { protocol: PROTOCOL, origin: admission.ticket.origin, ticket: await hash("ru/relay-admission/v1", admission), challenge: "aa".repeat(32) };
    const socket = new FakeSocket();
    socket.handler = (frame, s) => {
      if (frame.kind !== "authenticate") return;
      if (scenario === "early authenticated") s.deliver({ v: PROTOCOL, kind: "authenticated", id: PEER_ID });
      else {
        s.deliver({ v: PROTOCOL, kind: "challenge", value: { ...value, origin: scenario === "wrong origin" ? "https://evil.example" : value.origin } });
        if (scenario === "duplicate challenge") s.deliver({ v: PROTOCOL, kind: "challenge", value });
      }
    };
    await expect(RelaySession.connect("wss://relay.example/_relic/v1/ws", admission, identity, { webSocketFactory: () => socket })).rejects.toThrow(scenario === "wrong origin" ? "challenge_binding_failed" : "unexpected_frame_during_handshake");
    expect(socket.closed).toBe(true);
    await new Promise(r => setTimeout(r, 5));
    expect(socket.sent.map(s => JSON.parse(s).kind)).toEqual(["authenticate"]);
  });
  it("does not send proof after close while signing is pending", async () => {
    const identity = await generateKeyPair();
    const admission = makeAdmission(identity.publicKey);
    let release!: (value: ArrayBuffer) => void;
    let started!: () => void;
    const signing = new Promise<void>(resolve => { started = resolve; });
    const spy = vi.spyOn(crypto.subtle, "sign").mockImplementation(() => { started(); return new Promise<ArrayBuffer>(resolve => { release = resolve; }); });
    try {
      const connecting = RelaySession.connect("wss://x", admission, identity, { webSocketFactory: factory });
      const failure = expect(connecting).rejects.toThrow("closed");
      serve(identity, admission, () => {});
      await signing;
      const socket = FakeSocket.current!;
      socket.close();
      await failure;
      release(new ArrayBuffer(64));
      await new Promise(r => setTimeout(r, 0));
      expect(socket.sent.map(s => JSON.parse(s).kind)).toEqual(["authenticate"]);
    } finally { spy.mockRestore(); }
  });
  it.each(["challenge", "authenticated", "unknown", "binary", "malformed"])("closes on post-handshake %s and rejects pending requests", async (kind) => {
    const identity = await generateKeyPair();
    const admission = makeAdmission(identity.publicKey);
    const connecting = RelaySession.connect("wss://x", admission, identity, { webSocketFactory: factory, keepalive: false });
    serve(identity, admission, s => { s.handler = () => {}; });
    const session = await connecting;
    const pending = expect(session.subscribe("lobby")).rejects.toThrow("closed");
    const order: string[] = [];
    session.on("error", () => order.push("error"));
    session.on("close", () => order.push("close"));
    if (kind === "binary") FakeSocket.current!.onmessage!({ data: new Uint8Array(1) });
    else if (kind === "malformed") FakeSocket.current!.deliverRaw("{");
    else FakeSocket.current!.deliver({ v: PROTOCOL, kind });
    await pending;
    expect(order).toEqual(["error", "close"]);
    expect(FakeSocket.current!.closed).toBe(true);
  });
  it("keeps an idle subscribed connection alive every 10 seconds and stops on close", async () => {
    const identity = await generateKeyPair();
    const admission = makeAdmission(identity.publicKey);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    let session: RelaySession | undefined;
    try {
      const connecting = RelaySession.connect("wss://x", admission, identity, { webSocketFactory: factory });
      serve(identity, admission, s => { s.handler = frame => s.deliver({ v: PROTOCOL, kind: "ack", id: frame.id }); });
      session = await connecting;
      await session.subscribe("lobby");
      await vi.advanceTimersByTimeAsync(40000);
      expect(FakeSocket.current!.sent.map(s => JSON.parse(s)).filter(f => f.kind === "keepalive")).toHaveLength(4);
      session.close();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(50000);
      expect(FakeSocket.current!.sent.map(s => JSON.parse(s)).filter(f => f.kind === "keepalive")).toHaveLength(4);
    } finally { session?.close(); vi.useRealTimers(); }
  });
});
