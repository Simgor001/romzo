import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { createRoom, joinRoom, restoreSession, RelaySession, buildInviteLink, parseInviteHash } from 'romzo';

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
for (const publicMode of [false, true])
test(`real local HTTP/WS (${publicMode ? 'public origins' : 'private origins'}): two SDK peers, renewal and restart recovery`, {timeout: 45000}, async () => {
  const directory = new URL('../../relay/', import.meta.url);
  const output = mkdtempSync(join(tmpdir(), 'romzo-integration-'));
  const binary = join(output, process.platform === 'win32' ? 'relay.exe' : 'relay');
  const origin = `http://127.0.0.1:${await freePort()}`, clientOrigin = 'https://client.example.com';
  // Ephemeral secrets stay in memory and are never emitted or committed.
  const password = randomBytes(24).toString('hex');
  const env = {PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, LISTEN: new URL(origin).host, PUBLIC_ORIGIN: origin,
    CREATE_AUTH: 'password', CREATE_PASSWORD: password, AUTH_SALT: randomBytes(32).toString('hex'),
    TICKET_KEY: randomBytes(32).toString('hex'), CLIENT_ORIGINS: publicMode ? '*' : clientOrigin, ADMIN_ORIGINS: clientOrigin,
    METRICS_KEY: randomBytes(32).toString('hex'), METRICS_HISTORY_FILE: join(output, 'history.json'),
    RECORD_CREATOR_IP: 'true', MAX_ROOM_TRAFFIC_BYTES: '1073741824', MAX_ROOM_AGE_SECONDS: '21600'};
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
  const webOrigin = publicMode ? 'https://unregistered-game.example' : clientOrigin;
  const httpOptions = {fetch: (url, init) => fetch(url, {...init, headers: {...init?.headers, Origin: webOrigin}})};
  const socketOptions = {webSocketFactory: url => new WebSocket(url, {headers: {Origin: webOrigin}})};
  const wsUrl = origin.replace(/^http/, 'ws') + '/ws';
  try {
    execFileSync('go', ['build', '-trimpath', '-o', binary, '.'], {cwd: directory, stdio: 'pipe', windowsHide: true});
    await start();
    const discoveryResponse = await httpOptions.fetch(origin + "/.well-known/romzo");
    assert.equal(discoveryResponse.status, 200);
    assert.equal((await discoveryResponse.json()).protocol, "romzo/v1");
    assert.equal(discoveryResponse.headers.get('access-control-allow-origin'), webOrigin);
    if (publicMode) {
      const denied = await fetch(origin+'/api/v1/metrics', {headers: {Origin: webOrigin, Authorization: 'Bearer '+env.METRICS_KEY}});
      assert.equal(denied.status, 403);
      const unauthenticated = await fetch(origin+'/api/v1/metrics', {headers: {Origin: clientOrigin}});
      assert.equal(unauthenticated.status, 401);
      const preflight = await fetch(origin+'/api/v1/rooms', {method: 'OPTIONS', headers: {Origin: webOrigin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type'}});
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get('access-control-allow-origin'), webOrigin);
      await assert.rejects(createRoom(origin, {app: 'generic-example'}, httpOptions));
      await assert.rejects(
        createRoom(origin, {app: 'generic-example'}, {...httpOptions, password: randomBytes(24).toString('hex')}),
        error => error.code === 'authorization_failed',
      );
    }
    const options = {app: 'generic-example', channels: [{name: 'table', maxFrameBytes: 262144}], players: 2, rules: ['draft', {dice: 6}], expansion: null};
    const room = await createRoom(origin, options, {...httpOptions, password});
    assert.equal(room.discovery.version, '1.5.0');
    const invite = buildInviteLink(origin, room.descriptor.code, 'http://localhost:5190/', {allowLoopbackHttp: true});
    assert.equal(parseInviteHash(new URL(invite).hash, {allowLoopbackHttp: true}).origin, origin);
    const guest = await joinRoom(origin, room.descriptor.code, {...httpOptions, validateOptions: value => assert.deepEqual(value, options)});
    const hostSession = await RelaySession.connect(wsUrl, room.admission, room.transport, socketOptions); sessions.push(hostSession);
    const guestSession = await RelaySession.connect(wsUrl, guest.admission, guest.transport, socketOptions); sessions.push(guestSession);
    await hostSession.subscribe('table'); await guestSession.subscribe('table');
    const forward = receive(guestSession); await hostSession.send('table', {operation: 'move', sequence: 1});
    assert.deepEqual((await forward).value, {operation: 'move', sequence: 1});
    const backward = receive(hostSession); await guestSession.send('table', {operation: 'ack', sequence: 1});
    assert.deepEqual((await backward).value, {operation: 'ack', sequence: 1});
    await hostSession.keepalive(); const recovery = hostSession.currentRecovery(); assert.ok(recovery);
    const metrics = async () => {
      const response = await fetch(origin+'/api/v1/metrics', {headers: {Authorization: 'Bearer '+env.METRICS_KEY}});
      assert.equal(response.status, 200); return response.json();
    };
    const beforeRestart = await metrics();
    assert.equal(beforeRestart.roomHistory.trafficTop.length, 1);
    assert.equal(beforeRestart.roomHistory.onlineTop[0].connections, 2);
    assert.ok(beforeRestart.roomHistory.trafficTop[0].sentBytes > 0);
    assert.ok(JSON.stringify(beforeRestart).includes(room.descriptor.code));
    for(let attempt=0;attempt<240 && !existsSync(env.METRICS_HISTORY_FILE);attempt++) await pause(50);
    assert.ok(existsSync(env.METRICS_HISTORY_FILE), 'periodic history checkpoint missing');
    const saved = JSON.parse(readFileSync(env.METRICS_HISTORY_FILE, 'utf8'));
    assert.equal(saved[0].id,beforeRestart.roomHistory.trafficTop[0].id);
    for (const session of sessions) session.close(); sessions.length = 0;
    await stop(child); await start();
    const afterReload = await metrics();
    assert.equal(afterReload.roomHistory.trafficTop[0].id,beforeRestart.roomHistory.trafficTop[0].id);
    assert.ok(afterReload.roomHistory.trafficTop[0].sentBytes>0);
    const restored = await restoreSession(room.signedDescriptor, recovery, room.transport, httpOptions);
    const restoredHost = await RelaySession.connect(wsUrl, restored.admission, restored.transport, socketOptions); sessions.push(restoredHost);
    const rejoined = await joinRoom(origin, room.descriptor.code, httpOptions);
    const restoredGuest = await RelaySession.connect(wsUrl, rejoined.admission, rejoined.transport, socketOptions); sessions.push(restoredGuest);
    await restoredHost.subscribe('table'); await restoredGuest.subscribe('table');
    const afterRestart = receive(restoredGuest); await restoredHost.send('table', {operation: 'resync', sequence: 2});
    assert.deepEqual((await afterRestart).value, {operation: 'resync', sequence: 2});
    assert.equal(restored.signedDescriptor.descriptor.instance, room.descriptor.instance);
    const record=(await metrics()).roomHistory.trafficTop[0];
    assert.equal(record.code,room.descriptor.code);
    assert.equal(record.creatorIP,'127.0.0.1');
    const shutdown=await fetch(origin+'/api/v1/admin/rooms/stop',{method:'POST',headers:{Authorization:'Bearer '+env.METRICS_KEY,'Content-Type':'application/json'},body:JSON.stringify({id:record.id})});
    assert.equal(shutdown.status,200);
    for(let attempt=0;attempt<50 && (await metrics()).connections;attempt++)await pause(50);
    assert.equal((await metrics()).connections,0);
    await stop(child);await start();
    assert.equal((await metrics()).roomHistory.trafficTop[0].stopReason,'admin_stopped');
    await assert.rejects(restoreSession(room.signedDescriptor,recovery,room.transport));
  } finally {
    try {
      for (const session of sessions) session.close(); await stop(child);
    } finally {
      if(dirname(resolve(output))!==resolve(tmpdir()))throw Error('unexpected integration cleanup path');
      rmSync(output,{recursive:true,force:true,maxRetries:3,retryDelay:100});
    }
  }
});
