import { hash } from "./canonical.js";
import { sign, verify, type Identity } from "./crypto.js";
import { verifyDescriptor } from "./facade.js";
import { encodeFrame, RelaySession, RelaySessionError, type SessionEvent, type SessionMeta, type SessionOptions } from "./session.js";
import { MAX_FRAME_BYTES, type Member, type SignedDescriptor, type SignedTicket } from "./types.js";

/** Structural WebRTC surfaces: consumers do not need lib.dom. */
type MeshEventHandler<E> = { handle(event: E): void }["handle"];
type MeshLifecycleHandler = { handle(event?: unknown): void }["handle"];
export interface MeshRtcConfiguration {
  iceServers?: { urls: string | string[]; username?: string; credential?: string }[];
  iceTransportPolicy?: "all" | "relay";
  bundlePolicy?: "balanced" | "max-compat" | "max-bundle";
  rtcpMuxPolicy?: "require";
  iceCandidatePoolSize?: number;
}
export interface MeshIceCandidate {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}
export interface MeshDescription { type: "offer" | "answer" | "pranswer" | "rollback"; sdp?: string }
export interface MeshDataChannel {
  readonly readyState: string;
  readonly bufferedAmount: number;
  readonly ordered: boolean;
  readonly maxRetransmits: number | null;
  readonly maxPacketLifeTime: number | null;
  bufferedAmountLowThreshold: number;
  onopen: MeshLifecycleHandler | null;
  onclose: MeshLifecycleHandler | null;
  onerror: MeshLifecycleHandler | null;
  onmessage: MeshEventHandler<{ data: unknown }> | null;
  onbufferedamountlow: MeshLifecycleHandler | null;
  send(data: string): void;
  close(): void;
}
export interface MeshPeerConnection {
  readonly connectionState: string;
  readonly localDescription: MeshDescription | null;
  readonly remoteDescription: MeshDescription | null;
  readonly sctp: { readonly maxMessageSize: number } | null;
  onicecandidate: MeshEventHandler<{ candidate: (MeshIceCandidate & { toJSON?(): MeshIceCandidate }) | null }> | null;
  ondatachannel: MeshEventHandler<{ channel: MeshDataChannel }> | null;
  onconnectionstatechange: MeshLifecycleHandler | null;
  createDataChannel(label: string, options: { ordered: boolean }): MeshDataChannel;
  createOffer(): Promise<MeshDescription>;
  createAnswer(): Promise<MeshDescription>;
  setLocalDescription(description: MeshDescription): Promise<void>;
  setRemoteDescription(description: MeshDescription): Promise<void>;
  addIceCandidate(candidate: MeshIceCandidate | null): Promise<void>;
  close(): void;
}
export type MeshPath = "relay" | "connecting" | "rtc";
export interface MeshOptions {
  signedDescriptor: SignedDescriptor;
  rtcConfig?: MeshRtcConfiguration;
  signalChannel?: string;
  negotiationTimeoutMs?: number;
  onPath?: (peer: string, path: MeshPath) => void;
  rtcPeerConnectionFactory?: (config: MeshRtcConfiguration) => MeshPeerConnection;
  maxQueuedItems?: number;
  maxQueuedBytes?: number;
  queueTimeoutMs?: number;
  relayFramesPerSecond?: number;
  relayFrameBurst?: number;
  relayBytesPerSecond?: number;
  relayByteBurst?: number;
  bufferedAmountHighWaterMark?: number;
  bufferedAmountLowWaterMark?: number;
}
export class MeshSessionError extends Error {
  constructor(readonly code: string) { super(`mesh session error: ${code}`); this.name = "MeshSessionError"; }
}
type Handler = (payload: unknown, meta: SessionMeta) => void;
type Binding = RelaySession["roomBinding"];
type SignalBase = { v: 1; room: Binding; from: string; to: string; generation: number };
type Signal = SignalBase & (
  | { kind: "hello"; reply: boolean; rtc: boolean }
  | { kind: "offer" | "answer"; fromKey: string; toKey: string; sdp: string; signature: string }
  | { kind: "candidate"; candidate: MeshIceCandidate | null }
  | { kind: "restart" | "bye" }
);
interface Peer {
  member: Member;
  initiator: boolean;
  path: MeshPath;
  helloSent: boolean;
  helloQueued: boolean;
  helloSeen: boolean;
  helloReplied: boolean;
  remoteRtc: boolean;
  generation: number;
  failures: number;
  failedGeneration?: number;
  pc?: MeshPeerConnection;
  dc?: MeshDataChannel;
  timer?: ReturnType<typeof setTimeout>;
  retry?: ReturnType<typeof setTimeout>;
  serial: Promise<void>;
  candidates: (MeshIceCandidate | null)[];
  candidateBytes: number;
  // Outbound candidates cannot overtake our signed SDP.
  descriptionSent: boolean;
  localCandidates: (MeshIceCandidate | null)[];
  localCandidateBytes: number;
  earlyCandidates: (MeshIceCandidate | null)[];
}
interface Job {
  channel: string;
  target?: string;
  recipients: readonly Member[];
  value: unknown;
  wire: string;
  bytes: number;
  control: boolean;
  epoch: number;
  peer?: Peer;
  generation?: number;
  dc?: MeshDataChannel;
  started: boolean;
  done: boolean;
  timer?: ReturnType<typeof setTimeout>;
  resolve: () => void;
  reject: (error: Error) => void;
}
const attached = new WeakSet<RelaySession>();
const encoder = new TextEncoder();
const byteLength = (value: string) => encoder.encode(value).length;
const SDP_DOMAIN = "romzo/mesh-sdp/v1";
const CANDIDATE_COUNT = 64;
const CANDIDATE_BYTES = 64 * 1024;

