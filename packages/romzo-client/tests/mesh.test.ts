import { afterEach, describe, expect, it, vi } from "vitest";
import { hash } from "../src/canonical.js";
import { generateKeyPair, sign, type Identity } from "../src/crypto.js";
import { MeshSession, attachMesh, type MeshDataChannel, type MeshPeerConnection, type MeshDescription, type MeshIceCandidate, type MeshOptions } from "../src/mesh.js";
import { RelaySession, type SocketLike } from "../src/session.js";
import { PROTOCOL, type Member, type SignedDescriptor, type SignedTicket } from "../src/types.js";

const live: MeshSession[] = [];
afterEach(() => { for (const mesh of live.splice(0)) mesh.close(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const tick = () => new Promise<void>(r => setTimeout(r, 0));
async function until(predicate: () => boolean, timeout = 1000) { const end = Date.now() + timeout; while (Date.now() < end) { if (predicate()) return; await tick(); } throw new Error("condition not reached"); }

class Socket implements SocketLike {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  key = "";
  channels = new Set<string>();
  closed = false;
  admission!: SignedTicket;
  constructor(readonly hub: Hub, readonly id: string) { queueMicrotask(() => this.onopen?.()); }
  deliver(frame: object) { queueMicrotask(() => { if (!this.closed) this.onmessage?.({ data: JSON.stringify({ v: PROTOCOL, ...frame }) }); }); }
  send(data: string) { void this.hub.frame(this, JSON.parse(data)); }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const c of this.channels) for (const s of this.hub.sockets) if (s !== this && s.channels.has(c)) s.deliver({ kind: "leave", channel: c, ...this.member });
    this.channels.clear(); queueMicrotask(() => this.onclose?.());
  }
  get member(): Member { return { peer: this.id, key: this.key, joinSeq: this.hub.keyOrder.indexOf(this.key) + 1 }; }
}
class Hub {
  sockets: Socket[] = [];
  keyOrder: string[] = [];
  sent: { socket: Socket; frame: any }[] = [];
  hold?: (s: Socket, f: any) => boolean;
  held: (() => void)[] = [];
  reject?: (s: Socket, f: any) => boolean;
  static async create() {
    const host = await generateKeyPair();
    const descriptor = { protocol: PROTOCOL, origin: "https://relay.example", code: "ABCD2345EF", instance: "ab".repeat(16),
      host: host.publicKey, transport: host.publicKey, capability: "cd".repeat(16),
      options: { channels: [{ name: "chat", maxFrameBytes: 16384 }, { name: "state", maxFrameBytes: 262144 }, { name: "signal", maxFrameBytes: 16384 }] }, configHash: "" };
    descriptor.configHash = await hash("romzo/lobby-options/v1", descriptor.options);
    const signed = { descriptor, signature: await sign(host, descriptor, "romzo/relay-descriptor/v1") };
    return new Hub(signed);
  }
  constructor(readonly signed: SignedDescriptor) {}
  factory = () => { const s = new Socket(this, this.sockets.length.toString(16).padStart(32, "0")); this.sockets.push(s); return s; };
  async admission(identity: Identity): Promise<SignedTicket> {
    return { ticket: { protocol: PROTOCOL, origin: this.signed.descriptor.origin, code: this.signed.descriptor.code,
      instance: this.signed.descriptor.instance, digest: await hash("romzo/relay-descriptor/v1", this.signed), key: identity.publicKey,
      purpose: "guest", expires: Date.now() + 60000, nonce: "ef".repeat(16) }, signature: "00".repeat(32) };
  }
  async relay(identity?: Identity, reconnect = false) {
    identity ??= await generateKeyPair();
    const admission = await this.admission(identity);
    const relay = await RelaySession.connect("wss://relay.example/ws", admission, identity, {
      webSocketFactory: this.factory, keepalive: false,
      ...(reconnect ? { autoReconnect: { signedDescriptor: this.signed, baseDelayMs: 1, maxDelayMs: 1 } } : {}),
    });
    return { relay, identity, socket: this.sockets.at(-1)! };
  }
  async mesh(network?: Network, options: Partial<MeshOptions> = {}, identity?: Identity) {
    const material = await this.relay(identity);
    // Tests model the no-WebRTC environment explicitly, independent of host globals.
    const mesh = await attachMesh(material.relay, material.identity, { signedDescriptor: this.signed,
      ...(network ? { rtcPeerConnectionFactory: network.factory } : {}), ...options });
    live.push(mesh); await mesh.subscribe("chat"); await mesh.subscribe("state");
    return { ...material, mesh };
  }
  async frame(s: Socket, f: any) {
    if (f.kind === "authenticate") {
      s.admission = f.admission; s.key = f.admission.ticket.key;
      if (!this.keyOrder.includes(s.key)) this.keyOrder.push(s.key);
      s.deliver({ kind: "challenge", value: { protocol: PROTOCOL, origin: this.signed.descriptor.origin,
        ticket: await hash("romzo/relay-admission/v1", f.admission), challenge: "f0".repeat(32) } });
    } else if (f.kind === "proof") s.deliver({ kind: "authenticated", id: s.id, key: s.key, joinSeq: s.member.joinSeq });
    else {
      this.sent.push({ socket: s, frame: f });
      if (f.kind === "subscribe") {
        if (!s.channels.has(f.channel)) {
          s.channels.add(f.channel);
          for (const other of this.sockets) if (other !== s && other.channels.has(f.channel)) {
            s.deliver({ kind: "join", channel: f.channel, ...other.member }); other.deliver({ kind: "join", channel: f.channel, ...s.member });
          }
        }
        s.deliver({ kind: "ack", id: f.id, channel: f.channel,
          value: { members: this.sockets.filter(o => o.channels.has(f.channel)).map(o => o.member) } });
      } else if (f.kind === "unsubscribe") {
        s.channels.delete(f.channel);
        for (const other of this.sockets) if (other !== s && other.channels.has(f.channel)) other.deliver({ kind: "leave", channel: f.channel, ...s.member });
        s.deliver({ kind: "ack", id: f.id });
      } else if (f.kind === "send") {
        if (this.reject?.(s, f)) { s.deliver({ kind: "error", id: f.id, error: "invalid_target" }); return; }
        const deliver = () => {
          for (const other of this.sockets) if (other !== s && other.channels.has(f.channel) && (!f.target || f.target === other.id))
            other.deliver({ kind: "receive", channel: f.channel, value: f.value, ...s.member });
        };
        if (this.hold?.(s, f)) this.held.push(deliver); else deliver();
        s.deliver({ kind: "ack", id: f.id });
      } else if (f.kind === "keepalive") s.deliver({ kind: "ack", id: f.id,
        recovery: { ...s.admission, ticket: { ...s.admission.ticket, purpose: "recovery" } } });
    }
  }
}
class DC implements MeshDataChannel {
  readyState = "connecting";
  bufferedAmount = 0;
  ordered = true;
  maxRetransmits = null;
  maxPacketLifeTime = null;
  bufferedAmountLowThreshold = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onbufferedamountlow: (() => void) | null = null;
  partner?: DC;
  sent: string[] = [];
  lose = false;
  send(data: string) { if (this.readyState !== "open") throw new Error("closed"); this.sent.push(data); if (!this.lose) queueMicrotask(() => this.partner?.onmessage?.({ data })); }
  close() {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    const handler = this.onclose; queueMicrotask(() => handler?.());
    this.partner?.close();
  }
  open() { this.readyState = "open"; queueMicrotask(() => this.onopen?.()); }
  drain() { this.bufferedAmount = 0; this.onbufferedamountlow?.(); }
}
class PC implements MeshPeerConnection {
  connectionState = "new";
  localDescription: MeshDescription | null = null;
  remoteDescription: MeshDescription | null = null;
  sctp = { maxMessageSize: 262144 };
  onicecandidate: ((e: { candidate: MeshIceCandidate | null }) => void) | null = null;
  ondatachannel: ((e: { channel: MeshDataChannel }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  dc?: DC;
  remote?: PC;
  candidates: (MeshIceCandidate | null)[] = [];
  offers = 0;
  closed = false;
  constructor(readonly network: Network, readonly id: number) {}
  createDataChannel() { this.dc = new DC(); return this.dc; }
  description(type: "offer" | "answer"): MeshDescription { return { type, sdp: `v=0\r\na=ice-ufrag:ufrag${this.id}\r\na=x-mock:${this.id}\r\n` }; }
  async createOffer() { this.offers++; return this.description("offer"); }
  async createAnswer() {
    if (this.network.delayAnswerOnce) {
      this.network.delayAnswerOnce = false;
      return new Promise<MeshDescription>((resolve, reject) => {
        this.network.finishOldAnswer = fail => fail ? reject(new Error("old answer rejected")) : resolve(this.description("answer"));
      });
    }
    return this.description("answer");
  }
  async setLocalDescription(d: MeshDescription) { this.localDescription = d; }
  async setRemoteDescription(d: MeshDescription) {
    this.remoteDescription = d;
    const id = Number(d.sdp?.match(/a=x-mock:(\d+)/)?.[1]);
    this.remote = this.network.pcs[id];
    if (d.type === "offer") {
      this.dc = new DC(); this.dc.partner = this.remote.dc; this.remote.dc!.partner = this.dc;
      this.ondatachannel?.({ channel: this.dc });
    } else { this.connectionState = "connected"; this.remote.connectionState = "connected"; this.dc?.open(); this.remote.dc?.open(); }
  }
  async addIceCandidate(c: MeshIceCandidate | null) { this.candidates.push(c); }
  close() { this.closed = true; this.connectionState = "closed"; this.dc?.close(); }
}
class Network {
  pcs: PC[] = [];
  delayAnswerOnce = false;
  finishOldAnswer?: (fail?: boolean) => void;
  factory = () => { const pc = new PC(this, this.pcs.length); this.pcs.push(pc); return pc; };
}
async function pair(identity?: Identity) {
  const hub = await Hub.create(), network = new Network();
  const a = await hub.mesh(network, {}, identity), b = await hub.mesh(network, {}, identity);
  await until(() => a.mesh.path(b.mesh.id) === "rtc" && b.mesh.path(a.mesh.id) === "rtc");
  return { hub, network, a, b };
}
describe("mesh binding and public API", () => {
  it("freezes room binding, requires a verified matching descriptor and matching signing identity", async () => {
    const hub = await Hub.create(), { relay, identity } = await hub.relay();
    expect(Object.isFrozen(relay.roomBinding)).toBe(true);
    expect(relay.roomBinding.digest).toBe(await hash("romzo/relay-descriptor/v1", hub.signed));
    await expect(attachMesh(relay, await generateKeyPair(), { signedDescriptor: hub.signed })).rejects.toThrow("identity_mismatch");
    const foreign = await Hub.create();
    await expect(attachMesh(relay, identity, { signedDescriptor: foreign.signed })).rejects.toThrow("room_binding_mismatch");
    const corrupt = { ...hub.signed, signature: "00".repeat(64) };
    await expect(attachMesh(relay, identity, { signedDescriptor: corrupt })).rejects.toThrow("invalid_descriptor");
    const mesh = await attachMesh(relay, identity, { signedDescriptor: hub.signed }); live.push(mesh);
    expect(mesh.id).toBe(relay.id); expect(mesh.key).toBe(identity.publicKey); expect(mesh.joinSeq).toBe(relay.joinSeq);
    await expect(attachMesh(relay, identity, { signedDescriptor: hub.signed })).rejects.toThrow("already_attached");
    expect(mesh.members("signal")).toEqual([]);
    for (const op of [mesh.subscribe("signal"), mesh.unsubscribe("signal"), mesh.send("signal", 1)]) await expect(op).rejects.toThrow("reserved_channel");
    await mesh.subscribe("chat"); await mesh.keepalive(); expect(mesh.currentRecovery()).toEqual(relay.currentRecovery());
    const handler = vi.fn(); mesh.on("close", handler); mesh.off("close", handler); mesh.close(); mesh.close(); expect(handler).not.toHaveBeenCalled();
  });
  it("does not close a caller-owned relay when attachment options fail", async () => {
    const hub = await Hub.create(), m = await hub.relay();
    await expect(attachMesh(m.relay, m.identity, { signedDescriptor: hub.signed, signalChannel: "missing" })).rejects.toThrow("missing_signal");
    await m.relay.subscribe("chat"); expect(m.socket.closed).toBe(false); m.relay.close();
  });
  it("failed attachment removes only its own signal subscription and permits another attempt", async () => {
    const hub = await Hub.create(), m = await hub.relay();
    const original = m.relay.subscribe.bind(m.relay);
    vi.spyOn(m.relay, "subscribe").mockImplementationOnce(async c => { await original(c); throw new Error("lost subscribe ack"); });
    await expect(attachMesh(m.relay, m.identity, { signedDescriptor: hub.signed })).rejects.toThrow("lost subscribe ack");
    expect(m.socket.channels.has("signal")).toBe(false); expect(m.socket.closed).toBe(false);
    const mesh = await attachMesh(m.relay, m.identity, { signedDescriptor: hub.signed }); live.push(mesh);
    expect(m.socket.channels.has("signal")).toBe(true);
  });
  it("without WebRTC uses a single native relay broadcast and hides signal events", async () => {
    const hub = await Hub.create(); const a = await hub.mesh(), b = await hub.mesh(), c = await hub.mesh();
    const receive = vi.fn(); b.mesh.on("receive", receive); await tick();
    await a.mesh.send("chat", { seq: 1 }); await tick();
    expect(receive).toHaveBeenCalledExactlyOnceWith({ seq: 1 }, expect.objectContaining({ peer: a.mesh.id, key: a.mesh.key, joinSeq: 1 }));
    expect(hub.sent.filter(e => e.frame.kind === "send" && e.frame.channel === "chat")).toHaveLength(1);
    expect(hub.sent.find(e => e.frame.channel === "chat" && e.frame.kind === "send")!.frame.target).toBeUndefined();
    expect(a.mesh.path(c.mesh.id)).toBe("relay"); expect(a.mesh.path("absent")).toBeNull();
    await expect(a.mesh.send("chat", 1, a.mesh.id)).rejects.toThrow("invalid_target");
    await expect(a.mesh.send("chat", undefined)).rejects.toThrow("invalid_json");
    await expect(a.mesh.send("chat", "汉".repeat(6000))).rejects.toThrow("frame_too_large");
  });
});

describe("mesh negotiation and routing", () => {
  it("late join, finite hello and a single reliable ordered DC deliver both ways", async () => {
    const { a, b, hub, network } = await pair();
    expect(network.pcs.reduce((n, p) => n + p.offers, 0)).toBe(1);
    await tick(); const count = hub.sent.length; await tick(); expect(hub.sent.length).toBe(count);
    expect(hub.sent.filter(e => e.frame.value?.kind === "hello")).toHaveLength(4);
    const rxA = vi.fn(), rxB = vi.fn(); a.mesh.on("receive", rxA); b.mesh.on("receive", rxB);
    await a.mesh.send("chat", { text: "a" }); await b.mesh.send("chat", { text: "b" }); await tick();
    expect(rxB).toHaveBeenCalledExactlyOnceWith({ text: "a" }, expect.objectContaining({ peer: a.mesh.id, key: a.mesh.key }));
    expect(rxA).toHaveBeenCalledExactlyOnceWith({ text: "b" }, expect.objectContaining({ peer: b.mesh.id, key: b.mesh.key }));
    expect(hub.sent.filter(e => e.frame.channel === "chat" && e.frame.kind === "send")).toHaveLength(0);
    const extra = new DC(); network.pcs[1].ondatachannel?.({ channel: extra }); expect(extra.readyState).toBe("closed");
  });
  it("shared-key connections break initiator ties by peer id", async () => {
    const { hub, a, b } = await pair(await generateKeyPair());
    expect(a.mesh.key).toBe(b.mesh.key);
    const offers = hub.sent.filter(e => e.frame.value?.kind === "offer");
    expect(offers).toHaveLength(1); expect(offers[0].socket.id).toBe(a.mesh.id);
  });
  it("three peers use RTC plus one directed relay copy without duplicate delivery", async () => {
    const { a, b, hub } = await pair(); const c = await hub.mesh();
    const rxB = vi.fn(), rxC = vi.fn(); b.mesh.on("receive", rxB); c.mesh.on("receive", rxC);
    await a.mesh.send("chat", { seq: 7 }); await tick();
    expect(rxB).toHaveBeenCalledTimes(1); expect(rxC).toHaveBeenCalledTimes(1);
    const sends = hub.sent.filter(e => e.frame.channel === "chat" && e.frame.kind === "send");
    expect(sends).toHaveLength(1); expect(sends[0].frame.target).toBe(c.mesh.id);
  });
  it("cross-path overtaking is observable; an enqueued then lost DC message is not resent", async () => {
    const hub = await Hub.create(), network = new Network();
    const a = await hub.mesh(network); hub.hold = (_s, f) => f.channel === "chat";
    const bMaterial = await hub.relay(); await bMaterial.relay.subscribe("chat");
    const values: unknown[] = []; bMaterial.relay.on("receive", (v, meta) => { if (meta.channel === "chat") values.push(v); });
    await a.mesh.send("chat", { seq: 10 });
    const bMesh = await attachMesh(bMaterial.relay, bMaterial.identity, { signedDescriptor: hub.signed, rtcPeerConnectionFactory: network.factory }); live.push(bMesh);
    bMesh.on("receive", (v, meta) => { if (meta.channel === "chat") values.push(v); });
    await until(() => a.mesh.path(bMesh.id) === "rtc");
    await a.mesh.send("chat", { seq: 11 }); await tick(); hub.held.splice(0).forEach(f => f()); await tick();
    // Relay escape hatch also observes relay receives; count the application wrapper exactly once.
    expect(values[0]).toEqual({ seq: 11 }); expect(values[1]).toEqual({ seq: 10 });
    const pc = hub.sent.find(e => e.frame.value?.kind === "offer")!.socket.id === a.mesh.id ? network.pcs[0] : network.pcs[1];
    pc.dc!.lose = true; const before = hub.sent.filter(e => e.frame.channel === "chat" && e.frame.kind === "send").length;
    await a.mesh.send("chat", { seq: 12 }); pc.dc!.close(); await tick();
    expect(values.some((v: any) => v.seq === 12)).toBe(false);
    expect(hub.sent.filter(e => e.frame.channel === "chat" && e.frame.kind === "send")).toHaveLength(before);
    expect(a.mesh.path(bMesh.id)).toBe("relay");
  });
  it("unsubscribe changes membership and prevents RTC send and receive", async () => {
    const { a, b, network } = await pair(); const rx = vi.fn(); b.mesh.on("receive", rx);
    await b.mesh.unsubscribe("chat"); await tick();
    await expect(a.mesh.send("chat", 1, b.mesh.id)).rejects.toThrow("invalid_target");
    await expect(b.mesh.send("chat", 1, a.mesh.id)).rejects.toThrow("unsubscribed");
    for (const pc of network.pcs) pc.dc?.onmessage?.({ data: JSON.stringify({ v: 1, channel: "chat", value: "late" }) });
    expect(rx).not.toHaveBeenCalled();
  });
  it("binds signatures to recipient, room and generation, rejecting tampered SDP", async () => {
    const hub = await Hub.create(), network = new Network();
    hub.hold = (_s, f) => f.value?.kind === "offer";
    const a = await hub.mesh(network), b = await hub.mesh(network);
    await until(() => hub.sent.some(e => e.frame.value?.kind === "offer"));
    const offer = hub.sent.find(e => e.frame.value?.kind === "offer")!;
    const target = offer.frame.target === a.mesh.id ? a : b;
    const errors = vi.fn(); target.mesh.on("error", errors);
    target.socket.deliver({ kind: "receive", channel: "signal", ...offer.socket.member, value: { ...offer.frame.value, sdp: offer.frame.value.sdp + "tampered" } });
    await until(() => errors.mock.calls.length > 0);
    expect(errors.mock.calls[0][0]).toContain("invalid_sdp_signature"); expect(network.pcs).toHaveLength(1);
  });
  it("buffers pre-offer ICE, ignores stale generation and ICE ufrag, handles end-of-candidates", async () => {
    const hub = await Hub.create(), network = new Network(); hub.hold = (_s, f) => f.value?.kind === "offer";
    const a = await hub.mesh(network), b = await hub.mesh(network);
    await until(() => hub.sent.some(e => e.frame.value?.kind === "offer"));
    const offer = hub.sent.find(e => e.frame.value?.kind === "offer")!;
    const target = offer.frame.target === a.mesh.id ? a : b;
    const base = offer.frame.value;
    const candidate = { candidate: "candidate:mock", sdpMid: "0", usernameFragment: "ufrag0" };
    for (const [generation, c] of [[0, candidate], [1, candidate], [1, { ...candidate, usernameFragment: "old" }], [1, null]] as const)
      target.socket.deliver({ kind: "receive", channel: "signal", ...offer.socket.member, value: { v: 1, room: base.room, from: base.from, to: base.to, generation, kind: "candidate", candidate: c } });
    await tick(); hub.held.splice(0).forEach(f => f());
    await until(() => network.pcs.length === 2 && network.pcs[1].candidates.length === 2);
    expect(network.pcs[1].candidates).toEqual([candidate, null]);
  });
  it("negotiation failure retries once and keeps relay usable", async () => {
    const hub = await Hub.create(); let attempts = 0;
    const factory = () => { attempts++; throw new Error("RTC unavailable"); };
    const a = await hub.mesh(undefined, { rtcPeerConnectionFactory: factory });
    const b = await hub.mesh(undefined, { rtcPeerConnectionFactory: factory });
    await until(() => attempts === 1);
    await until(() => attempts === 2, 3000);
    await new Promise(r => setTimeout(r, 2100)); expect(attempts).toBe(2);
    const rx = vi.fn(); b.mesh.on("receive", rx); await a.mesh.send("chat", "fallback");
    await tick(); expect(rx).toHaveBeenCalledTimes(1);
    expect(a.mesh.path(b.mesh.id)).toBe("relay");
  }, 7000);
  it("saved old-PC callbacks cannot resurrect a connection after close", async () => {
    const { a, b, network, hub } = await pair();
    const pc = network.pcs[0], onIce = pc.onicecandidate, onOpen = pc.dc!.onopen;
    a.mesh.close(); b.mesh.close(); const before = hub.sent.length;
    onIce?.({ candidate: { candidate: "old" } }); onOpen?.(); await tick();
    expect(hub.sent).toHaveLength(before); expect(network.pcs.every(p => p.closed)).toBe(true);
    expect(a.mesh.path(b.mesh.id)).toBeNull();
  });
  it("a hung old answer times out, restarts once, and cannot block or overwrite generation two", async () => {
    const hub = await Hub.create(), network = new Network(); network.delayAnswerOnce = true;
    const a = await hub.mesh(network, { negotiationTimeoutMs: 60 });
    const b = await hub.mesh(network, { negotiationTimeoutMs: 60 });
    await until(() => network.pcs.length === 4 && a.mesh.path(b.mesh.id) === "rtc", 3000);
    const offers = hub.sent.filter(e => e.frame.value?.kind === "offer");
    expect(offers.map(e => e.frame.value.generation)).toEqual([1, 2]);
    expect(network.pcs.slice(0, 2).every(pc => pc.closed)).toBe(true);
    network.finishOldAnswer?.(true); await tick();
    expect(a.mesh.path(b.mesh.id)).toBe("rtc");
    expect(hub.sent.filter(e => e.frame.value?.kind === "answer").map(e => e.frame.value.generation)).toEqual([2]);
  });
  it("resets the retry budget after a successful connection", async () => {
    const { a, b, network, hub } = await pair();
    const offers = () => hub.sent.filter(e => e.frame.value?.kind === "offer").length;
    expect(offers()).toBe(1);
    // First drop after a healthy period: one backoff retry rebuilds the connection.
    network.pcs[0].dc!.close();
    await until(() => a.mesh.path(b.mesh.id) === "relay", 2000);
    await until(() => a.mesh.path(b.mesh.id) === "rtc", 5000);
    expect(offers()).toBe(2);
    // A lifetime failure budget would be exhausted by this second drop and stay relay.
    network.pcs[2].dc!.close();
    await until(() => a.mesh.path(b.mesh.id) === "relay", 2000);
    await until(() => a.mesh.path(b.mesh.id) === "rtc", 5000);
    expect(offers()).toBe(3);
    expect(b.mesh.path(a.mesh.id)).toBe("rtc");
  }, 15000);
  it("rejects malformed RTC frames and never trusts self-reported identity metadata", async () => {
    const { a, b, network } = await pair(); const rx = vi.fn(); a.mesh.on("receive", rx); b.mesh.on("receive", rx);
    network.pcs[0].dc!.onmessage?.({ data: JSON.stringify({ v: 1, channel: "chat", value: "ok", peer: "forged", key: "forged" }) });
    expect(rx).toHaveBeenCalledTimes(1); expect(rx.mock.calls[0][1].peer).not.toBe("forged");
    network.pcs[0].dc!.onmessage?.({ data: JSON.stringify({ v: 1, channel: "signal", value: "bad" }) }); await tick();
    expect(rx).toHaveBeenCalledTimes(1); expect(network.pcs[0].closed).toBe(true);
  });
  it("bounds early candidates before an offer instead of retaining arbitrary signaling", async () => {
    const hub = await Hub.create(), network = new Network(); hub.hold = (_s, f) => f.value?.kind === "offer";
    const a = await hub.mesh(network), b = await hub.mesh(network);
    await until(() => hub.sent.some(e => e.frame.value?.kind === "offer"));
    const { socket, frame } = hub.sent.find(e => e.frame.value?.kind === "offer")!;
    const target = frame.target === a.mesh.id ? a : b;
    const rx = vi.fn(); target.mesh.on("error", rx);
    for (let i = 0; i < 65; i++) {
      const { room, from, to, generation } = frame.value;
      target.socket.deliver({ kind: "receive", channel: "signal", ...socket.member,
        value: { v: 1, room, from, to, generation, kind: "candidate", candidate: { candidate: "candidate:mock" } } });
    }
    await until(() => rx.mock.calls.some(c => c[0].includes("candidate_queue_full")));
    expect(target.mesh.path(socket.id)).toBe("relay");
  });
});

describe("mesh bounded scheduling", () => {
  it("SCTP size fallback uses relay while the peer remains RTC-capable", async () => {
    const { a, b, hub, network } = await pair(); for (const pc of network.pcs) pc.sctp.maxMessageSize = 16;
    const rx = vi.fn(); b.mesh.on("receive", rx); await a.mesh.send("chat", "larger than SCTP"); await tick();
    expect(rx).toHaveBeenCalledTimes(1); expect(a.mesh.path(b.mesh.id)).toBe("rtc");
    expect(hub.sent.filter(e => e.frame.kind === "send" && e.frame.channel === "chat")).toHaveLength(1);
  });
  it("backpressure waits for drain, rejects atomically when queue is full, and expires", async () => {
    const hub = await Hub.create(), network = new Network();
    const a = await hub.mesh(network, { maxQueuedItems: 1, queueTimeoutMs: 80, bufferedAmountHighWaterMark: 128, bufferedAmountLowWaterMark: 32 });
    const b = await hub.mesh(network); await until(() => a.mesh.path(b.mesh.id) === "rtc");
    const pc = hub.sent.find(e => e.frame.value?.kind === "offer")!.socket.id === a.mesh.id ? network.pcs[0] : network.pcs[1];
    pc.dc!.bufferedAmount = 128;
    const first = a.mesh.send("chat", { seq: 1 });
    await expect(a.mesh.send("chat", { seq: 2 })).rejects.toThrow("queue_full");
    expect(pc.dc!.sent).toHaveLength(0); pc.dc!.drain(); await first; expect(pc.dc!.sent).toHaveLength(1);
    pc.dc!.bufferedAmount = 128;
    await expect(a.mesh.send("chat", "timeout")).rejects.toThrow("queue_timeout");
    // Messages larger than high water mark can progress when the buffer is empty.
    pc.dc!.drain(); await a.mesh.send("chat", "x".repeat(256)); expect(pc.dc!.sent).toHaveLength(2);
  });
  it("mixed broadcast reserves every recipient before sending any copy", async () => {
    const hub = await Hub.create(), network = new Network();
    const a = await hub.mesh(network, { maxQueuedItems: 1 }), b = await hub.mesh(network);
    await until(() => a.mesh.path(b.mesh.id) === "rtc"); const c = await hub.mesh();
    const rxB = vi.fn(), rxC = vi.fn(); b.mesh.on("receive", rxB); c.mesh.on("receive", rxC);
    await expect(a.mesh.send("chat", "no partial reservation")).rejects.toThrow("queue_full"); await tick();
    expect(rxB).not.toHaveBeenCalled(); expect(rxC).not.toHaveBeenCalled();
  });
  it("partial relay failure rejects without resending the successful RTC copy", async () => {
    const { a, b, hub } = await pair(); const c = await hub.mesh(); const rx = vi.fn(); b.mesh.on("receive", rx);
    hub.reject = (_s, f) => f.channel === "chat" && f.target === c.mesh.id;
    await expect(a.mesh.send("chat", "partial")).rejects.toThrow("invalid_target"); await tick();
    expect(rx).toHaveBeenCalledTimes(1);
  });
  it("frame and byte budgets throttle instead of dropping application sends", async () => {
    const hub = await Hub.create(); const a = await hub.mesh(undefined, { relayFramesPerSecond: 10, relayFrameBurst: 1 });
    const b = await hub.mesh(); await tick();
    // Let discovery drain before measuring the shared budget.
    await new Promise(r => setTimeout(r, 250));
    const rx = vi.fn(); b.mesh.on("receive", rx);
    const p1 = a.mesh.send("chat", 1), p2 = a.mesh.send("chat", 2);
    await tick(); expect(hub.sent.filter(e => e.socket === a.socket && e.frame.channel === "chat" && e.frame.kind === "send")).toHaveLength(1);
    await Promise.all([p1, p2]); await tick(); expect(rx.mock.calls.map(c => c[0])).toEqual([1, 2]);
  });
  it("byte budget and reservation bytes bound large sends", async () => {
    const hub = await Hub.create();
    const a = await hub.mesh(undefined, { relayBytesPerSecond: 1000, relayByteBurst: 4096, maxQueuedBytes: 4096 });
    const b = await hub.mesh(); await new Promise(r => setTimeout(r, 1000));
    const rx = vi.fn(); b.mesh.on("receive", rx);
    const first = a.mesh.send("chat", "a".repeat(2200)); await first;
    const second = a.mesh.send("chat", "b".repeat(2200));
    await tick(); expect(rx).toHaveBeenCalledTimes(1);
    await expect(a.mesh.send("chat", "c".repeat(2200))).rejects.toThrow("queue_full");
    await second; await tick(); expect(rx).toHaveBeenCalledTimes(2);
    await expect(a.mesh.send("chat", "d".repeat(4100))).rejects.toThrow("frame_exceeds_budget_burst");
  });
  it("underlying relay close rejects backpressured sends and emits close exactly once", async () => {
    const { a, b, network, hub } = await pair(); const close = vi.fn(); a.mesh.on("close", close);
    const pc = hub.sent.find(e => e.frame.value?.kind === "offer")!.socket.id === a.mesh.id ? network.pcs[0] : network.pcs[1];
    pc.dc!.bufferedAmount = 1024 * 1024;
    const pending = a.mesh.send("chat", "blocked"); const rejected = expect(pending).rejects.toThrow();
    a.relay.close(); await rejected; expect(close).toHaveBeenCalledTimes(1); expect(a.mesh.path(b.mesh.id)).toBeNull();
    a.mesh.close(); expect(close).toHaveBeenCalledTimes(1);
  });
  it("a targeted relay send cannot overtake a budget-blocked broadcast to that same peer", async () => {
    const hub = await Hub.create();
    const a = await hub.mesh(undefined, { relayBytesPerSecond: 2000, relayByteBurst: 4096 }); const b = await hub.mesh();
    await new Promise(r => setTimeout(r, 500));
    const rx = vi.fn(); b.mesh.on("receive", rx);
    await a.mesh.send("chat", "consume".repeat(300)); await tick(); rx.mockClear();
    const first = a.mesh.send("chat", { seq: 1, text: "x".repeat(2800) });
    const second = a.mesh.send("chat", { seq: 2 }, b.mesh.id);
    await Promise.all([first, second]); await tick(); expect(rx.mock.calls.map(c => c[0].seq)).toEqual([1, 2]);
  });
});
