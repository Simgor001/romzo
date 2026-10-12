import { expect, test } from 'vitest';
import { buildInviteLink, buildLanInvite, parseInviteHash, parseInviteText } from '../src/invite.js';

test('canonical invitations round-trip without query credentials', () => {
  const url = buildInviteLink('https://romzo.net:9224', 'ABCD123XYZ', 'https://game.example/sub/?old=value#old');
  expect(url).toBe('https://game.example/sub/#ABCD123XYZ/romzo.net:9224');
  expect(parseInviteHash(new URL(url).hash)).toEqual({ origin: 'https://romzo.net:9224', code: 'ABCD123XYZ' });
  expect(parseInviteHash('#ABCD123XYZ@relay.example:9443')).toEqual({ origin: 'https://relay.example:9443', code: 'ABCD123XYZ' });
});
test('an omitted port is the service default 443; a non-default port must be written explicitly', () => {
  expect(parseInviteHash('#ABCD123XYZ@romzo.net')).toEqual({ origin: 'https://romzo.net', code: 'ABCD123XYZ' });
  expect(parseInviteHash('#ABCD123XYZ@romzo.net:9224')).toEqual({ origin: 'https://romzo.net:9224', code: 'ABCD123XYZ' });
  expect(buildInviteLink('https://romzo.net:443', 'ABCD123XYZ', 'https://game.example/')).toBe('https://game.example/#ABCD123XYZ/romzo.net');
  expect(parseInviteHash(new URL(buildInviteLink('https://romzo.net:443', 'ABCD123XYZ', 'https://game.example/')).hash))
    .toEqual({ origin: 'https://romzo.net', code: 'ABCD123XYZ' });
});
test('loopback HTTP is explicit, and production cannot opt in to remote HTTP', () => {
  const options = { allowLoopbackHttp: true };
  const url = buildInviteLink('http://127.0.0.1:8080', 'ABCD123XYZ', 'http://localhost:5190', options);
  expect(parseInviteHash(new URL(url).hash, options)).toEqual({ origin: 'http://127.0.0.1:8080', code: 'ABCD123XYZ' });
  expect(parseInviteHash(new URL(url).hash)).toEqual({ origin: 'https://127.0.0.1:8080', code: 'ABCD123XYZ' });
  expect(parseInviteHash('#ABCD123XYZ@localhost', options)).toEqual({ origin: 'http://localhost:443', code: 'ABCD123XYZ' });
  expect(parseInviteHash('#ABCD123XYZ@localhost')).toEqual({ origin: 'https://localhost', code: 'ABCD123XYZ' });
  expect(() => buildInviteLink('http://romzo.net', 'ABCD123XYZ', 'http://localhost', options)).toThrow();
  expect(() => buildInviteLink('http://localhost', 'ABCD123XYZ', 'https://game.example', options)).toThrow();
  for (const origin of ['http://localhost:443', 'http://[::1]:8080']) {
    const link = buildInviteLink(origin, 'ABCD123XYZ', 'http://localhost:5190', options);
    expect(parseInviteHash(new URL(link).hash, options)).toEqual({ origin, code: 'ABCD123XYZ' });
  }
});
test('malformed and credential-bearing fragments fail closed', () => {
  for (const hash of ['#ABCD123XYI@romzo.net', '#ABCD123XYZ@user:pass@romzo.net', '#ABCD123XYZ@romzo.net/path', '#ABCD123XYZ@romzo.net?key=secret', '#ABCD123XYZ@romzo.net:0', '#ABCD123XYZ@romzo.net:65536', '#ABCD123XYZ@https://romzo.net', '#abcd123xyz@romzo.net', '#ABCD123XYZ@romzo.net#extra']) expect(parseInviteHash(hash)).toBeNull();
});

