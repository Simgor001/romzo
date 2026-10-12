import { hash } from "./canonical.js";
import { sign } from "./crypto.js";
import { restoreSession } from "./facade.js";
import { MAX_FRAME_BYTES, PROTOCOL } from "./types.js";
import type {
  ChallengeValue,
  Channel,
  ServerFrame,
  SignedDescriptor,
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
  /**
   * Opt-in automatic reconnection after a transport drop or a terminal error
   * frame. Disabled by default (behavior unchanged). Requires the signed
   * room descriptor so a fresh admission ticket can be minted from the latest
   * recovery ticket on every attempt.
   */
  autoReconnect?: false | AutoReconnectOptions;
}

export interface AutoReconnectOptions {
  /** Signed room descriptor; traded with the latest recovery ticket for a fresh admission. */
  signedDescriptor: SignedDescriptor;
  /** Attempts before giving up and emitting "close". Defaults to 8. */
  maxAttempts?: number;
  /** First delay in ms; doubles per attempt up to maxDelayMs. Defaults to 1000. */
  baseDelayMs?: number;
  /** Delay ceiling in ms. Defaults to 15000. */
  maxDelayMs?: number;
}

export type SessionEvent =
  | "receive"
  | "join"
  | "leave"
  | "error"
  | "reconnecting"
  | "reconnect"
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
  acknowledged?: boolean;
  resolve: (value?: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const CONTROL_LIMIT = 16 * 1024;

function encodeFrame(frame: Record<string, unknown>): string {
  return JSON.stringify({ v: PROTOCOL, ...frame });
}

/**
 * One authenticated WebSocket session to a relay room.
 *
 * Wire semantics follow FRAMES.md: a four-frame handshake
 * (authenticate -> challenge -> proof -> authenticated), id-correlated acks, broadcast
 * join/leave/receive, and terminal error frames that always precede close.
 * Reconnection is opt-in (`autoReconnect` in SessionOptions): a transport drop
 * or terminal error frame then runs a restoreSession-backed backoff loop that
 * re-subscribes the tracked channels instead of closing immediately.
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
  private readonly reconnect: {
    signedDescriptor: SignedDescriptor;
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
  } | null = null;
  private url = "";
  private subscriptions = new Set<Channel>();
  private reconnecting = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

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
    const cfg = options.autoReconnect;
    if (cfg) {
      if (!cfg.signedDescriptor)
        throw new Error("autoReconnect requires a signedDescriptor");
      for (const [name, value] of [
        ["maxAttempts", cfg.maxAttempts],
        ["baseDelayMs", cfg.baseDelayMs],
        ["maxDelayMs", cfg.maxDelayMs],
      ] as const) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
          throw new RangeError(`autoReconnect ${name} must be a positive integer`);
      }
      this.reconnect = {
        signedDescriptor: cfg.signedDescriptor,
        maxAttempts: cfg.maxAttempts ?? 8,
        baseDelayMs: cfg.baseDelayMs ?? 1000,
        maxDelayMs: cfg.maxDelayMs ?? 15000,
      };
    }
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
    await session.open(url, admission);
    return session;
  }

  private open(url: string, admission: SignedTicket): Promise<void> {
    const socket = (this.options.webSocketFactory ?? defaultSocketFactory)(url);
    this.socket = socket;
    this.url = url;
    return new Promise<void>((resolve, reject) => {
      let state: "opening" | "challenge" | "signing" | "authenticated" | "done" = "opening";
      const fail = (error: Error) => {
        if (state === "done") return;
        state = "done";
        clearTimeout(timer);
        this.closed = true;
        socket.onopen = null;
        socket.onclose = null;
        socket.onerror = null;
        socket.onmessage = null;
        try { socket.close(); } catch { /* already closed */ }
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error("relay handshake timeout")), this.handshakeTimeoutMs);
      socket.onopen = () => {
        if (state !== "opening") return;
        state = "challenge";
        try { socket.send(encodeFrame({ kind: "authenticate", admission })); }
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
              const admissionDigest = await hash("romzo/relay-admission/v1", admission);
              if (!value || value.protocol !== PROTOCOL ||
                  value.origin !== admission.ticket.origin || value.ticket !== admissionDigest ||
                  !/^[a-f0-9]{64}$/.test(value.challenge)) throw new Error("challenge_binding_failed");
              const signature = await sign(this.identity, value, "romzo/relay-connect/v1");
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
      if (this.closed || socket !== this.socket || this.reconnecting) return;
      this.drop(new Error("relay connection closed"));
    };
  }

  /**
   * Handle an involuntary loss of the transport (drop or terminal error
   * frame). Without autoReconnect this closes the session exactly as before;
   * with autoReconnect it starts (or continues) the reconnect loop and
   * defers the "close" event until every attempt has failed.
   */
  private drop(error: Error): void {
    const socket = this.socket;
    this.stopKeepalive();
    if (!this.reconnect) {
      this.closed = true;
      this.rejectPending(new Error("relay connection closed"));
      try { socket?.close(); } catch { /* already closed */ }
      this.emit("close", undefined, {});
      return;
    }
    this.reconnecting = true;
    this.rejectPending(new Error("relay session reconnecting"));
    if (socket) {
      socket.onmessage = null;
      socket.onerror = null;
      try { socket.close(); } catch { /* already closed */ }
    }
    this.scheduleReconnect(error);
  }

  private rejectPending(error: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }

  /** Delay for `attempt` (1-based): exponential growth, capped, ±20% jitter. */
  private reconnectDelay(attempt: number): number {
    const cfg = this.reconnect!;
    const raw = Math.min(cfg.baseDelayMs * 2 ** (attempt - 1), cfg.maxDelayMs);
    return Math.round(raw * (0.8 + Math.random() * 0.4));
  }

  private scheduleReconnect(error: Error): void {
    if (this.closed || !this.reconnect) return;
    const attempt = ++this.reconnectAttempt;
    if (attempt > this.reconnect.maxAttempts) {
      this.reconnecting = false;
      this.closed = true;
      this.emit("close", undefined, {});
      return;
    }
    const delayMs = this.reconnectDelay(attempt);
    this.emit("reconnecting", { attempt, delayMs, error }, {});
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.attemptReconnect(attempt);
    }, delayMs);
  }

  private async attemptReconnect(attempt: number): Promise<void> {
    if (this.closed || !this.reconnect) return;
    try {
      const recovery = this.recovery;
      if (!recovery) throw new Error("no recovery ticket available for reconnect");
      const restored = await restoreSession(
        this.reconnect.signedDescriptor,
        recovery,
        this.identity,
      );
      await this.open(this.url, restored.admission);
      // Allow requests again before re-subscribing tracked channels.
      this.reconnecting = false;
      for (const channel of [...this.subscriptions]) await this.subscribe(channel);
      this.reconnectAttempt = 0;
      this.emit("reconnect", { attempt }, {});
    } catch (error) {
      if (this.closed) return;
      // open() marks the session closed on handshake failure; keep it alive
      // for the next attempt unless close() ran while we were reconnecting.
      this.closed = false;
      this.scheduleReconnect(error as Error);
    }
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
      if (!p || p.acknowledged) return;
      p.acknowledged = true;
      const settle = (error?: Error) => {
        if (this.pending.get(frame.id as string) !== p) return;
        this.pending.delete(frame.id as string);
        clearTimeout(p.timer);
        if (error) p.reject(error);
        else p.resolve(frame);
      };
      if (frame.kind === "error") settle(new RelaySessionError(frame.error ?? "unknown_error"));
      else if (frame.recovery) {
        // Renewal is not complete for the caller until persistence finishes.
        // A rejecting callback must reject the request, not become an unhandled
        // promise rejection from the WebSocket event handler.
        void this.acceptRecovery(frame.recovery).then(
          () => settle(),
          () => settle(new RelaySessionError("recovery_persistence_failed")),
        );
      } else settle();
      return;
    }
    if (frame.kind === "error") {
      // Terminal error frame: the server closes the connection right after.
      try { this.emit("error", frame.error ?? "terminal_error", {}); } finally { this.drop(new RelaySessionError(frame.error ?? "terminal_error")); }
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
    if (this.reconnecting) return Promise.reject(new Error("relay session reconnecting"));
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

  /** Subscribe to a channel; resolves when the server acks. Tracked and re-subscribed after an automatic reconnect. */
  subscribe(channel: Channel): Promise<void> {
    return this.request({ kind: "subscribe", channel }).then(() => {
      this.subscriptions.add(channel);
    });
  }

  /** Unsubscribe from a channel; resolves when the server acks. */
  unsubscribe(channel: Channel): Promise<void> {
    return this.request({ kind: "unsubscribe", channel }).then(() => {
      this.subscriptions.delete(channel);
    });
  }

  /**
   * Send a payload to the channel's members (or one member via target).
   * Rejects with RelaySessionError("invalid_target") if the target is gone.
   * Per-channel size limits are declared in the room options and enforced
   * by the relay; the SDK only pre-checks the absolute payload cap.
   */
  send(channel: Channel, value: unknown, target?: string): Promise<void> {
    return this.request(
      {
        kind: "send",
        channel,
        value,
        ...(target !== undefined ? { target } : {}),
      },
      MAX_FRAME_BYTES,
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
    if (this.options.keepalive === false || this.closed) return;
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      void this.keepalive().catch(() => {});
    }, this.keepaliveIntervalMs);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  /**
   * Close the session, cancel any pending reconnect loop and stop the
   * keepalive timer. Emits "close"; with autoReconnect enabled, involuntary
   * drops emit "close" only after every reconnect attempt has failed.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopKeepalive();
    try {
      this.socket?.close();
    } catch {
      /* already closed */
    }
    this.rejectPending(new Error("relay session closed"));
    this.emit("close", undefined, {});
  }
}
