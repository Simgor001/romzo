/** Invitations carry room capabilities in the fragment, never passwords or query parameters. */
export interface InviteAddress {
  /** Relay origin for public rooms; absent for LAN invites. */
  origin?: string;
  code: string;
  /**
   * LAN direct-connect candidates "host:port" in try order. An empty array is the
   * discovery form (`#CODE/lan`): find the room on the local network by code.
   * Absent for relay invites.
   */
  lan?: string[];
}
export interface InviteOptions { allowLoopbackHttp?: boolean }
/** Service default relay port: an invite that omits the port targets this port. */
export const DEFAULT_RELAY_PORT = 443;
const loopback = (host: string) => ['localhost', '127.0.0.1', '[::1]'].includes(host);
const codePattern = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$/;
const codeTextPattern = /^#?[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}[/@]/;
/** LAN discovery form: no host, the room code is the rendezvous key on the local network. */
const LAN_KEYWORD = "lan";
/** At most eight LAN candidates share one invite (and one listener port). */
const LAN_MAX_HOSTS = 8;

function privateV4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m || m.slice(1).some(o => Number(o) > 255)) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}
/** Non-loopback addresses reachable only on a local network. */
function privateHost(host: string): boolean {
  return privateV4(host) || host.endsWith(".local") || /^f[cd][0-9a-f]{2}:/.test(host) || host.startsWith("fe80:");
}

/** Pure parsing: the application owns history.replaceState and persistence. */
export function parseInviteHash(hash: string, options: InviteOptions = {}): InviteAddress | null {
  if (typeof hash !== 'string' || hash.length > 320) return null;
  const match = /^#([0-9ABCDEFGHJKMNPQRSTVWXYZ]{10})[/@]([A-Za-z0-9.,\-:[\]]+)$/.exec(hash);
  if (!match) return null;
  const spec = match[2].toLowerCase();
  if (spec === LAN_KEYWORD) return { code: match[1], lan: [] };
  if (spec.includes(",")) {
    // LAN candidate list: host1,host2:port — one shared explicit port, private literals only.
    const list = /^([a-z0-9.\-]+(?:,[a-z0-9.\-]+)*):(\d+)$/.exec(spec);
    if (!list) return null;
    const port = Number(list[2]);
    if (port < 1 || port > 65535) return null;
    const lan = list[1].split(",").map(host => `${host}:${port}`);
    if (lan.length > LAN_MAX_HOSTS || !lan.every(h => privateHost(h.slice(0, h.lastIndexOf(":"))))) return null;
    return { code: match[1], lan };
  }
  const parts = /^(\[[0-9a-f:]+\]|[a-z0-9.\-]+):(\d+)$/.exec(spec);
  const host = parts ? parts[1] : spec;
  const port = parts ? Number(parts[2]) : DEFAULT_RELAY_PORT;
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  // A private literal is a direct LAN host, never a relay origin; public IP literals
  // stay relay origins, preserving the original semantics for IP-addressed relays.
  if (!loopback(host) && privateHost(host.startsWith("[") ? host.slice(1, -1) : host))
    return { code: match[1], lan: [`${host}:${port}`] };
  try {
    const scheme = options.allowLoopbackHttp && loopback(host) ? 'http' : 'https';
    const url = new URL(`${scheme}://${host}:${port}`);
    if (url.pathname !== '/' || url.username || url.password || !url.hostname) return null;
    return { origin: url.origin, code: match[1] };
  } catch { return null; }
}

/**
 * Parse arbitrary invitation text: a full http(s) link, a bare fragment, or a
 * bare "CODE/host" string. Links with embedded credentials or a query string
 * are rejected — invitations live in the fragment and carry no secrets.
 */
export function parseInviteText(text: string, options: InviteOptions = {}): InviteAddress | null {
  if (typeof text !== 'string' || text.length > 2048) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('#') || codeTextPattern.test(trimmed))
    return parseInviteHash(trimmed.startsWith('#') ? trimmed : `#${trimmed}`, options);
  let url: URL;
  try { url = new URL(trimmed); } catch { return null; }
  if ((url.protocol !== 'https:' && !(options.allowLoopbackHttp && url.protocol === 'http:' && loopback(url.hostname))) ||
      url.username || url.password || url.search) return null;
  return parseInviteHash(url.hash, options);
}

export function buildInviteLink(origin: string, code: string, client: string, options: InviteOptions = {}): string {
  const relay = new URL(origin), app = new URL(client);
  const normalizedCode = code.replace(/^([A-Z0-9]{5})-([A-Z0-9]{5})$/, '$1$2');
  const localHttp = options.allowLoopbackHttp && app.protocol === 'http:' && loopback(app.hostname);
  if (!codePattern.test(normalizedCode) || relay.username || relay.password || relay.search || relay.hash || relay.pathname !== '/' || app.username || app.password ||
      (app.protocol !== 'https:' && !localHttp) || (relay.protocol !== 'https:' && !(localHttp && relay.protocol === 'http:' && loopback(relay.hostname)))) throw Error('invalid invitation address');
  // An omitted port reads back as DEFAULT_RELAY_PORT, so only the service default may be omitted.
  // URL normalization already strips https's default port, so an empty port here means
  // "https on the service default" and may be written bare; any other port (including
  // http scheme-defaults like :80 or http://host:443) must stay explicit to round-trip.
  const relayHost = relay.port === "" ? relay.hostname : relay.host;
  const hash = `#${normalizedCode}/${relayHost}`;
  const parsed = parseInviteHash(hash, { allowLoopbackHttp: !!localHttp });
  if (!parsed || parsed.origin !== relay.origin) throw Error('ambiguous invitation scheme');
  app.search = '';
  app.hash = hash;
  return app.href;
}

/**
 * Build a LAN invitation. Each candidate is "host:port"; all candidates must be
 * private LAN literals sharing one port (a host listens on every address with a
 * single socket). An empty list builds the discovery form `#CODE/lan`, where the
 * room code is the rendezvous key on the local network.
 */
export function buildLanInvite(code: string, hosts: string[], client: string): string {
  const app = new URL(client);
  const normalizedCode = code.replace(/^([A-Z0-9]{5})-([A-Z0-9]{5})$/, '$1$2');
  if (!codePattern.test(normalizedCode) || app.username || app.password ||
      (app.protocol !== 'https:' && !(app.protocol === 'http:' && loopback(app.hostname)))) throw Error('invalid invitation address');
  let hash: string;
  if (hosts.length === 0) {
    hash = `#${normalizedCode}/${LAN_KEYWORD}`;
  } else {
    if (hosts.length > LAN_MAX_HOSTS) throw Error('invalid invitation address');
    const parsed = hosts.map(candidate => {
      const m = /^(\[[0-9a-f:]+\]|[a-z0-9.\-]+):(\d+)$/i.exec(candidate.trim().toLowerCase());
      const port = m ? Number(m[2]) : 0;
      if (!m || port < 1 || port > 65535) throw Error('invalid invitation address');
      const host = m[1];
      if (!privateHost(host.startsWith("[") ? host.slice(1, -1) : host)) throw Error('invalid invitation address');
      return { host, port };
    });
    if (new Set(parsed.map(p => p.port)).size !== 1) throw Error('invalid invitation address');
    hash = `#${normalizedCode}/${parsed.map(p => p.host).join(",")}:${parsed[0].port}`;
  }
  const roundTrip = parseInviteHash(hash);
  if (!roundTrip || !roundTrip.lan || roundTrip.lan.length !== hosts.length) throw Error('ambiguous invitation');
  app.search = '';
  app.hash = hash;
  return app.href;
}
