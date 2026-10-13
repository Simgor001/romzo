// Runs inside the isolated Docker network namespace; contains no Docker socket.
import { writeFile } from 'node:fs/promises';
import WebSocket from 'ws';
import { createRoom, joinRoom, MeshSession, RelaySession } from './sdk/index.js';

const origin = 'http://127.0.0.1:9224', ws = 'ws://127.0.0.1:9224/ws';
const clientOrigin = 'https://load.example';
const http = { fetch: (url, init) => fetch(url, { ...init, headers: { ...init?.headers, Origin: clientOrigin } }) };
const clients = [], phases = [], checks = [], snapshots = [];
const smoke = process.env.ROMZO_LOAD_SMOKE === '1';
const pause = ms => new Promise(r => setTimeout(r, ms));
const milestone = (event, detail = {}) => console.log(JSON.stringify({ event, ...detail }));
let active, monitor, healthFailures = 0;
async function metrics() {
  const r = await fetch(origin + '/api/v1/metrics', { headers: { Origin: clientOrigin, Authorization: 'Bearer ' + process.env.METRICS_KEY }, signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw Error('metrics HTTP ' + r.status);
  const m = await r.json();
  // Reports retain counters only, never room history / public keys / tickets.
  return Object.fromEntries(['rooms', 'connections', 'unauthenticated', 'queueBytes', 'receivedFrames', 'receivedBytes', 'sentFrames', 'sentBytes', 'queueRejected', 'closedReasons'].map(k => [k, m[k]]));
}
async function until(predicate, ms = 15000) {
  const end = performance.now() + ms;
  while (performance.now() < end) { if (await predicate()) return; await pause(50); }
  throw Error('condition timed out');
}
async function connect(material, room, reconnect = true) {
  const c = { index: clients.length, room, socket: null, intentional: false, closes: 0 };
  c.mesh = await MeshSession.connect(ws, material.admission, material.transport, {
    // First sender deliberately has no heartbeat: valid traffic must keep it alive.
    keepalive: clients.length !== 0,
    webSocketFactory: url => (c.socket = new WebSocket(url, { headers: { Origin: clientOrigin } })),
    ...(reconnect ? { autoReconnect: { signedDescriptor: material.signedDescriptor, baseDelayMs: 100, maxDelayMs: 500 } } : {}),
  }, { signedDescriptor: material.signedDescriptor });
  c.mesh.on('reconnecting', () => { if (!c.intentional && active) active.disconnects++; });
  c.mesh.on('close', () => { c.closes++; if (!c.intentional && active) active.disconnects++; });
  c.mesh.on('receive', (v, meta) => {
    const a = active;
    if (!a || v?.phase !== a.name || a.excluded.has(c.index)) return;
    const sender = clients[v.sender];
    if (!sender || sender.room !== c.room || sender === c || meta.peer !== sender.mesh.id || meta.key !== sender.mesh.key || meta.joinSeq !== sender.mesh.joinSeq || v.body !== a.body) a.invalid++;
    const last = a.last.get(c.index + ':' + v.sender) ?? -1;
    if (v.sequence <= last) a.duplicates++;
    else { if (v.sequence !== last + 1) a.gaps++; a.last.set(c.index + ':' + v.sender, v.sequence); }
    a.received++; a.latencies.push(performance.now() - v.sentAt);
  });
  await c.mesh.subscribe('data'); await c.mesh.keepalive();
  clients.push(c); return c;
}
async function addRooms(n) {
  for (let room = clients.length / 8; room < n; room++) {
    const host = await createRoom(origin, { identityPolicy: {exclusive:true,ttlMs:1800000}, channels: [{ name: 'data', maxFrameBytes: 65536 }, { name: 'signal', maxFrameBytes: 16384 }] }, http);
    await connect(host, room); await pause(150);
    for (let i = 1; i < 8; i++) { await connect(await joinRoom(origin, host.descriptor.code, http), room, smoke || room !== 0 || i !== 7); await pause(150); }
  }
  await until(() => clients.filter(c => !c.intentional).every(c => c.mesh.members('data').length === 8));
}
function percentile(values, p) { if (!values.length) return 0; values.sort((a,b) => a-b); return +values[Math.min(values.length - 1, Math.floor(values.length * p))].toFixed(3); }
async function traffic(name, senders, fps, duration, bodyBytes, { excluded = [], rawRelay = false } = {}) {
  const before = await metrics();
  const a = active = { name, body: 'x'.repeat(bodyBytes), excluded: new Set(excluded), last: new Map(), latencies: [], received: 0, expected: 0, acknowledged: 0, failures: 0, duplicates: 0, gaps: 0, invalid: 0, disconnects: 0, ackLatencies: [] };
  milestone('phase-start', { name, clients: clients.filter(c => !c.intentional).length, senders: senders.length, fps, duration, bodyBytes });
  const start = performance.now(), end = start + duration * 1000;
  await Promise.all(senders.map(async c => {
    let sequence = 0, next = start + c.index % 8 * 2;
    while (performance.now() < end) {
      await pause(Math.max(0, next - performance.now()));
      if (performance.now() >= end) break;
      const sentAt = performance.now();
      try {
        await (rawRelay ? c.mesh.relay : c.mesh).send('data', { phase: name, sender: c.index, sequence, sentAt, body: a.body });
        a.acknowledged++; a.ackLatencies.push(performance.now() - sentAt);
        a.expected += clients.filter(r => !r.intentional && r.room === c.room && r !== c && !a.excluded.has(r.index)).length;
      } catch { a.failures++; }
      sequence++; next += 1000 / fps;
      // Catching up by a burst would test a different, higher rate than requested.
      if (next < performance.now() - 1000 / fps) next = performance.now();
    }
  }));
  const seconds = (performance.now() - start) / 1000;
  await pause(1500);
  const after = await metrics(); active = undefined;
  const result = { name, connections: before.connections, senders: senders.length, requestedFpsPerSender: fps, bodyBytes, seconds: +seconds.toFixed(2), acknowledged: a.acknowledged, expectedDeliveries: a.expected, received: a.received, missing: Math.max(0, a.expected - a.received), extra: Math.max(0, a.received - a.expected), sendFailures: a.failures, duplicates: a.duplicates, gaps: a.gaps, invalidMetadataOrPayload: a.invalid, unexpectedDisconnects: a.disconnects,
    sendsPerSecond: +(a.acknowledged / seconds).toFixed(1), deliveriesPerSecond: +(a.received / seconds).toFixed(1), ackP95Ms: percentile(a.ackLatencies,.95), receiveP50Ms: percentile(a.latencies,.5), receiveP95Ms: percentile(a.latencies,.95), receiveP99Ms: percentile(a.latencies,.99), metricsBefore: before, metricsAfter: after };
  result.pass = !result.missing && !result.extra && !a.failures && !a.duplicates && !a.gaps && !a.invalid && !a.disconnects && a.acknowledged > 0;
  phases.push(result); milestone('phase-complete', result);
  return result;
}
const report = { startedAt: new Date().toISOString(), scope: 'container-local relay + SDK mesh fallback; no browser RTC, TLS or public network', phases, checks, metricSnapshots: snapshots };
try {
  await until(async () => (await fetch(origin + '/readyz').catch(() => null))?.ok);
  const discovery = await (await fetch(origin + '/.well-known/romzo', { headers: { Origin: clientOrigin } })).json();
  if (discovery.version !== '1.5.0' || !discovery.stableMemberOrder) throw Error('current relay with durable numbering required');
  report.serverVersion = discovery.version;
  monitor = setInterval(async () => {
    try { const m = await metrics(); snapshots.push({ time: Date.now(), ...m }); }
    catch { if (!report.restarting) healthFailures++; }
  }, 1000);
  await addRooms(1); await traffic('warmup-8', clients, 10, smoke ? 1 : 10, 512);
  if (!smoke) {
  await addRooms(4); await traffic('sustained-32', clients, 10, 20, 512);
  await addRooms(8); await traffic('sustained-64', clients, 10, 60, 512);
  await traffic('near-frame-limit-64', clients, 45, 30, 128, { rawRelay: true });
  for (const c of clients.slice(8)) { c.intentional = true; c.mesh.close(); }
  await pause(500);
  const slow = clients[7]; slow.intentional = true; slow.socket._socket.pause();
  const beforeSlow = await metrics();
  await traffic('slow-consumer-healthy-peers', [clients[0]], 20, 12, 32768, { excluded: [7], rawRelay: true });
  slow.socket._socket.resume(); await pause(500);
  const afterSlow = await metrics();
  checks.push({ name: 'slow-consumer-isolation', pass: afterSlow.connections === 7 && afterSlow.queueRejected > beforeSlow.queueRejected, before: beforeSlow, after: afterSlow });
  slow.mesh.close();
  // Deliberately exceed the default 64 frames/s, keeping the payload tiny.
  const material = await joinRoom(origin, clients[0].mesh.roomBinding.code, http);
  const attacker = await connect(material, 0, false); attacker.intentional = true;
  const beforeRate = await metrics();
  for (let i = 0; i < 500 && attacker.socket.readyState === WebSocket.OPEN; i++) {
    attacker.socket.send(JSON.stringify({ v: 'romzo/v1', kind: 'send', id: 'overload-' + i, channel: 'data', target: clients[1].mesh.id, value: { overload: i } })); await pause(2);
  }
  await pause(1000); const afterRate = await metrics(); attacker.mesh.close();
  checks.push({ name: 'frame-rate-enforcement', pass: (afterRate.closedReasons.frame_or_byte_rate ?? 0) > (beforeRate.closedReasons.frame_or_byte_rate ?? 0), before: beforeRate, after: afterRate });
  }
  const remaining = clients.filter(c => !c.intentional), numbers = remaining.map(c => c.mesh.joinSeq), ids = remaining.map(c => c.mesh.id);
  for (const c of remaining) await c.mesh.keepalive();
  report.restarting = true; milestone('restart-request');
  await until(() => remaining.every((c,i) => c.mesh.id !== ids[i] && c.mesh.isSubscribed('data') && c.mesh.members('data').length === remaining.length), 30000);
  report.restarting = false;
  checks.push({ name: 'container-restart-recovery', pass: remaining.every((c,i) => c.mesh.joinSeq === numbers[i]), recoveredClients: remaining.length, memberNumbers: remaining.map(c => c.mesh.joinSeq) });
  await traffic('post-restart', remaining, 10, smoke ? 1 : 10, 512);
  const isolated = await createRoom(origin, {identityPolicy:{exclusive:true,ttlMs:20000}}, http);
  const socketOptions = {keepalive:false,webSocketFactory:url=>new WebSocket(url,{headers:{Origin:clientOrigin}})};
  const owner = await RelaySession.connect(ws,isolated.admission,isolated.transport,socketOptions);
  let occupied=false,full=false;
  try {await RelaySession.connect(ws,isolated.admission,isolated.transport,socketOptions);} catch(e) {occupied=e.code==='identity_in_use';}
  const count=(await fetch(origin+'/.well-known/romzo').then(r=>r.json())).maxRoomConnections*2;
  for(let i=1;i<count;i++) {const guest=await joinRoom(origin,isolated.descriptor.code,http);const peer=await RelaySession.connect(ws,guest.admission,guest.transport,socketOptions);peer.close();await pause(150);}
  const extra=await joinRoom(origin,isolated.descriptor.code,http);
  try {await RelaySession.connect(ws,extra.admission,extra.transport,socketOptions);} catch(e) {full=e.code==='member_capacity';}
  await pause(20500);
  const reclaimed=await RelaySession.connect(ws,extra.admission,extra.transport,socketOptions);
  checks.push({name:'identity-occupancy-capacity-expiry',pass:occupied&&full&&reclaimed.joinSeq>count&&owner.joinSeq===1,capacity:count,reclaimedNumber:reclaimed.joinSeq});
  reclaimed.close();owner.close();
  report.healthFailures = healthFailures;
  report.pass = phases.every(p => p.pass) && checks.every(c => c.pass) && !healthFailures;
} catch (e) { report.pass = false; report.error = e.stack; milestone('worker-failure', { error: e.message }); }
finally {
  clearInterval(monitor); active = undefined;
  for (const c of clients) { c.intentional = true; c.mesh.close(); }
  await pause(1000);
  report.finalMetrics = await metrics().catch(() => null);
  report.finishedAt = new Date().toISOString();
  await writeFile('/report/worker.json', JSON.stringify(report,null,2));
}
milestone('finished', { pass: report.pass });
process.exit(report.pass ? 0 : 1);
