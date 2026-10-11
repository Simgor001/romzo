import { hash, randomHex, unhex } from "./canonical.js";
import {
  derivePasswordKey,
  generateKeyPair,
  passwordProof,
  sign,
  verify,
  type Identity,
  type PasswordKeyProvider,
} from "./crypto.js";
import {
  allocate,
  confirmRoom,
  createChallenge,
  discover,
  fetchDescriptor,
  normalizeOrigin,
  requestAdmission,
  restoreRoom,
  RelayHttpError,
  type HttpOptions,
} from "./http.js";
import { PROTOCOL } from "./types.js";
import type {
  AllocationRequest,
  Descriptor,
  Discovery,
  SignedDescriptor,
  SignedTicket,
} from "./types.js";

/** Materials a host needs after createRoom() to connect and persist state. */
export interface CreatedRoom {
  discovery: Discovery;
  /** Application-level host key (signs the descriptor). */
  host: Identity;
  /** Transport key (authenticates on the WebSocket). */
  transport: Identity;
  descriptor: Descriptor;
  signedDescriptor: SignedDescriptor;
  admission: SignedTicket;
  recovery: SignedTicket;
}

/** Materials a guest needs after joinRoom() to connect. */
export interface JoinedRoom {
  signedDescriptor: SignedDescriptor;
  transport: Identity;
  admission: SignedTicket;
}

/** Materials produced by restoreSession() after a crash or relay restart. */
export interface RestoredRoom {
  signedDescriptor: SignedDescriptor;
  transport: Identity;
  admission: SignedTicket;
}

export interface CreateRoomOptions extends HttpOptions {
  /** Application policy checked immediately after discovery, before allocation. */
  validateDiscovery?: (discovery: Discovery) => unknown | Promise<unknown>;
  /** Room creation password (required when the relay uses password auth). */
  password?: string;
  /** Cloudflare Turnstile token, when Discovery.turnstile is true. */
  turnstileToken?: string;
  /** Application host key; generated when omitted. */
  host?: Identity;
  /** Transport key; generated when omitted. */
  transport?: Identity;
  /** Credential-bound key provider. Used instead of password when supplied. */
  passwordKeyProvider?: PasswordKeyProvider;
  validateOptions?: (options: unknown) => unknown | Promise<unknown>;
}

export interface JoinRoomOptions extends HttpOptions {
  /** Transport key; generated when omitted. */
  transport?: Identity;
  validateOptions?: (options: unknown) => unknown | Promise<unknown>;
}

/** Validate the signed wire record before trusting options or requesting admission. */
export async function verifyDescriptor(
  signed: SignedDescriptor,
  origin: string,
  code: string,
  validateOptions?: (options: unknown) => unknown | Promise<unknown>,
): Promise<SignedDescriptor> {
  const d = signed?.descriptor;
  if (!d || Object.keys(signed).sort().join(",") !== "descriptor,signature" ||
      Object.keys(d).sort().join(",") !== "capability,code,configHash,host,instance,options,origin,protocol,transport" ||
      ![d.protocol, d.origin, d.code, d.instance, d.host, d.transport, d.capability, d.configHash].every(v => typeof v === "string") ||
      d.protocol !== PROTOCOL || d.origin !== origin || d.code !== code ||
      !/^[0-9A-HJKMNP-TV-Z]{10}$/.test(d.code) ||
      !/^[a-f0-9]{32}$/.test(d.instance) || !/^[a-f0-9]{32}$/.test(d.capability) ||
      !/^[a-f0-9]{64}$/.test(d.host) || !/^[a-f0-9]{64}$/.test(d.transport) ||
      !/^[a-f0-9]{64}$/.test(d.configHash))
    throw new RelayHttpError("invalid_descriptor", 400);
  let valid = false;
  try {
    valid = typeof signed.signature === "string" && /^[a-f0-9]{128}$/.test(signed.signature) &&
      await hash("romzo/lobby-options/v1", d.options) === d.configHash &&
      await verify(d.host, d, "romzo/relay-descriptor/v1", signed.signature);
  } catch { /* Unsupported canonical values are invalid descriptors. */ }
  if (!valid) throw new RelayHttpError("invalid_descriptor_signature", 400);
  await validateOptions?.(d.options);
  return signed;
}

export interface RestoreRoomOptions extends HttpOptions {}

