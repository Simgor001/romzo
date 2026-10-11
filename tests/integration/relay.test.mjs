import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { createRoom, joinRoom, restoreSession, RelaySession, buildInviteLink, parseInviteHash } from '@romzo/client';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); return port;
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const done = once(child, 'exit'); child.kill('SIGTERM'); await done;
}
function receive(session) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { unsubscribe(); reject(Error('local message delivery timed out')); }, 5000);
    const unsubscribe = session.on('receive', (value, meta) => { clearTimeout(timeout); unsubscribe(); resolve({value, meta}); });
  });
}
test('real local HTTP/WS: generic room, two SDK peers, renewal and restart recovery', {timeout: 45000}, async () => {
  const directory = new URL('../../apps/relay/', import.meta.url);
  const output = mkdtempSync(join(tmpdir(), 'romzo-integration-'));
  const binary = join(output, process.platform === 'win32' ? 'relay.exe' : 'relay');
  const origin = `http://127.0.0.1:${await freePort()}`, clientOrigin = 'https://client.example.com';
  // Ephemeral secrets stay in memory and are never emitted or committed.
  const password = randomBytes(24).toString('hex');
  const env = {PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, LISTEN: new URL(origin).host, PUBLIC_ORIGIN: origin,
    CREATE_AUTH: 'password', CREATE_PASSWORD: password, AUTH_SALT: randomBytes(32).toString('hex'),
    TICKET_KEY: randomBytes(32).toString('hex'), CLIENT_ORIGINS: clientOrigin};
  let child; const sessions = [];
  async function start() {
    child = spawn(binary, [], {env, stdio: 'ignore', windowsHide: true});
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw Error('local relay exited before readiness');
      if (await fetch(origin+'/healthz').then(r => r.ok).catch(() => false)) return;
      await pause(50);
    }
    throw Error('local relay readiness timed out');
  }
  const socketOptions = {webSocketFactory: url => new WebSocket(url, {headers: {Origin: clientOrigin}})};
  const wsUrl = origin.replace(/^http/, 'ws') + '/ws';
  try {
    execFileSync('go', ['build', '-trimpath', '-o', binary, '.'], {cwd: directory, stdio: 'pipe', windowsHide: true});
    await start();
    const discoveryResponse = await fetch(origin + "/.well-known/romzo");
    assert.equal(discoveryResponse.status, 200);
    assert.equal((await discoveryResponse.json()).protocol, "romzo/v1");
    const options = {game: 'generic-example', players: 2, rules: ['draft', {dice: 6}], expansion: null};
    const room = await createRoom(origin, options, {password});
    assert.equal(room.discovery.version, '1.2.0');
    const invite = buildInviteLink(origin, room.descriptor.code, 'http://localhost:5190/', {allowLoopbackHttp: true});
    assert.equal(parseInviteHash(new URL(invite).hash, {allowLoopbackHttp: true}).origin, origin);
    const guest = await joinRoom(origin, room.descriptor.code, {validateOptions: value => assert.deepEqual(value, options)});
    const hostSession = await RelaySession.connect(wsUrl, room.admission, room.transport, socketOptions); sessions.push(hostSession);
    const guestSession = await RelaySession.connect(wsUrl, guest.admission, guest.transport, socketOptions); sessions.push(guestSession);
    await hostSession.subscribe('game'); await guestSession.subscribe('game');
    const forward = receive(guestSession); await hostSession.send('game', {operation: 'move', sequence: 1});
    assert.deepEqual((await forward).value, {operation: 'move', sequence: 1});
    const backward = receive(hostSession); await guestSession.send('game', {operation: 'ack', sequence: 1});
    assert.deepEqual((await backward).value, {operation: 'ack', sequence: 1});
    await hostSession.keepalive(); const recovery = hostSession.currentRecovery(); assert.ok(recovery);
    for (const session of sessions) session.close(); sessions.length = 0;
    await stop(child); await start();
    const restored = await restoreSession(room.signedDescriptor, recovery, room.transport);
    const restoredHost = await RelaySession.connect(wsUrl, restored.admission, restored.transport, socketOptions); sessions.push(restoredHost);
    const rejoined = await joinRoom(origin, room.descriptor.code);
    const restoredGuest = await RelaySession.connect(wsUrl, rejoined.admission, rejoined.transport, socketOptions); sessions.push(restoredGuest);
    await restoredHost.subscribe('game'); await restoredGuest.subscribe('game');
    const afterRestart = receive(restoredGuest); await restoredHost.send('game', {operation: 'resync', sequence: 2});
    assert.deepEqual((await afterRestart).value, {operation: 'resync', sequence: 2});
    assert.equal(restored.signedDescriptor.descriptor.instance, room.descriptor.instance);
  } finally {
    try {
      for (const session of sessions) session.close(); await stop(child);
    } finally {
      if(dirname(resolve(output))!==resolve(tmpdir()))throw Error('unexpected integration cleanup path');
      rmSync(output,{recursive:true,force:true,maxRetries:3,retryDelay:100});
    }
  }
});
