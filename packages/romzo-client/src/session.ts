import { hash } from "./canonical.js";
import { sign } from "./crypto.js";
import { PROTOCOL } from "./types.js";
import type {
  ChallengeValue,
  Channel,
  ServerFrame,
  SignedTicket,
} from "./types.js";

/** Minimal socket surface; a real WebSocket satisfies this structurally. */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event?: unknown) => void) | null;
  onclose: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

const defaultSocketFactory: SocketFactory = (url) =>
  new WebSocket(url) as unknown as SocketLike;

export interface SessionOptions {
  /** Injectable socket factory (tests, custom transports). Defaults to WebSocket. */
  webSocketFactory?: SocketFactory;
  /** Auto keepalive period in ms. Defaults to 10000 (below the server idle limit). */
  keepaliveIntervalMs?: number;
  /** Set false to disable the automatic keepalive timer. */
  keepalive?: boolean;
  /** Called whenever a fresh recovery ticket is received (keepalive acks). */
  onRecovery?: (ticket: SignedTicket) => void | Promise<void>;
  /** Handshake timeout in ms; failure closes the socket. Defaults to 10000. */
  handshakeTimeoutMs?: number;
}

export type SessionEvent =
  | "receive"
  | "join"
  | "leave"
  | "error"
  | "close";

type Handler = (payload: unknown, meta: SessionMeta) => void;
export interface SessionMeta {
  channel?: string;
  peer?: string;
  key?: string;
}

/** Error emitted for application-level (non-terminal) failures, e.g. invalid_target. */
export class RelaySessionError extends Error {
  constructor(readonly code: string) {
    super(`relay session error: ${code}`);
    this.name = "RelaySessionError";
  }
}