test('social sharing uses slash and retains legacy invitations', () => {
  const url = buildInviteLink('https://romzo.net', 'ABCD123XYZ', 'https://romzo.net/play.html');
  expect(url).toBe('https://romzo.net/play.html#ABCD123XYZ/romzo.net');
  expect(url).not.toContain('@');
  expect(parseInviteHash('#ABCD123XYZ/romzo.net')).toEqual(parseInviteHash('#ABCD123XYZ@romzo.net'));
  for (const suffix of ['user:pass@romzo.net', 'romzo.net/path', 'romzo.net?key=secret', 'romzo.net:0'])
    expect(parseInviteHash('#ABCD123XYZ/' + suffix)).toBeNull();
});

test('invitation text parses links, bare fragments and bare code/host strings', () => {
  const relay = { origin: 'https://romzo.net', code: 'ABCD123XYZ' };
  expect(parseInviteText('https://romzo.net/play.html#ABCD123XYZ/romzo.net')).toEqual(relay);
  expect(parseInviteText('  #ABCD123XYZ/romzo.net  ')).toEqual(relay);
  expect(parseInviteText('ABCD123XYZ/romzo.net')).toEqual(relay);
  expect(parseInviteText('ABCD123XYZ@romzo.net:9224')).toEqual({ origin: 'https://romzo.net:9224', code: 'ABCD123XYZ' });
  // LAN links flow through unchanged.
  expect(parseInviteText('https://game.example/#ABCD123XYZ/192.168.1.50:7777')).toEqual({ code: 'ABCD123XYZ', lan: ['192.168.1.50:7777'] });
  expect(parseInviteText('https://game.example/#ABCD123XYZ/lan')).toEqual({ code: 'ABCD123XYZ', lan: [] });
  // Credentials, queries and non-https links carry no invitations.
  for (const text of ['javascript:alert(1)', 'https://' + 'user:pass@romzo.net/#ABCD123XYZ/romzo.net',
    'https://romzo.net/?token=secret#ABCD123XYZ/romzo.net', 'http://remote.example/#ABCD123XYZ/romzo.net', 'not an invite'])
    expect(parseInviteText(text)).toBeNull();
  expect(parseInviteText('http://127.0.0.1:7100/#ABCD123XYZ/127.0.0.1:9224', { allowLoopbackHttp: true }))
    .toEqual({ origin: 'http://127.0.0.1:9224', code: 'ABCD123XYZ' });
});

test('private literals auto-detect as LAN direct-connect invitations', () => {
  for (const [hash, host] of [
    ['#ABCD123XYZ/192.168.1.50:7777', '192.168.1.50:7777'],
    ['#ABCD123XYZ@10.20.30.40:9224', '10.20.30.40:9224'],
    ['#ABCD123XYZ/172.16.0.9:1', '172.16.0.9:1'],
    ['#ABCD123XYZ/172.31.255.255:65535', '172.31.255.255:65535'],
    ['#ABCD123XYZ/169.254.7.7:5000', '169.254.7.7:5000'],
    ['#ABCD123XYZ/100.64.0.5:5000', '100.64.0.5:5000'],
    ['#ABCD123XYZ/printer.local:9224', 'printer.local:9224'],
    ['#ABCD123XYZ/[fd12:3456::1]:7777', '[fd12:3456::1]:7777'],
    ['#ABCD123XYZ/[fe80::1]:7777', '[fe80::1]:7777'],
  ] as const)
    expect(parseInviteHash(hash)).toEqual({ code: 'ABCD123XYZ', lan: [host] });
  // Public literals and near-miss ranges keep their original relay-origin semantics.
  for (const host of ['8.8.8.8', '11.0.0.1', '172.15.0.1', '172.32.0.1', '192.167.0.1', '192.169.0.1', '100.63.0.1', '100.128.0.1', 'lan.localhost'])
    expect(parseInviteHash(`#ABCD123XYZ/${host}:9224`)).toEqual({ origin: `https://${host}:9224`, code: 'ABCD123XYZ' });
  // Not a private literal and not a valid relay origin either.
  expect(parseInviteHash('#ABCD123XYZ/256.1.1.1:9224')).toBeNull();
  // Loopback stays a relay origin (HTTP only by explicit opt-in), never a LAN host.
  expect(parseInviteHash('#ABCD123XYZ/127.0.0.1:8080')).toEqual({ origin: 'https://127.0.0.1:8080', code: 'ABCD123XYZ' });
  expect(parseInviteHash('#ABCD123XYZ/127.0.0.1:8080', { allowLoopbackHttp: true })).toEqual({ origin: 'http://127.0.0.1:8080', code: 'ABCD123XYZ' });
});

