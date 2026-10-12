import { RelayHttpError, normalizeOrigin } from "./http.js";
import type { Discovery, SignedGrant } from "./types.js";

/** postMessage types used between the relay's verification pages / SDK popup and the opener. */
export const GRANT_MESSAGE = "romzo-grant";
export const GRANT_ERROR_MESSAGE = "romzo-grant-error";

/** The popup listener's minimal surface, independent of DOM declaration files. */
export interface GrantMessageListener {
  addEventListener(type: "message", handler: (event: { data: unknown; source: unknown }) => void): void;
  removeEventListener(type: "message", handler: (event: { data: unknown; source: unknown }) => void): void;
}

/** Which attestations the discovery mode requires before room creation. */
export function attestationMode(auth: string): { turnstile: boolean; oauth: boolean } {
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
export function validateGrant(
  discovery: Discovery,
  grant: SignedGrant,
  host: string,
  origin: string,
): SignedGrant {
  const g = grant?.grant;
  if (
    !g ||
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
    g.expires <= Date.now()
  )
    throw new RelayHttpError("invalid_grant", 401);
  const mode = attestationMode(discovery.auth);
  const providerOK = mode.turnstile && mode.oauth
    ? g.provider.startsWith("turnstile+oauth:")
    : mode.turnstile
      ? g.provider === "turnstile"
      : mode.oauth
        ? g.provider.startsWith("oauth:")
        : false;
  if (!providerOK) throw new RelayHttpError("invalid_grant", 401);
  return grant;
}

/**
 * Await the grant (or failure) a verification popup posts back. Messages are
 * accepted only from the given popup window; the grant is still validated
 * against origin, mode, and the creator host key before resolving.
 */
export function receiveGrant(
  listener: GrantMessageListener,
  source: object,
  origin: string,
  discovery: Discovery,
  host: string,
  timeoutMs = 300_000,
): Promise<SignedGrant> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new RelayHttpError("attestation_timeout", 408));
    }, timeoutMs);
    const onMessage = (event: { data: unknown; source: unknown }) => {
      if (event.source !== source) return;
      const data = event.data as { type?: unknown; grant?: SignedGrant; error?: unknown } | null;
      if (!data || typeof data.type !== "string") return;
      if (data.type === GRANT_MESSAGE) {
        cleanup();
        try {
          resolve(validateGrant(discovery, data.grant as SignedGrant, host, origin));
        } catch (error) {
          reject(error);
        }
      } else if (data.type === GRANT_ERROR_MESSAGE) {
        cleanup();
        reject(
          new RelayHttpError(
            typeof data.error === "string" && /^[a-z_]{1,64}$/.test(data.error)
              ? data.error
              : "attestation_failed",
            403,
          ),
        );
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      listener.removeEventListener("message", onMessage);
    };
    listener.addEventListener("message", onMessage);
  });
}

/** Escape a value for safe embedding inside the popup's inline <script>. */
function scriptJSON(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function openPopup(url: string, features: string): Window {
  const popup = window.open(url, "romzo-verify", features);
  if (!popup) throw new Error("romzo attestation popup was blocked by the browser");
  return popup;
}

/**
 * Obtain a creation grant for the given host key, driving the browser
 * verification UI. OAuth modes (including the combined turnstile+oauth mode)
 * redirect a popup to the relay's hosted login page, which finishes with a
 * postMessage. Turnstile-only mode renders the widget in a same-origin popup
 * controlled by the SDK; note the opener page's Content-Security-Policy
 * applies to that popup, so pages with a strict script-src should instead
 * collect a token themselves and pass it as turnstileToken.
 */
export async function requestGrant(
  origin: string,
  discovery: Discovery,
  host: string,
): Promise<SignedGrant> {
  origin = normalizeOrigin(origin);
  const mode = attestationMode(discovery.auth);
  if (!mode.turnstile && !mode.oauth)
    throw new RelayHttpError("attestation_not_required", 400);
  if (mode.oauth) {
    if (!discovery.oauthLogin)
      throw new Error("relay announces oauth attestation but no oauthLogin endpoint");
    const popup = openPopup(
      `${origin}${discovery.oauthLogin}?host=${host}`,
      "width=520,height=720",
    );
    return receiveGrant(window, popup, origin, discovery, host);
  }
  if (!discovery.turnstileSiteKey)
    throw new Error(
      "relay announces turnstile attestation but no turnstileSiteKey; pass turnstileToken or grant explicitly",
    );
  const popup = openPopup("", "width=460,height=640");
  const config = scriptJSON({
    verify: `${origin}/api/v1/verify`,
    host,
    sitekey: discovery.turnstileSiteKey,
    grant: GRANT_MESSAGE,
    error: GRANT_ERROR_MESSAGE,
  });
  popup.document.write(`<!doctype html><meta charset="utf-8"><title>Romzo verification</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:80vh;margin:0;color:#1a1a2e}p{max-width:20rem;text-align:center}</style>
<p id="m">请完成人机验证以创建房间。</p>
<div id="box"></div>
<script src="https://challenges.cloudflare.com/turnstile/api.js?render=explicit"></script>
<script>
const cfg = ${config};
window.turnstile.render("#box", {
  sitekey: cfg.sitekey,
  callback(token) {
    document.getElementById("m").textContent = "验证中…";
    fetch(cfg.verify, {method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({turnstile: token, host: cfg.host})})
      .then((r) => r.json().then((j) => r.ok ? j : Promise.reject(j)))
      .then((j) => {
        window.opener && window.opener.postMessage({type: cfg.grant, grant: j.grant}, "*");
        document.getElementById("m").textContent = "验证成功，可以关闭此页面。";
      })
      .catch(() => {
        window.opener && window.opener.postMessage({type: cfg.error, error: "turnstile_failed"}, "*");
        document.getElementById("m").textContent = "验证失败，请关闭后重试。";
        window.turnstile.reset();
      });
  },
});
</script>`);
  popup.document.close();
  return receiveGrant(window, popup, origin, discovery, host);
}