/** Validate the fields a client can check on an allocated descriptor. */
export function assertAllocation(
  descriptor: Descriptor,
  request: AllocationRequest,
): void {
  if (
    descriptor.protocol !== PROTOCOL ||
    descriptor.origin !== request.origin ||
    descriptor.host !== request.host ||
    descriptor.transport !== request.transport ||
    descriptor.capability !== request.capability ||
    descriptor.configHash !== request.configHash
  )
    throw new Error("descriptor does not match allocation request");
  if (!/^[0-9A-HJKMNP-TV-Z]{10}$/.test(descriptor.code))
    throw new Error("invalid room code");
}

/**
 * High-level room creation: challenge -> allocate -> confirm.
 * Returns everything needed to open a RelaySession and to persist
 * { signedDescriptor, transport, recovery } for crash recovery.
 */
export async function createRoom(
  origin: string,
  options: unknown,
  opts: CreateRoomOptions = {},
): Promise<CreatedRoom> {
  origin = normalizeOrigin(origin);
  const discovery = await discover(origin, opts);
  await opts.validateDiscovery?.(discovery);
  if (discovery.auth === "password" && !opts.password && !opts.passwordKeyProvider)
    throw new Error("relay requires a creation password");
  const host = opts.host ?? (await generateKeyPair());
  const transport = opts.transport ?? (await generateKeyPair());
  const { challenge } = await createChallenge(origin, opts);
  const request: AllocationRequest = {
    protocol: PROTOCOL,
    origin,
    challenge,
    requestId: randomHex(16),
    host: host.publicKey,
    transport: transport.publicKey,
    configHash: await hash("romzo/lobby-options/v1", options),
    capability: randomHex(16),
    options,
  };
  let proof = "";
  if (discovery.auth === "password") {
    const key = opts.passwordKeyProvider
      ? await opts.passwordKeyProvider.get(origin, discovery.salt, discovery.iterations)
      : await derivePasswordKey(opts.password!, unhex(discovery.salt), discovery.iterations);
    proof = await passwordProof(key, "romzo/relay-create/v1", request);
  }
  let descriptor: Descriptor;
  try { descriptor = await allocate(
    origin,
    request,
    proof,
    opts.turnstileToken,
    opts,
  ); } catch (error) {
    if (error instanceof RelayHttpError && error.code === "authorization_failed") opts.passwordKeyProvider?.clear(origin);
    throw error;
  }
  assertAllocation(descriptor, request);
  const signedDescriptor: SignedDescriptor = {
    descriptor,
    signature: await sign(host, descriptor, "romzo/relay-descriptor/v1"),
  };
  await verifyDescriptor(signedDescriptor, origin, descriptor.code, opts.validateOptions);
  const { admission, recovery } = await confirmRoom(
    origin,
    descriptor.code,
    signedDescriptor,
    opts,
  );
  return {
    discovery,
    host,
    transport,
    descriptor,
    signedDescriptor,
    admission,
    recovery,
  };
}

/**
 * High-level guest join: fetch the published descriptor, then mint an
 * admission ticket for the local transport key.
 */
export async function joinRoom(
  origin: string,
  code: string,
  opts: JoinRoomOptions = {},
): Promise<JoinedRoom> {
  origin = normalizeOrigin(origin);
  const signedDescriptor = await fetchDescriptor(origin, code, opts);
  await verifyDescriptor(signedDescriptor, origin, code, opts.validateOptions);
  const transport = opts.transport ?? (await generateKeyPair());
  const { admission } = await requestAdmission(
    origin,
    code,
    transport.publicKey,
    opts,
  );
  return { signedDescriptor, transport, admission };
}

/**
 * Crash/restart recovery: restore the room with a persisted recovery ticket,
 * then sign the restore request with the persisted transport key.
 */
export async function restoreSession(
  signedDescriptor: SignedDescriptor,
  recovery: SignedTicket,
  transport: Identity,
  opts: RestoreRoomOptions = {},
): Promise<RestoredRoom> {
  const { origin, code } = signedDescriptor.descriptor;
  const signature = await sign(transport, recovery, "romzo/relay-restore/v1");
  const { admission } = await restoreRoom(
    origin,
    code,
    signedDescriptor,
    recovery,
    signature,
    opts,
  );
  return { signedDescriptor, transport, admission };
}