test('lan discovery form and multi-candidate lists', () => {
  expect(parseInviteHash('#ABCD123XYZ/lan')).toEqual({ code: 'ABCD123XYZ', lan: [] });
  expect(parseInviteHash('#ABCD123XYZ@lan')).toEqual({ code: 'ABCD123XYZ', lan: [] });
  expect(parseInviteHash('#ABCD123XYZ/192.168.1.50,10.0.0.7:7777'))
    .toEqual({ code: 'ABCD123XYZ', lan: ['192.168.1.50:7777', '10.0.0.7:7777'] });
  expect(parseInviteHash('#ABCD123XYZ/printer.local,192.168.0.9:9224'))
    .toEqual({ code: 'ABCD123XYZ', lan: ['printer.local:9224', '192.168.0.9:9224'] });
  // A relay host literally named "lan" with an explicit port keeps relay semantics;
  // only the bare keyword is the discovery form.
  expect(parseInviteHash('#ABCD123XYZ/lan:7777')).toEqual({ origin: 'https://lan:7777', code: 'ABCD123XYZ' });
  for (const hash of ['#ABCD123XYZ/8.8.8.8,10.0.0.7:7777', '#ABCD123XYZ/192.168.1.50,10.0.0.7',
    '#ABCD123XYZ/192.168.1.50:0', '#ABCD123XYZ/:7777', '#ABCD123XYZ/lan,10.0.0.1:7777',
    '#ABCD123XYZ/192.168.1.50,10.0.0.7:7777:8888', '#ABCD123XYZ/192.168.1.50,,10.0.0.7:7777'])
    expect(parseInviteHash(hash)).toBeNull();
});

test('buildLanInvite round-trips candidates and the discovery form', () => {
  const link = buildLanInvite('ABCD123XYZ', ['192.168.1.50:7777', '10.0.0.7:7777'], 'https://game.example/');
  expect(link).toBe('https://game.example/#ABCD123XYZ/192.168.1.50,10.0.0.7:7777');
  expect(parseInviteHash(new URL(link).hash)).toEqual({ code: 'ABCD123XYZ', lan: ['192.168.1.50:7777', '10.0.0.7:7777'] });
  const discovery = buildLanInvite('ABCD123XYZ', [], 'https://game.example/');
  expect(discovery).toBe('https://game.example/#ABCD123XYZ/lan');
  expect(parseInviteHash(new URL(discovery).hash)).toEqual({ code: 'ABCD123XYZ', lan: [] });
  const v6 = buildLanInvite('ABCD123XYZ', ['[fd12:3456::1]:7777'], 'https://game.example/');
  expect(parseInviteHash(new URL(v6).hash)).toEqual({ code: 'ABCD123XYZ', lan: ['[fd12:3456::1]:7777'] });
  // One shared port, private literals, code shape and an HTTPS client are enforced.
  const bad: [string, string[], string][] = [
    ['ABCD123XYZ', ['192.168.1.50:7777', '10.0.0.7:8888'], 'https://game.example/'],
    ['ABCD123XYZ', ['8.8.8.8:7777'], 'https://game.example/'],
    ['ABCD123XYZ', ['192.168.1.50:77770'], 'https://game.example/'],
    ['ABCD123XYZ', ['192.168.1.50'], 'https://game.example/'],
    ['ABCD123XYI', ['192.168.1.50:7777'], 'https://game.example/'],
    ['ABCD123XYZ', ['192.168.1.50:7777'], 'http://game.example/'],
  ];
  for (const args of bad) expect(() => buildLanInvite(...args)).toThrow();
});