function positive(value: number | undefined, fallback: number, name: string): number {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`${name} must be a positive integer`);
  return n;
}
function json(value: unknown): { value: unknown; text: string } {
  const text = JSON.stringify(value);
  if (text === undefined) throw new MeshSessionError("invalid_json");
  return { value: JSON.parse(text), text };
}
function defaultFactory(): MeshOptions["rtcPeerConnectionFactory"] {
  const Constructor = (globalThis as unknown as { RTCPeerConnection?: new (config: MeshRtcConfiguration) => MeshPeerConnection }).RTCPeerConnection;
  return Constructor ? config => new Constructor(config) : undefined;
}
function sameBinding(a: Binding, b: Binding): boolean {
  return !!a && !!b && a.origin === b.origin && a.code === b.code && a.instance === b.instance && a.digest === b.digest;
}

/**
 * Optional mesh over a trusted relay roster. RTC success means local enqueue;
 * relay success means server ack. Switching paths can reorder or lose messages.
 * Application envelopes own sequencing, acknowledgments and recovery.
 */
export class MeshSession {
  private readonly signal: string;
  private readonly channels = new Map<string, number>();
  private readonly factory: MeshOptions["rtcPeerConnectionFactory"];
  private readonly config: MeshRtcConfiguration;
  private readonly limits;
  private readonly handlers = new Map<SessionEvent, Set<Handler>>();
  private readonly removers: (() => void)[] = [];
  private readonly peers = new Map<string, Peer>();
  private readonly jobs: Job[] = [];
  private queuedBytes = 0;
  private pumpTimer?: ReturnType<typeof setTimeout>;
  private frameTokens: number;
  private byteTokens: number;
  private tokenTime = performance.now();
  private ready = false;
  private frozen = false;
  private closed = false;
  private epoch = 0;

  private constructor(readonly relay: RelaySession, private readonly identity: Identity, private readonly opts: MeshOptions) {
    this.signal = opts.signalChannel ?? "signal";
    this.factory = opts.rtcPeerConnectionFactory ?? defaultFactory();
    this.config = opts.rtcConfig ?? {};
    this.limits = {
      timeout: positive(opts.negotiationTimeoutMs, 10000, "negotiationTimeoutMs"),
      items: positive(opts.maxQueuedItems, 128, "maxQueuedItems"),
      bytes: positive(opts.maxQueuedBytes, 1024 * 1024, "maxQueuedBytes"),
      queueTimeout: positive(opts.queueTimeoutMs, 15000, "queueTimeoutMs"),
      fps: positive(opts.relayFramesPerSecond, 32, "relayFramesPerSecond"),
      frameBurst: positive(opts.relayFrameBurst, 8, "relayFrameBurst"),
      bps: positive(opts.relayBytesPerSecond, 256 * 1024, "relayBytesPerSecond"),
      byteBurst: positive(opts.relayByteBurst, 512 * 1024, "relayByteBurst"),
      high: positive(opts.bufferedAmountHighWaterMark, 256 * 1024, "bufferedAmountHighWaterMark"),
      low: positive(opts.bufferedAmountLowWaterMark, 64 * 1024, "bufferedAmountLowWaterMark"),
    };
    if (this.limits.low >= this.limits.high) throw new RangeError("bufferedAmountLowWaterMark must be below high water mark");
    this.frameTokens = this.limits.frameBurst;
    this.byteTokens = this.limits.byteBurst;
  }

  static async connect(url: string, admission: SignedTicket, identity: Identity, sessionOptions: SessionOptions = {}, meshOptions: MeshOptions): Promise<MeshSession> {
    const relay = await RelaySession.connect(url, admission, identity, sessionOptions);
    try { return await attachMesh(relay, identity, meshOptions); }
    catch (error) { relay.close(); throw error; }
  }

