import { RelayHttpError, normalizeOrigin } from "./http.js";
import type { Discovery, SignedGrant } from "./types.js";
import { randomHex } from './canonical.js';
export interface EmbeddedVerificationOptions {
    mount?: {
        appendChild(node: any): unknown;
    };
    signal?: {
        readonly aborted: boolean;
        addEventListener(type: 'abort', handler: () => void): void;
        removeEventListener(type: 'abort', handler: () => void): void;
    };
    timeoutMs?: number;
}
/** Embed the relay-hosted check; without mount the SDK creates a dismissible dialog. */
export function requestEmbeddedGrant(origin: string, discovery: Discovery, host: string, options: EmbeddedVerificationOptions = {}): Promise<SignedGrant> {
    origin = normalizeOrigin(origin);
    if (!discovery.turnstilePage)
        return Promise.reject(new RelayHttpError('embedded_verification_unavailable', 400));
    if (typeof document === 'undefined')
        return Promise.reject(new Error('browser_verification_required'));
    if (options.signal?.aborted)
        return Promise.reject(new RelayHttpError('attestation_cancelled', 400));
    const requestId = randomHex(16);
    const url = new URL(discovery.turnstilePage, origin);
    if (url.origin !== origin)
        return Promise.reject(new RelayHttpError('invalid_verification_origin', 400));
    url.searchParams.set('parent', location.origin);
    url.searchParams.set('host', host);
    url.searchParams.set('request', requestId);
    const frame = document.createElement('iframe');
    frame.title = 'Romzo verification';
    frame.src = url.href;
    frame.style.cssText = 'width:100%;height:260px;border:0';
    let dialog: HTMLDialogElement | undefined;
    return new Promise((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); window.removeEventListener('message', receive); options.signal?.removeEventListener('abort', cancel); frame.remove(); if (dialog?.open)
            dialog.close(); dialog?.remove(); };
        const fail = (code: string) => { cleanup(); reject(new RelayHttpError(code, 400)); };
        const cancel = () => fail('attestation_cancelled');
        const receive = (event: MessageEvent) => {
            if (event.source !== frame.contentWindow || event.origin !== origin || event.data?.request !== requestId)
                return;
            if (event.data.type === GRANT_MESSAGE) {
                try {
                    const grant = validateGrant(discovery, event.data.grant, host, origin);
                    cleanup();
                    resolve(grant);
                }
                catch (error) {
                    cleanup();
                    reject(error);
                }
            }
            else if (event.data.type === GRANT_ERROR_MESSAGE)
                fail(typeof event.data.error === 'string' && /^[a-z_]{1,64}$/.test(event.data.error) ? event.data.error : 'attestation_failed');
        };
        const timer = setTimeout(() => fail('attestation_timeout'), options.timeoutMs ?? 120000);
        window.addEventListener('message', receive);
        options.signal?.addEventListener('abort', cancel);
        if (options.mount)
            options.mount.appendChild(frame);
        else {
            dialog = document.createElement('dialog');
            dialog.setAttribute('aria-label', 'Romzo verification');
            dialog.style.cssText = 'box-sizing:border-box;width:min(420px,calc(100vw - 32px));border:1px solid #ddd6d1;border-radius:16px;background:#faf7f5;color:#222;padding:24px;font:16px system-ui';
            const close = document.createElement('button');
            close.type = 'button';
            close.textContent = '取消 / Cancel';
            close.onclick = cancel;
            close.style.cssText = 'border:0;border-radius:10px;background:#bd421c;color:white;padding:10px 20px;font:inherit;cursor:pointer';
            dialog.append(frame, close);
            dialog.addEventListener('cancel', event => { event.preventDefault(); cancel(); });
            document.body.append(dialog);
            dialog.showModal();
        }
    });
}
/** postMessage types used between the relay's verification pages / SDK popup and the opener. */
export const GRANT_MESSAGE = "romzo-grant";
export const GRANT_ERROR_MESSAGE = "romzo-grant-error";
/** The popup listener's minimal surface, independent of DOM declaration files. */
export interface GrantMessageListener {
    addEventListener(type: "message", handler: (event: {
        data: unknown;
        source: unknown;
    }) => void): void;
    removeEventListener(type: "message", handler: (event: {
        data: unknown;
        source: unknown;
    }) => void): void;
}
/** Which attestations the discovery mode requires before room creation. */
export function attestationMode(auth: string): {
    turnstile: boolean;
    oauth: boolean;
} {
    return {
        turnstile: auth === "turnstile" || auth === "turnstile+oauth",
        oauth: auth === "oauth" || auth === "turnstile+oauth",
    };
}
const hex32 = /^[0-9a-f]{32}$/;
const hex64 = /^[0-9a-f]{64}$/;
/**
 * Structural checks a client can perform on a grant: the relay's HMAC key is
 * never exposed, so the signature itself cannot be verified here — but the
 * binding to our host key, origin, provider and expiry already prevents
 * cross-relay or cross-host replay of anything an attacker could inject.
 */
