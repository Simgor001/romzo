/** Wire protocol version implemented by this SDK. */
export const PROTOCOL = "romzo/v1";
export const API = "/api/v1/";
export const WS_PATH = "/ws";
export const DISCOVERY_PATH = "/.well-known/romzo";

/** Absolute per-message payload cap enforced by the relay (256 KiB). */
export const MAX_FRAME_BYTES = 256 * 1024;

/** A channel declared in room options: its name and send-payload limit in bytes. */
export interface ChannelDeclaration {
  /** Lowercase letter, then lowercase letters/digits/hyphens, at most 32 characters. */
  name: string;
  /** Per-channel send-payload limit; between 256 and MAX_FRAME_BYTES. */
  maxFrameBytes: number;
}

/** Name of a room channel — any name the room's options declare. */
export type Channel = string;

/** POST /api/v1/rooms request payload (challenge-bound, idempotent). */
export interface AllocationRequest {
  protocol: string;
  origin: string;
  challenge: string;
  requestId: string;
  host: string;
  transport: string;
  configHash: string;
  capability: string;
  options: unknown;
}

/** Public room record returned by allocate and GET /rooms/{code}. */
export interface Descriptor {
  protocol: string;
  origin: string;
  code: string;
  instance: string;
  host: string;
  transport: string;
  capability: string;
  configHash: string;
  options: unknown;
}

/** Descriptor plus the host's Ed25519 signature over domain romzo/relay-descriptor/v1. */
export interface SignedDescriptor {
  descriptor: Descriptor;
  signature: string;
}

/** Short-lived admission / recovery ticket. */
export interface Ticket {
  protocol: string;
  origin: string;
  code: string;
  instance: string;
  digest: string;
  key: string;
  purpose: string;
  expires: number;
  nonce: string;
}

/** Ticket plus the relay's HMAC-SHA256 ticket signature. */
export interface SignedTicket {
  ticket: Ticket;
  signature: string;
}

/** Discovery document from GET /.well-known/romzo. */
export interface Discovery {
  protocol: string;
  version: string;
  origin: string;
  auth: "password" | "anonymous" | "off" | (string & {});
  salt: string;
  iterations: number;
  algorithm: string;
  /** Whether the relay enforces Cloudflare Turnstile on room creation. */
  turnstile: boolean;
  limits?: { framesPerSecond: number; bytesPerSecond: number };
}

/** POST /room-challenges response. */
export interface ChallengeResponse {
  challenge: string;
  expires: number;
}

/** POST /rooms/{code}/confirm response. */
export interface ConfirmResponse {
  admission: SignedTicket;
  recovery: SignedTicket;
}

/** POST /rooms/{code}/admissions response. */
export interface AdmissionResponse {
  admission: SignedTicket;
}

/** POST /rooms/{code}/restore response. */
export interface RestoreResponse {
  admission: SignedTicket;
}

/** Server-side frame shapes on the WebSocket (see FRAMES.md). */
export interface ServerFrame {
  v: string;
  kind: string;
  id?: string;
  channel?: string;
  peer?: string;
  key?: string;
  error?: string;
  value?: unknown;
  recovery?: SignedTicket;
}

export interface ChallengeValue {
  protocol: string;
  origin: string;
  ticket: string;
  challenge: string;
}