  /** Internal attachment entry point; use attachMesh(). */
  static async attach(session: RelaySession, identity: Identity, opts: MeshOptions): Promise<MeshSession> {
    if (attached.has(session)) throw new MeshSessionError("already_attached");
    attached.add(session);
    let mesh: MeshSession | undefined;
    let subscribed = false;
    let hadSubscription = false;
    try {
      if (identity.publicKey !== session.key) throw new MeshSessionError("identity_mismatch");
      const b = session.roomBinding;
      await verifyDescriptor(opts.signedDescriptor, b.origin, b.code);
      const d = opts.signedDescriptor.descriptor;
      if (d.instance !== b.instance || await hash("romzo/relay-descriptor/v1", opts.signedDescriptor) !== b.digest)
        throw new MeshSessionError("room_binding_mismatch");
      mesh = new MeshSession(session, identity, opts);
      const declarations = (d.options as { channels?: unknown })?.channels;
      if (!Array.isArray(declarations) || declarations.length > 8) throw new MeshSessionError("invalid_channels");
      for (const c of declarations) {
        if (!c || !/^[a-z][a-z0-9-]{0,31}$/.test(c.name) || mesh.channels.has(c.name) ||
            !Number.isSafeInteger(c.maxFrameBytes) || c.maxFrameBytes < 256 || c.maxFrameBytes > MAX_FRAME_BYTES)
          throw new MeshSessionError("invalid_channels");
        mesh.channels.set(c.name, c.maxFrameBytes);
      }
      if (!mesh.channels.has(mesh.signal)) throw new MeshSessionError("missing_signal_channel");
      hadSubscription = session.isSubscribed(mesh.signal);
      mesh.listen();
      subscribed = true; // Also clean up a subscribe whose ack was lost.
      await session.subscribe(mesh.signal);
      if (mesh.closed || mesh.frozen) throw new MeshSessionError("session_unavailable");
      mesh.ready = true;
      mesh.syncPeers();
      return mesh;
    } catch (error) {
      mesh?.dispose();
      if (subscribed && !hadSubscription && mesh) await session.unsubscribe(mesh.signal).catch(() => {});
      attached.delete(session);
      throw error;
    }
  }