interface Pending {
  resolve: (value?: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const CONTROL_LIMIT = 16 * 1024;
const PAYLOAD_LIMIT = 256 * 1024;

function encodeFrame(frame: Record<string, unknown>): string {
  return JSON.stringify({ v: PROTOCOL, ...frame });
}

/**
 * One authenticated WebSocket session to a relay room.
 *
 * Wire semantics follow FRAMES.md: a four-frame handshake
 * (authenticate -> challenge -> proof -> authenticated), id-correlated acks, broadcast
 * join/leave/receive, and terminal error frames that always precede close.
 */
export class RelaySession {
  private socket: SocketLike | null = null;
  private handlers = new Map<SessionEvent, Set<Handler>>();
  private pending = new Map<string, Pending>();
  private serial = 0;
  private recovery: SignedTicket | null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private readonly code: string;
  private readonly instance: string;
  private readonly keepaliveIntervalMs: number;
  private readonly handshakeTimeoutMs: number;

  private constructor(
    private readonly admission: SignedTicket,
    private readonly identity: { publicKey: string; privateKey: CryptoKey },
    private readonly options: SessionOptions,
  ) {
    this.recovery = null;
    this.code = admission.ticket.code;
    this.instance = admission.ticket.instance;
    this.keepaliveIntervalMs = options.keepaliveIntervalMs ?? 10000;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10000;
  }

  /** Peer id assigned by the relay after the handshake. */
  id = "";

  /**
   * Connect and complete the four-frame handshake.
   * Throws on handshake failure; the socket is closed in that case.
   */
  static async connect(
    url: string,
    admission: SignedTicket,
    identity: { publicKey: string; privateKey: CryptoKey },
    options: SessionOptions = {},
  ): Promise<RelaySession> {
    const session = new RelaySession(admission, identity, options);
    await session.open(url);
    return session;
  }

  private open(url: string): Promise<void> {
    const socket = (this.options.webSocketFactory ?? defaultSocketFactory)(url);
    this.socket = socket;
    return new Promise<void>((resolve, reject) => {
      let state: "opening" | "challenge" | "signing" | "authenticated" | "done" = "opening";
      const fail = (error: Error) => {
        if (state === "done") return;
        state = "done";
        clearTimeout(timer);
        this.closed = true;
        socket.onmessage = null;
        try { socket.close(); } catch { /* already closed */ }
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error("relay handshake timeout")), this.handshakeTimeoutMs);
      socket.onopen = () => {
        if (state !== "opening") return;
        state = "challenge";
        try { socket.send(encodeFrame({ kind: "authenticate", admission: this.admission })); }
        catch (error) { fail(error as Error); }
      };
      socket.onerror = () => fail(new Error("relay socket error"));
      socket.onclose = () => fail(new Error("relay connection closed"));
      socket.onmessage = (event) => {
        void (async () => {
          try {
            if (typeof event.data !== "string") throw new Error("binary frames unsupported");
            if (new TextEncoder().encode(event.data).length > CONTROL_LIMIT) throw new Error("frame_too_large");
            const frame = JSON.parse(event.data) as ServerFrame;
            if (frame.v !== PROTOCOL) throw new Error("protocol_mismatch");
            if (frame.kind === "error") throw new RelaySessionError(frame.error ?? "terminal_error");
            if (frame.kind === "challenge" && state === "challenge") {
              state = "signing";
              const value = frame.value as ChallengeValue;
              const admissionDigest = await hash("ru/relay-admission/v1", this.admission);
              if (!value || value.protocol !== PROTOCOL ||
                  value.origin !== this.admission.ticket.origin || value.ticket !== admissionDigest ||
                  !/^[a-f0-9]{64}$/.test(value.challenge)) throw new Error("challenge_binding_failed");
              const signature = await sign(this.identity, value, "ru/relay-connect/v1");
              // Hashing/signing yields: close, timeout or a duplicate challenge may have failed meanwhile.
              if (state !== "signing") return;
              state = "authenticated";
              socket.send(encodeFrame({ kind: "proof", signature }));
              return;
            }
            if (frame.kind === "authenticated" && state === "authenticated" && typeof frame.id === "string") {
              state = "done";
              clearTimeout(timer);
              this.id = frame.id;
              this.attach(socket);
              this.startKeepalive();
              resolve();
              return;
            }
            throw new Error("unexpected_frame_during_handshake");
          } catch (error) { fail(error as Error); }
        })();
      };
    });
  }

  private attach(socket: SocketLike): void {
    socket.onopen = null;
    socket.onerror = null;
    socket.onmessage = (event) => {
      try {
        this.onFrame(event);
      } catch (error) {
        try { this.emit("error", (error as Error).message, {}); } finally { this.close(); }
      }
    };
    socket.onclose = () => {
      if (this.closed) return;
      this.closed = true;
      this.stopKeepalive();
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("relay connection closed"));
      }
      this.pending.clear();
      this.emit("close", undefined, {});
    };
  }

  private onFrame(event: { data: unknown }): void {
    if (this.closed) return;
    if (typeof event.data !== "string") throw new Error("binary frames unsupported");
    if (new TextEncoder().encode(event.data).length > 288 * 1024)
      throw new Error("frame_too_large");
    const frame = JSON.parse(event.data) as ServerFrame;
    if (frame.v !== PROTOCOL) throw new Error("protocol_mismatch");
    if (frame.kind === "ack" || (frame.kind === "error" && frame.id)) {
      const p = this.pending.get(frame.id as string);
      if (!p) return;
      this.pending.delete(frame.id as string);
      clearTimeout(p.timer);
      if (frame.kind === "error") p.reject(new RelaySessionError(frame.error ?? "unknown_error"));
      else p.resolve(frame);
      if (frame.recovery) void this.acceptRecovery(frame.recovery);
      return;
    }
    if (frame.kind === "error") {
      // Terminal error frame: the server closes the connection right after.
      try { this.emit("error", frame.error ?? "terminal_error", {}); } finally { this.close(); }
      return;
    }
    const meta: SessionMeta = {
      channel: frame.channel ?? "",
      peer: frame.peer,
      key: frame.key,
    };
    if (frame.kind === "join" || frame.kind === "leave") {
      this.emit(frame.kind, undefined, meta);
    } else if (frame.kind === "receive") {
      this.emit("receive", frame.value, meta);
    } else {
      throw new Error("unexpected_frame_after_handshake");
    }
  }

  private async acceptRecovery(ticket: SignedTicket): Promise<void> {
    if (
      ticket?.ticket?.code !== this.code ||
      ticket.ticket.instance !== this.instance ||
      ticket.ticket.key !== this.identity.publicKey ||
      ticket.ticket.purpose !== "recovery"
    )
      return;
    this.recovery = ticket;
    await this.options.onRecovery?.(ticket);
  }

  private emit(event: SessionEvent, payload: unknown, meta: SessionMeta): void {
    for (const handler of this.handlers.get(event) ?? [])
      handler(payload, meta);
  }

  on(event: SessionEvent, handler: Handler): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(handler);
    return () => set.delete(handler);
  }

  off(event: SessionEvent, handler: Handler): void {
    this.handlers.get(event)?.delete(handler);
  }

  private request(
    frame: Record<string, unknown>,
    limit = CONTROL_LIMIT,
  ): Promise<unknown> {
    const socket = this.socket;
    if (this.closed || !socket) return Promise.reject(new Error("relay session closed"));
    const packet = encodeFrame({ ...frame, id: String(++this.serial) });
    if (new TextEncoder().encode(packet).length > limit)
      return Promise.reject(new Error("frame exceeds channel limit"));
    const id = String(this.serial);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("relay request timeout"));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.send(packet);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  /** Subscribe to a channel; resolves when the server acks. */
  subscribe(channel: Channel): Promise<void> {
    return this.request({ kind: "subscribe", channel }).then(() => undefined);
  }

  /** Unsubscribe from a channel; resolves when the server acks. */
  unsubscribe(channel: Channel): Promise<void> {
    return this.request({ kind: "unsubscribe", channel }).then(() => undefined);
  }

  /**
   * Send a payload to the channel's members (or one member via target).
   * Rejects with RelaySessionError("invalid_target") if the target is gone.
   */
  send(channel: Channel, value: unknown, target?: string): Promise<void> {
    const limit = channel === "game" ? PAYLOAD_LIMIT : CONTROL_LIMIT;
    return this.request(
      {
        kind: "send",
        channel,
        value,
        ...(target !== undefined ? { target } : {}),
      },
      limit,
    ).then(() => undefined);
  }

  /**
   * Send a keepalive and return the fresh recovery ticket from the ack
   * (undefined if the server attached none). Updates currentRecovery().
   */
  async keepalive(): Promise<SignedTicket | undefined> {
    const ack = (await this.request({ kind: "keepalive" })) as {
      recovery?: SignedTicket;
    };
    return ack?.recovery;
  }

  /** Latest recovery ticket observed (from keepalive acks). */
  currentRecovery(): SignedTicket | null {
    return this.recovery;
  }

  private startKeepalive(): void {
    if (this.options.keepalive === false) return;
    this.keepaliveTimer = setInterval(() => {
      void this.keepalive().catch(() => {});
    }, this.keepaliveIntervalMs);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  /** Close the session and stop the keepalive timer. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopKeepalive();
    try {
      this.socket?.close();
    } catch {
      /* already closed */
    }
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("relay session closed"));
    }
    this.pending.clear();
    this.emit("close", undefined, {});
  }
}
