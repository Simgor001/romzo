/** Invitations carry room capabilities in the fragment, never passwords or query parameters. */
export interface InviteAddress { origin: string; code: string }
export interface InviteOptions { allowLoopbackHttp?: boolean }
/** Service default relay port: an invite that omits the port targets this port. */
export const DEFAULT_RELAY_PORT = 9224;
const loopback = (host: string) => ['localhost', '127.0.0.1', '[::1]'].includes(host);
const codePattern = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$/;

/** Pure parsing: the application owns history.replaceState and persistence. */
export function parseInviteHash(hash: string, options: InviteOptions = {}): InviteAddress | null {
  if (typeof hash !== 'string' || hash.length > 320) return null;
  const match = /^#([0-9ABCDEFGHJKMNPQRSTVWXYZ]{10})@([A-Za-z0-9.\-:[\]]+)$/.exec(hash);
  if (!match) return null;
  const spec = match[2].toLowerCase();
  const parts = /^(\[[0-9a-f:]+\]|[a-z0-9.\-]+):(\d+)$/.exec(spec);
  const host = parts ? parts[1] : spec;
  const port = parts ? Number(parts[2]) : DEFAULT_RELAY_PORT;
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  try {
    const scheme = options.allowLoopbackHttp && loopback(host) ? 'http' : 'https';
    const url = new URL(`${scheme}://${host}:${port}`);
    if (url.pathname !== '/' || url.username || url.password || !url.hostname) return null;
    return { origin: url.origin, code: match[1] };
  } catch { return null; }
}

export function buildInviteLink(origin: string, code: string, client: string, options: InviteOptions = {}): string {
  const relay = new URL(origin), app = new URL(client);
  const normalizedCode = code.replace(/^([A-Z0-9]{5})-([A-Z0-9]{5})$/, '$1$2');
  const localHttp = options.allowLoopbackHttp && app.protocol === 'http:' && loopback(app.hostname);
  if (!codePattern.test(normalizedCode) || relay.username || relay.password || relay.search || relay.hash || relay.pathname !== '/' || app.username || app.password ||
      (app.protocol !== 'https:' && !localHttp) || (relay.protocol !== 'https:' && !(localHttp && relay.protocol === 'http:' && loopback(relay.hostname)))) throw Error('invalid invitation address');
  // An omitted port reads back as DEFAULT_RELAY_PORT, so only the service default may be omitted;
  // a scheme-default port (https:443, http:80) must be written explicitly to survive the round trip.
  const relayHost = relay.port === String(DEFAULT_RELAY_PORT) ? relay.hostname
    : relay.port === '' ? `${relay.hostname}:${relay.protocol === 'https:' ? 443 : 80}`
    : relay.host;
  const hash = `#${normalizedCode}@${relayHost}`;
  const parsed = parseInviteHash(hash, { allowLoopbackHttp: !!localHttp });
  if (!parsed || parsed.origin !== relay.origin) throw Error('ambiguous invitation scheme');
  app.search = '';
  app.hash = hash;
  return app.href;
}