  get id(): string { return this.relay.id; }
  get key(): string { return this.relay.key; }
  get joinSeq(): number | undefined { return this.relay.joinSeq; }
  get roomBinding(): Binding { return this.relay.roomBinding; }
  currentRecovery(): SignedTicket | null { return this.relay.currentRecovery(); }
  keepalive(): Promise<SignedTicket | undefined> { return this.relay.keepalive(); }
  on(event: SessionEvent, handler: Handler): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, set = new Set());
    set.add(handler);
    return () => set.delete(handler);
  }
  off(event: SessionEvent, handler: Handler): void { this.handlers.get(event)?.delete(handler); }
  members(channel: string): readonly Member[] { return channel === this.signal ? Object.freeze([]) : this.relay.members(channel); }
  isSubscribed(channel: string): boolean { return channel !== this.signal && this.relay.isSubscribed(channel); }
  path(peer: string): MeshPath | null { return this.peers.get(peer)?.path ?? null; }
  private guard(channel: string): void {
    if (this.closed) throw new MeshSessionError("closed");
    if (this.frozen) throw new MeshSessionError("reconnecting");
    if (channel === this.signal) throw new MeshSessionError("reserved_channel");
    if (!this.channels.has(channel)) throw new MeshSessionError("invalid_channel");
  }
  async subscribe(channel: string): Promise<void> { this.guard(channel); await this.relay.subscribe(channel); }
  async unsubscribe(channel: string): Promise<void> { this.guard(channel); await this.relay.unsubscribe(channel); }
  private emit(event: SessionEvent, payload: unknown, meta: SessionMeta): void {
    for (const handler of this.handlers.get(event) ?? []) handler(payload, meta);
  }
  private report(error: unknown, peer?: Peer): void {
    // A diagnostic handler cannot turn an RTC negotiation error into relay loss.
    try { this.emit("error", error instanceof Error ? error.message : String(error), { peer: peer?.member.peer, channel: this.signal }); } catch { /* application callback */ }
  }
  private setPath(p: Peer, path: MeshPath): void {
    if (p.path === path) return;
    p.path = path;
    try { this.opts.onPath?.(p.member.peer, path); } catch (error) { this.report(error, p); }
  }
  private listen(): void {
    for (const event of ["members", "receive", "join", "leave", "error", "reconnecting", "reconnect", "close"] as SessionEvent[]) {
      this.removers.push(this.relay.on(event, (value, meta) => {
        if (event === "close") { this.dispose(); this.emit(event, value, meta); return; }
        if (event === "reconnecting") this.freeze();
        if (event === "reconnect") { this.frozen = false; this.syncPeers(); }
        if (meta.channel === this.signal) {
          if (event === "members") {
            if (this.ready && !this.relay.isSubscribed(this.signal)) this.freeze();
            else this.syncPeers();
          } else if (event === "receive") this.receiveSignal(value, meta);
          return;
        }
        if (event === "members") this.cancelInvalidJobs();
        this.emit(event, value, meta);
      }));
    }
  }
  private live(p: Peer, generation?: number, pc?: MeshPeerConnection): boolean {
    return !this.closed && !this.frozen && this.peers.get(p.member.peer) === p &&
      (generation === undefined || p.generation === generation) && (pc === undefined || p.pc === pc);
  }
  private syncPeers(): void {
    if (this.frozen || this.closed) return;
    const roster = this.relay.members(this.signal);
    for (const [id, p] of this.peers) if (!roster.some(m => m.peer === id && m.key === p.member.key)) {
      this.peers.delete(id); this.stopPeer(p); this.cancelInvalidJobs();
    }
    for (const m of roster) {
      if (m.peer === this.id) continue;
      let p = this.peers.get(m.peer);
      if (!p) {
        const initiator = this.key < m.key || (this.key === m.key && this.id < m.peer);
        p = { member: m, initiator, path: "relay", helloSent: false, helloQueued: false, helloSeen: false, helloReplied: false,
          remoteRtc: false, generation: 0, failures: 0, serial: Promise.resolve(), candidates: [], candidateBytes: 0,
          descriptionSent: false, localCandidates: [], localCandidateBytes: 0, earlyCandidates: [] };
        this.peers.set(m.peer, p);
      }
      if (this.ready && !p.helloQueued) {
        p.helloQueued = true;
        const peer = p;
        void this.sendSignal(peer, { kind: "hello", reply: false, rtc: !!this.factory }, 0).then(() => {
          if (this.live(peer)) { peer.helloSent = true; this.maybeStart(peer); }
        }, error => this.report(error, peer));
      }
    }
  }
  private signalBase(p: Peer, generation: number): SignalBase {
    return { v: 1, room: this.roomBinding, from: this.id, to: p.member.peer, generation };
  }
  private async sendSignal(p: Peer, body: object, generation = p.generation): Promise<void> {
    if (!this.live(p)) return Promise.reject(new MeshSessionError("stale_peer"));
    const frame = { ...this.signalBase(p, generation), ...body };
    return this.enqueue([this.job(this.signal, frame, p.member.peer, [p.member], true, p, generation === 0 ? undefined : generation)])[0];
  }
  private receiveSignal(value: unknown, meta: SessionMeta): void {
    const p = meta.peer && this.peers.get(meta.peer);
    if (!p || !this.live(p)) return;
    const f = value as Signal;
    if (!f || f.v !== 1 || !sameBinding(f.room, this.roomBinding) || f.from !== p.member.peer || f.to !== this.id ||
        meta.key !== p.member.key || !Number.isSafeInteger(f.generation) || f.generation < 0) return;
    const bytes = byteLength(JSON.stringify(value));
    if (bytes > this.channels.get(this.signal)!) return;
    // Bound asynchronous verification backlog with the same candidate budget.
    if (p.candidateBytes + bytes > CANDIDATE_BYTES) { this.fail(p); return; }
    p.candidateBytes += bytes;
    p.serial = p.serial.then(async () => {
      p.candidateBytes -= bytes;
      if (!this.live(p)) return;
      try { await this.handleSignal(p, f); }
      catch (error) {
        // A rejected operation from a retired PC must not tear down its successor.
        const current = f.generation === p.generation ||
          (!p.initiator && (f.kind === "offer" || f.kind === "candidate") && f.generation === p.generation + 1);
        if (this.live(p) && current) { this.report(error, p); this.fail(p); }
      }
    });
  }
  private async handleSignal(p: Peer, f: Signal): Promise<void> {
    if (f.kind === "hello") {
      if (f.generation !== 0 || typeof f.reply !== "boolean" || typeof f.rtc !== "boolean") return;
      p.helloSeen = true; p.remoteRtc = f.rtc;
      if (!f.reply && !p.helloReplied) {
        p.helloReplied = true;
        void this.sendSignal(p, { kind: "hello", reply: true, rtc: !!this.factory }, 0).catch(error => this.report(error, p));
      }
      this.maybeStart(p); return;
    }
    if (!p.helloSeen || !p.helloSent || !p.remoteRtc || !this.factory || f.generation < 1) return;
    if (f.kind === "offer" || f.kind === "answer") {
      if (f.fromKey !== p.member.key || f.toKey !== this.key || typeof f.sdp !== "string" || !f.sdp || typeof f.signature !== "string") return;
      if (f.kind === "offer" ? p.initiator || f.generation <= p.generation || p.failures >= 2 :
          !p.initiator || f.generation !== p.generation || !p.pc || !!p.pc.remoteDescription) return;
      const { signature, ...signed } = f;
      const epoch = this.epoch;
      const previousGeneration = p.generation, previousPC = p.pc;
      if (!await verify(p.member.key, signed, SDP_DOMAIN, signature)) throw new MeshSessionError("invalid_sdp_signature");
      if (!this.live(p) || epoch !== this.epoch || p.generation !== previousGeneration || p.pc !== previousPC) return;
      if (f.kind === "offer") {
        const early = f.generation === p.generation + 1 ? p.earlyCandidates.splice(0) : [];
        p.earlyCandidates = [];
        this.stopConnection(p);
        p.generation = f.generation;
        p.candidates = early;
        const pc = this.newConnection(p);
        await pc.setRemoteDescription({ type: "offer", sdp: f.sdp });
        if (!this.live(p, f.generation, pc)) return;
        await this.flushCandidates(p, pc);
        const answer = await pc.createAnswer();
        if (!this.live(p, f.generation, pc)) return;
        await pc.setLocalDescription(answer);
        if (this.live(p, f.generation, pc)) await this.sendDescription(p, pc, "answer");
      } else {
        const pc = p.pc!;
        await pc.setRemoteDescription({ type: "answer", sdp: f.sdp });
        if (this.live(p, f.generation, pc)) await this.flushCandidates(p, pc);
      }
    } else if (f.kind === "candidate" && !p.initiator && f.generation === p.generation + 1 &&
        p.failures < 2 && (f.candidate === null || this.validCandidate(f.candidate))) {
      if (p.earlyCandidates.length >= CANDIDATE_COUNT ||
          p.earlyCandidates.reduce((n, c) => n + byteLength(JSON.stringify(c)), 0) + byteLength(JSON.stringify(f.candidate)) > CANDIDATE_BYTES)
        throw new MeshSessionError("candidate_queue_full");
      p.earlyCandidates.push(f.candidate);
    } else if (f.generation === p.generation && p.failedGeneration !== f.generation) {
      if (f.kind === "candidate" && (f.candidate === null || this.validCandidate(f.candidate))) {
        const pc = p.pc;
        if (!pc) return;
        if (!pc.remoteDescription) {
          const bytes = byteLength(JSON.stringify(f.candidate));
          if (p.candidates.length >= CANDIDATE_COUNT || this.candidateSize(p) + bytes > CANDIDATE_BYTES) throw new MeshSessionError("candidate_queue_full");
          p.candidates.push(f.candidate);
        } else await this.addCandidate(pc, f.candidate);
      } else if (f.kind === "restart" || f.kind === "bye") {
        // Peer-reported restart tears down our side even when locally connected:
        // connectionState is per-endpoint, so the peer may observe failure while
        // we still look healthy. Bye reuses the same teardown path.
        this.fail(p);
      }
    }
  }
  private validCandidate(c: MeshIceCandidate): boolean {
    return !!c && typeof c === "object" && typeof c.candidate === "string" &&
      (c.sdpMid == null || typeof c.sdpMid === "string") &&
      (c.sdpMLineIndex == null || (Number.isSafeInteger(c.sdpMLineIndex) && c.sdpMLineIndex >= 0)) &&
      (c.usernameFragment == null || typeof c.usernameFragment === "string");
  }
  private candidateSize(p: Peer): number { return p.candidates.reduce((n, c) => n + byteLength(JSON.stringify(c)), 0); }
  private async addCandidate(pc: MeshPeerConnection, c: MeshIceCandidate | null): Promise<void> {
    // Explicitly reject a candidate from an old ICE generation before the API.
    const fragments = pc.remoteDescription?.sdp?.match(/^a=ice-ufrag:(.+)$/gm)?.map(s => s.slice(12).trim()) ?? [];
    if (c?.usernameFragment && !fragments.includes(c.usernameFragment)) return;
    await pc.addIceCandidate(c);
  }
  private async flushCandidates(p: Peer, pc: MeshPeerConnection): Promise<void> {
    const generation = p.generation;
    for (const c of p.candidates.splice(0)) {
      if (!this.live(p, generation, pc)) return;
      await this.addCandidate(pc, c);
    }
  }
  private maybeStart(p: Peer): void {
    if (this.ready && this.live(p) && this.factory && p.remoteRtc && p.helloSeen && p.helloSent &&
        p.initiator && !p.pc && !p.retry && p.failures < 2) {
      p.generation++;
      const generation = p.generation;
      void this.startOffer(p).catch(error => { if (this.live(p, generation)) { this.report(error, p); this.fail(p); } });
    }
  }
  private newConnection(p: Peer): MeshPeerConnection {
    const generation = p.generation;
    // Constructor errors are negotiation failures, never relay session failures.
    const pc = this.factory!(this.config);
    p.pc = pc; p.descriptionSent = false; p.localCandidates = []; p.localCandidateBytes = 0;
    p.failedGeneration = undefined;
    this.setPath(p, "connecting");
    p.timer = setTimeout(() => { if (this.live(p, generation, pc)) this.fail(p); }, this.limits.timeout);
    pc.onicecandidate = event => {
      if (!this.live(p, generation, pc)) return;
      const c = event.candidate?.toJSON?.() ?? event.candidate;
      if (c !== null && !this.validCandidate(c)) { this.fail(p); return; }
      if (!p.descriptionSent) {
        p.localCandidateBytes += byteLength(JSON.stringify(c));
        if (p.localCandidates.length >= CANDIDATE_COUNT || p.localCandidateBytes > CANDIDATE_BYTES) { this.fail(p); return; }
        p.localCandidates.push(c);
      } else void this.sendSignal(p, { kind: "candidate", candidate: c }, generation).catch(error => {
        if (this.live(p, generation, pc)) { this.report(error, p); this.fail(p); }
      });
    };
    pc.ondatachannel = event => {
      if (!this.live(p, generation, pc) || p.initiator || p.dc) { event.channel.close(); return; }
      this.bindChannel(p, pc, event.channel);
    };
    pc.onconnectionstatechange = () => {
      if (this.live(p, generation, pc) && (pc.connectionState === "failed" || pc.connectionState === "closed")) this.fail(p);
    };
    return pc;
  }
  private async startOffer(p: Peer): Promise<void> {
    const generation = p.generation;
    const pc = this.newConnection(p);
    this.bindChannel(p, pc, pc.createDataChannel("romzo-mesh-v1", { ordered: true }));
    const offer = await pc.createOffer();
    if (!this.live(p, generation, pc)) return;
    await pc.setLocalDescription(offer);
    if (this.live(p, generation, pc)) await this.sendDescription(p, pc, "offer");
  }
  private async sendDescription(p: Peer, pc: MeshPeerConnection, kind: "offer" | "answer"): Promise<void> {
    const generation = p.generation;
    const sdp = pc.localDescription?.sdp;
    if (!sdp) throw new MeshSessionError("missing_sdp");
    const body = { ...this.signalBase(p, generation), kind, fromKey: this.key, toKey: p.member.key, sdp };
    const signature = await sign(this.identity, body, SDP_DOMAIN);
    if (!this.live(p, generation, pc)) return;
    await this.sendSignal(p, { kind, fromKey: this.key, toKey: p.member.key, sdp, signature }, generation);
    if (!this.live(p, generation, pc)) return;
    p.descriptionSent = true;
    for (const candidate of p.localCandidates.splice(0)) {
      if (!this.live(p, generation, pc)) return;
      await this.sendSignal(p, { kind: "candidate", candidate }, generation);
    }
  }
  private bindChannel(p: Peer, pc: MeshPeerConnection, dc: MeshDataChannel): void {
    const generation = p.generation;
    if (!dc.ordered || dc.maxRetransmits !== null || dc.maxPacketLifeTime !== null) { dc.close(); this.fail(p); return; }
    p.dc = dc;
    dc.bufferedAmountLowThreshold = this.limits.low;
    dc.onopen = () => {
      if (!this.live(p, generation, pc)) return;
      if (p.timer) clearTimeout(p.timer);
      p.timer = undefined; this.setPath(p, "rtc"); this.pump();
      // The retry budget guards consecutive negotiation failures; a working
      // connection proves the pair is healthy and earns a fresh budget.
      p.failures = 0;
    };
    dc.onclose = dc.onerror = () => { if (this.live(p, generation, pc)) this.fail(p); };
    dc.onbufferedamountlow = () => this.pump();
    dc.onmessage = event => {
      if (!this.live(p, generation, pc)) return;
      try {
        if (typeof event.data !== "string" || byteLength(event.data) > MAX_FRAME_BYTES + 1024) throw new MeshSessionError("invalid_rtc_frame");
        const f = JSON.parse(event.data);
        if (f.v !== 1 || typeof f.channel !== "string" || !("value" in f) || f.channel === this.signal) throw new MeshSessionError("invalid_rtc_frame");
        this.checkPayload(f.channel, f.value);
        const member = this.relay.members(f.channel).find(m => m.peer === p.member.peer && m.key === p.member.key);
        if (!member || !this.subscribed(f.channel)) return;
        this.emit("receive", f.value, { channel: f.channel, ...member });
      } catch (error) { this.report(error, p); this.fail(p); }
    };
    if (dc.readyState === "open") dc.onopen();
  }
  private stopConnection(p: Peer): void {
    if (p.timer) clearTimeout(p.timer);
    p.timer = undefined;
    const pc = p.pc, dc = p.dc;
    p.pc = undefined; p.dc = undefined;
    if (dc) {
      dc.onopen = dc.onclose = dc.onerror = dc.onmessage = dc.onbufferedamountlow = null;
      try { dc.close(); } catch { /* already closed */ }
    }
    if (pc) {
      pc.ondatachannel = pc.onicecandidate = pc.onconnectionstatechange = null;
      try { pc.close(); } catch { /* already closed */ }
    }
    p.candidates = []; p.localCandidates = [];
    this.setPath(p, "relay");
    for (const j of [...this.jobs]) if (j.peer === p && (j.dc || j.generation !== undefined)) this.finish(j, new MeshSessionError("stale_generation"));
  }
  private stopPeer(p: Peer): void {
    if (p.retry) clearTimeout(p.retry);
    p.retry = undefined; this.stopConnection(p);
  }
  private fail(p: Peer): void {
    if (!this.live(p) || p.failedGeneration === p.generation) return;
    p.failedGeneration = p.generation; p.failures++;
    // A timed-out browser operation may never settle. Do not let it block the
    // next generation's incoming offer; old continuations still check pc/epoch.
    p.serial = Promise.resolve();
    this.stopConnection(p);
    if (p.failures >= 2) return;
    if (p.initiator) p.retry = setTimeout(() => { p.retry = undefined; this.maybeStart(p); }, 1000 + Math.floor(Math.random() * 1001));
    else void this.sendSignal(p, { kind: "restart" }).catch(error => this.report(error, p));
  }
  private freeze(): void {
    if (this.frozen) return;
    this.frozen = true; this.epoch++;
    for (const p of this.peers.values()) this.stopPeer(p);
    this.peers.clear();
    for (const j of [...this.jobs]) this.finish(j, new MeshSessionError("reconnecting"));
  }
  private dispose(): void {
    if (this.closed) return;
    this.closed = true; this.epoch++;
    for (const remove of this.removers.splice(0)) remove();
    for (const p of this.peers.values()) this.stopPeer(p);
    this.peers.clear();
    for (const j of [...this.jobs]) this.finish(j, new MeshSessionError("closed"));
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.pumpTimer = undefined;
  }
  close(): void {
    if (this.closed) return;
    for (const p of this.peers.values()) if (p.pc)
      void this.sendSignal(p, { kind: "bye" }).catch(() => {});
    this.dispose(); this.relay.close(); this.emit("close", undefined, {});
  }
  private subscribed(channel: string): boolean { return this.relay.isSubscribed(channel); }
  private checkPayload(channel: string, value: unknown): { value: unknown; text: string } {
    const limit = this.channels.get(channel);
    if (!limit) throw new MeshSessionError("invalid_channel");
    const encoded = json(value);
    if (byteLength(encoded.text) > limit) throw new MeshSessionError("frame_too_large");
    return encoded;
  }
  async send(channel: string, value: unknown, target?: string): Promise<void> {
    this.guard(channel);
    if (!this.subscribed(channel)) throw new MeshSessionError("unsubscribed");
    const encoded = this.checkPayload(channel, value);
    const roster = this.relay.members(channel).filter(m => m.peer !== this.id);
    if (target !== undefined && !roster.some(m => m.peer === target)) throw new RelaySessionError("invalid_target");
    const recipients = target === undefined ? roster : roster.filter(m => m.peer === target);
    const wire = JSON.stringify({ v: 1, channel, value: encoded.value });
    const rtc = (m: Member) => {
      const p = this.peers.get(m.peer);
      return p?.path === "rtc" && p.dc?.readyState === "open" && p.pc?.sctp && byteLength(wire) <= p.pc.sctp.maxMessageSize ? p : undefined;
    };
    let jobs: Job[];
    if (target === undefined && !recipients.some(rtc)) {
      jobs = [this.job(channel, encoded.value, undefined, recipients, false)];
    } else jobs = recipients.map(m => {
      const p = rtc(m);
      return this.job(channel, encoded.value, m.peer, [m], false, p, p?.generation, p?.dc);
    });
    await Promise.all(this.enqueue(jobs));
  }
  private job(channel: string, value: unknown, target: string | undefined, recipients: readonly Member[], control: boolean, peer?: Peer, generation?: number, dc?: MeshDataChannel): Job {
    const encoded = this.checkPayload(channel, value);
    const wire = dc ? JSON.stringify({ v: 1, channel, value: encoded.value }) :
      encodeFrame({ kind: "send", channel, value: encoded.value, ...(target ? { target } : {}), id: "0".repeat(16) });
    const bytes = byteLength(wire);
    if (!dc && bytes > MAX_FRAME_BYTES) throw new MeshSessionError("frame_too_large");
    if (!dc && bytes > this.limits.byteBurst) throw new MeshSessionError("frame_exceeds_budget_burst");
    return { channel, target, recipients, value: encoded.value, wire, bytes, control, peer, generation, dc,
      epoch: this.epoch, started: false, done: false, resolve: () => {}, reject: () => {} };
  }
  private enqueue(jobs: Job[]): Promise<void>[] {
    if (this.closed || this.frozen) throw new MeshSessionError(this.closed ? "closed" : "reconnecting");
    const bytes = jobs.reduce((n, j) => n + j.bytes, 0);
    if (this.jobs.length + jobs.length > this.limits.items || this.queuedBytes + bytes > this.limits.bytes)
      throw new MeshSessionError("queue_full");
    const promises = jobs.map(j => new Promise<void>((resolve, reject) => {
      j.resolve = resolve; j.reject = reject;
      j.timer = setTimeout(() => this.finish(j, new MeshSessionError("queue_timeout")), this.limits.queueTimeout);
    }));
    this.jobs.push(...jobs); this.queuedBytes += bytes; this.pump();
    return promises;
  }
  private invalid(j: Job): boolean {
    return j.epoch !== this.epoch || !this.subscribed(j.channel) ||
      (j.target === undefined && this.relay.members(j.channel).filter(m => m.peer !== this.id).length !== j.recipients.length) ||
      j.recipients.some(m => !this.relay.members(j.channel).some(r => r.peer === m.peer && r.key === m.key)) ||
      (!!j.peer && !this.live(j.peer, j.generation)) || (!!j.dc && j.peer?.dc !== j.dc);
  }
  private cancelInvalidJobs(): void {
    for (const j of [...this.jobs]) if (!j.started && this.invalid(j)) this.finish(j, new MeshSessionError("membership_changed"));
  }
  private finish(j: Job, error?: Error): void {
    if (j.done) return;
    j.done = true;
    if (j.timer) clearTimeout(j.timer);
    const index = this.jobs.indexOf(j);
    if (index >= 0) { this.jobs.splice(index, 1); this.queuedBytes -= j.bytes; }
    if (error) j.reject(error); else j.resolve();
  }
  private pump(): void {
    if (this.closed || this.frozen) return;
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.pumpTimer = undefined;
    const now = performance.now(), seconds = (now - this.tokenTime) / 1000;
    this.tokenTime = now;
    this.frameTokens = Math.min(this.limits.frameBurst, this.frameTokens + seconds * this.limits.fps);
    this.byteTokens = Math.min(this.limits.byteBurst, this.byteTokens + seconds * this.limits.bps);
    const sorted = [...this.jobs].sort((a, b) => Number(b.control) - Number(a.control));
    for (const j of sorted) {
      if (j.started || j.done) continue;
      if (this.invalid(j)) { this.finish(j, new MeshSessionError("membership_changed")); continue; }
      // Preserve order on each chosen path while letting unrelated peers progress.
      if (sorted.some(k => k !== j && !k.done && !k.started && k.control === j.control &&
          this.jobs.indexOf(k) < this.jobs.indexOf(j) && !!k.dc === !!j.dc &&
          (j.dc ? k.dc === j.dc : k.recipients.some(a => j.recipients.some(b => a.peer === b.peer))))) continue;
      if (j.dc) {
        if (j.dc.readyState !== "open") { this.finish(j, new MeshSessionError("rtc_closed")); continue; }
        const buffered = j.dc.bufferedAmount;
        if (j.bytes > this.limits.high ? buffered !== 0 : buffered + j.bytes > this.limits.high) continue;
      } else {
        if (this.frameTokens < 1 || this.byteTokens < j.bytes) continue;
        this.frameTokens--; this.byteTokens -= j.bytes;
      }
      j.started = true;
      if (j.timer) clearTimeout(j.timer);
      try {
        if (j.dc) { j.dc.send(j.wire); this.finish(j); }
        else void this.relay.send(j.channel, j.value, j.target).then(() => { this.finish(j); this.pump(); }, error => { this.finish(j, error); this.pump(); });
      } catch (error) { this.finish(j, error instanceof Error ? error : new Error(String(error))); }
    }
    if (this.jobs.some(j => !j.started)) this.pumpTimer = setTimeout(() => this.pump(), 25);
  }
}

/** Attach to an existing authenticated session; subscription readiness only. */
export function attachMesh(session: RelaySession, identity: Identity, options: MeshOptions): Promise<MeshSession> {
  return MeshSession.attach(session, identity, options);
}
