/** Invitations carry room capabilities in the fragment, never passwords or query parameters. */
export interface InviteAddress { origin: string; code: string }
export interface InviteOptions { allowLoopbackHttp?: boolean }
const loopback = (host: string) => ['localhost', '127.0.0.1', '[::1]'].includes(host);
const codePattern = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$/;

/** Pure parsing: the application owns history.replaceState and persistence. */
export function parseInviteHash(hash: string, options: InviteOptions = {}): InviteAddress | null {
  if (typeof hash !== 'string' || hash.length > 320) return null;
  const match = /^#([0-9ABCDEFGHJKMNPQRSTVWXYZ]{10})@([A-Za-z0-9.\-:[\]]+)$/.exec(hash);
  if (!match) return null;
  try {
    let url = new URL(`https://${match[2]}`);
    if (options.allowLoopbackHttp && loopback(url.hostname)) url = new URL(`http://${match[2]}`);
    if (url.host !== match[2].toLowerCase() || url.pathname !== '/' || url.username || url.password || !url.hostname || (url.port && Number(url.port) < 1)) return null;
    return { origin: url.origin, code: match[1] };
  } catch { return null; }
}

export function buildInviteLink(origin: string, code: string, client: string, options: InviteOptions = {}): string {
  const relay = new URL(origin), app = new URL(client);
  const normalizedCode = code.replace(/^([A-Z0-9]{5})-([A-Z0-9]{5})$/, '$1$2');
  const localHttp = options.allowLoopbackHttp && app.protocol === 'http:' && loopback(app.hostname);
  if (!codePattern.test(normalizedCode) || relay.username || relay.password || relay.search || relay.hash || relay.pathname !== '/' || app.username || app.password ||
      (app.protocol !== 'https:' && !localHttp) || (relay.protocol !== 'https:' && !(localHttp && relay.protocol === 'http:' && loopback(relay.hostname)))) throw Error('invalid invitation address');
  const hash = `#${normalizedCode}@${relay.host}`;
  const parsed = parseInviteHash(hash, { allowLoopbackHttp: !!localHttp });
  if (!parsed || parsed.origin !== relay.origin) throw Error('ambiguous invitation scheme');
  app.search = '';
  app.hash = hash;
  return app.href;
}