export function validateGrant(discovery: Discovery, grant: SignedGrant, host: string, origin: string): SignedGrant {
    const g = grant?.grant;
    if (!g ||
        typeof grant.signature !== "string" ||
        !hex64.test(grant.signature) ||
        g.protocol !== "romzo/v1" ||
        g.origin !== origin ||
        typeof g.provider !== "string" ||
        typeof g.subject !== "string" ||
        !hex32.test(g.nonce) ||
        !hex64.test(g.host) ||
        g.host !== host ||
        !Number.isSafeInteger(g.expires) ||
        g.expires <= Date.now())
        throw new RelayHttpError("invalid_grant", 401);
    const mode = attestationMode(discovery.auth);
    const providerOK = mode.turnstile && mode.oauth
        ? g.provider.startsWith("turnstile+oauth:")
        : mode.turnstile
            ? g.provider === "turnstile"
            : mode.oauth
                ? g.provider.startsWith("oauth:")
                : false;
    if (!providerOK)
        throw new RelayHttpError("invalid_grant", 401);
    return grant;
}
/**
 * Await the grant (or failure) a verification popup posts back. Messages are
 * accepted only from the given popup window; the grant is still validated
 * against origin, mode, and the creator host key before resolving.
 */
export function receiveGrant(listener: GrantMessageListener, source: object, origin: string, discovery: Discovery, host: string, timeoutMs = 300000): Promise<SignedGrant> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            reject(new RelayHttpError("attestation_timeout", 408));
        }, timeoutMs);
        const onMessage = (event: {
            data: unknown;
            source: unknown;
        }) => {
            if (event.source !== source)
                return;
            const data = event.data as {
                type?: unknown;
                grant?: SignedGrant;
                error?: unknown;
            } | null;
            if (!data || typeof data.type !== "string")
                return;
            if (data.type === GRANT_MESSAGE) {
                cleanup();
                try {
                    resolve(validateGrant(discovery, data.grant as SignedGrant, host, origin));
                }
                catch (error) {
                    reject(error);
                }
            }
            else if (data.type === GRANT_ERROR_MESSAGE) {
                cleanup();
                reject(new RelayHttpError(typeof data.error === "string" && /^[a-z_]{1,64}$/.test(data.error)
                    ? data.error
                    : "attestation_failed", 403));
            }
        };
        const cleanup = () => {
            clearTimeout(timer);
            listener.removeEventListener("message", onMessage);
        };
        listener.addEventListener("message", onMessage);
    });
}
function openPopup(url: string, features: string): Window {
    const popup = window.open(url, "romzo-verify", features);
    if (!popup)
        throw new Error("romzo attestation popup was blocked by the browser");
    return popup;
}
/** Obtain a creation grant. Turnstile uses a relay-hosted iframe; OAuth retains its popup. */
export async function requestGrant(origin: string, discovery: Discovery, host: string, options?: EmbeddedVerificationOptions): Promise<SignedGrant> {
    origin = normalizeOrigin(origin);
    const mode = attestationMode(discovery.auth);
    if (!mode.turnstile && !mode.oauth)
        throw new RelayHttpError("attestation_not_required", 400);
    if (mode.oauth) {
        if (!discovery.oauthLogin)
            throw new Error("relay announces oauth attestation but no oauthLogin endpoint");
        const popup = openPopup(`${origin}${discovery.oauthLogin}?host=${host}`, "width=520,height=720");
        return receiveGrant(window, popup, origin, discovery, host);
    }
    return requestEmbeddedGrant(origin, discovery, host, options);
}
