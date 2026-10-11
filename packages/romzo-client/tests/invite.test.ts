import { expect, test } from 'vitest';
import { buildInviteLink, parseInviteHash } from '../src/invite.js';

test('canonical invitations round-trip without query credentials', () => {
  const url = buildInviteLink('https://romzo.net:9224', 'ABCD123XYZ', 'https://game.example/sub/?old=value#old');
  expect(url).toBe('https://game.example/sub/#ABCD123XYZ@romzo.net');
  expect(parseInviteHash(new URL(url).hash)).toEqual({ origin: 'https://romzo.net:9224', code: 'ABCD123XYZ' });
  expect(parseInviteHash('#ABCD123XYZ@relay.example:9443')).toEqual({ origin: 'https://relay.example:9443', code: 'ABCD123XYZ' });
});
test('an omitted port is the service default 9224; a 443 relay must write :443 explicitly', () => {
  expect(parseInviteHash('#ABCD123XYZ@romzo.net')).toEqual({ origin: 'https://romzo.net:9224', code: 'ABCD123XYZ' });
  expect(parseInviteHash('#ABCD123XYZ@romzo.net:443')).toEqual({ origin: 'https://romzo.net', code: 'ABCD123XYZ' });
  expect(buildInviteLink('https://romzo.net', 'ABCD123XYZ', 'https://game.example/')).toBe('https://game.example/#ABCD123XYZ@romzo.net:443');
  expect(parseInviteHash(new URL(buildInviteLink('https://romzo.net', 'ABCD123XYZ', 'https://game.example/')).hash))
    .toEqual({ origin: 'https://romzo.net', code: 'ABCD123XYZ' });
});
test('loopback HTTP is explicit, and production cannot opt in to remote HTTP', () => {
  const options = { allowLoopbackHttp: true };
  const url = buildInviteLink('http://127.0.0.1:8080', 'ABCD123XYZ', 'http://localhost:5190', options);
  expect(parseInviteHash(new URL(url).hash, options)?.origin).toBe('http://127.0.0.1:8080');
  expect(parseInviteHash(new URL(url).hash)?.origin).toBe('https://127.0.0.1:8080');
  expect(parseInviteHash('#ABCD123XYZ@localhost', options)?.origin).toBe('http://localhost:9224');
  expect(parseInviteHash('#ABCD123XYZ@localhost')?.origin).toBe('https://localhost:9224');
  expect(() => buildInviteLink('http://romzo.net', 'ABCD123XYZ', 'http://localhost', options)).toThrow();
  expect(() => buildInviteLink('http://localhost', 'ABCD123XYZ', 'https://game.example', options)).toThrow();
  for (const origin of ['http://localhost:443', 'http://[::1]:8080']) {
    const link = buildInviteLink(origin, 'ABCD123XYZ', 'http://localhost:5190', options);
    expect(parseInviteHash(new URL(link).hash, options)?.origin).toBe(origin);
  }
});
test('malformed and credential-bearing fragments fail closed', () => {
  for (const hash of ['#ABCD123XYI@romzo.net', '#ABCD123XYZ@user:pass@romzo.net', '#ABCD123XYZ@romzo.net/path', '#ABCD123XYZ@romzo.net?key=secret', '#ABCD123XYZ@romzo.net:0', '#ABCD123XYZ@romzo.net:65536', '#ABCD123XYZ@https://romzo.net', '#abcd123xyz@romzo.net', '#ABCD123XYZ@romzo.net#extra']) expect(parseInviteHash(hash)).toBeNull();
});
