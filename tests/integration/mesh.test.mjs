import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const pause = ms => new Promise(r => setTimeout(r, ms));
test('mesh: real RTC, mixed routing, fallback, shared-key peers, reconnect, example', { timeout: 120000 }, async () => {
  const output = mkdtempSync(join(tmpdir(), 'romzo-mesh-'));
  const binary = join(output, process.platform === 'win32' ? 'relay.exe' : 'relay');
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('../../packages/romzo-client/src/index.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'browser', target: 'es2020', write: false });
  const sdk = bundle.outputFiles[0].contents;
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(r => probe.close(r));
  const origin = `http://127.0.0.1:${port}`, ws = origin.replace('http:', 'ws:') + '/ws';
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, LISTEN: `127.0.0.1:${port}`, PUBLIC_ORIGIN: origin,
    CREATE_AUTH: 'anonymous', AUTH_SALT: randomBytes(32).toString('hex'), TICKET_KEY: randomBytes(32).toString('hex'),
    CLIENT_ORIGINS: '*', MEMBER_STATE_FILE: join(output, 'members.json') };
  const site = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/sdk.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(sdk); return; }
    if (path === '/fixture.html') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Mesh integration</title>'); return; }
    if (!/^\/[a-zA-Z0-9/_.-]+$/.test(path) || path.includes('..')) { res.writeHead(400).end(); return; }
    try {
      let body = readFileSync(new URL('../../website' + path, import.meta.url));
      if (path === '/play.html') body = body.toString().replace("const ORIGIN = 'https://romzo.net';", `const ORIGIN = '${origin}';`);
      res.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : path.endsWith('.svg') ? 'image/svg+xml' : path.endsWith('.js') ? 'text/javascript' : 'text/html');
      res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  let relay, browser;
  async function start() {
    relay = spawn(binary, [], { env, stdio: 'ignore', windowsHide: true });
    for (let n = 0; n < 100; n++) {
      if (await fetch(origin + '/healthz').then(r => r.ok).catch(() => false)) return;
      if (relay.exitCode !== null) throw Error('relay exited'); await pause(50);
    }
    throw Error('relay readiness timeout');
  }
  async function kill() { if (!relay || relay.exitCode !== null) return; const done = once(relay, 'exit'); relay.kill('SIGKILL'); await done; }
  try {
    execFileSync('go', ['build', '-trimpath', '-o', binary, '.'], { cwd: new URL('../../relay/', import.meta.url), windowsHide: true });
    await start(); site.listen(0, '127.0.0.1'); await once(site, 'listening');
    const app = `http://127.0.0.1:${site.address().port}`;
    browser = await chromium.launch();
    const contexts = await Promise.all([0, 1, 2].map(() => browser.newContext()));
    // Every real PC is retained only in the test fixture so the test can sever DCs.
    for (const context of contexts) await context.addInitScript(() => {
      const NativePC = window.RTCPeerConnection;
      window.pcs = [];
      window.RTCPeerConnection = class extends NativePC {
        constructor(config) { super(config); window.pcs.push(this); }
      };
      const NativeWS = window.WebSocket;
      window.sockets = [];
      window.WebSocket = class extends NativeWS {
        constructor(...args) { super(...args); window.sockets.push(this); }
      };
    });
    const pages = await Promise.all(contexts.map(c => c.newPage()));
    const errors = []; for (const p of pages) p.on('pageerror', e => errors.push(e.message));
    for (const p of pages) await p.goto(app + '/fixture.html');
    const code = await pages[0].evaluate(async ({ origin, ws }) => {
      window.sdk = await import('/sdk.js');
      window.material = await sdk.createRoom(origin, { channels: [
        { name: 'chat', maxFrameBytes: 16384 }, { name: 'signal', maxFrameBytes: 16384 }, { name: 'state', maxFrameBytes: 262144 },
      ] });
      window.paths = []; window.received = []; window.transitions = [];
      window.session = await sdk.MeshSession.connect(ws, material.admission, material.transport,
        { autoReconnect: { signedDescriptor: material.signedDescriptor, baseDelayMs: 50, maxDelayMs: 100 } },
        { signedDescriptor: material.signedDescriptor, onPath: (peer, path) => paths.push({ peer, path }) });
      session.on('receive', (value, meta) => received.push({ value, meta }));
      session.on('reconnecting', () => transitions.push({ kind: 'reconnecting', paths: session.members('chat').map(m => session.path(m.peer)) }));
      session.on('reconnect', () => transitions.push({ kind: 'reconnect', id: session.id }));
      await session.subscribe('chat'); await session.subscribe('state'); await session.keepalive();
      return material.descriptor.code;
    }, { origin, ws });
    await pages[1].evaluate(async ({ origin, ws, code }) => {
      window.sdk = await import('/sdk.js'); window.material = await sdk.joinRoom(origin, code); window.received = []; window.paths = [];
      window.session = await sdk.MeshSession.connect(ws, material.admission, material.transport,
        { autoReconnect: { signedDescriptor: material.signedDescriptor, baseDelayMs: 50, maxDelayMs: 100 } },
        { signedDescriptor: material.signedDescriptor, onPath: (peer, path) => paths.push({ peer, path }) });
      session.on('receive', (value, meta) => received.push({ value, meta }));
      await session.subscribe('chat'); await session.subscribe('state'); await session.keepalive();
    }, { origin, ws, code });
    const ids = await Promise.all(pages.slice(0, 2).map(p => p.evaluate(() => session.id)));
    for (const [index, peer] of [[0, ids[1]], [1, ids[0]]])
      await expect.poll(() => pages[index].evaluate(peer => session.path(peer), peer), { timeout: 15000 }).toBe('rtc');
    await pages[0].evaluate(() => session.send('chat', { text: 'RTC A to B' }));
    await pages[1].evaluate(() => session.send('chat', { text: 'RTC B to A' }));
    await expect.poll(() => pages[1].evaluate(() => received.map(r => r.value.text))).toEqual(['RTC A to B']);
    await expect.poll(() => pages[0].evaluate(() => received.map(r => r.value.text))).toEqual(['RTC B to A']);
    assert.equal(await pages[1].evaluate(() => received[0].meta.key), await pages[0].evaluate(() => session.key));
    assert.equal(await pages[1].evaluate(() => received[0].meta.joinSeq), 1);
    assert.equal(await pages[0].evaluate(() => session.members('signal').length), 0);

    // Third peer announces mesh but its injected constructor fails: mixed fallback.
    await pages[2].evaluate(async ({ origin, ws, code }) => {
      window.sdk = await import('/sdk.js'); window.material = await sdk.joinRoom(origin, code); window.received = [];
      window.session = await sdk.MeshSession.connect(ws, material.admission, material.transport, { keepalive: false },
        { signedDescriptor: material.signedDescriptor, negotiationTimeoutMs: 300,
          rtcPeerConnectionFactory: () => { throw Error('injected negotiation failure'); } });
      session.on('receive', (value, meta) => received.push({ value, meta }));
      await session.subscribe('chat'); await session.subscribe('state'); await session.keepalive();
    }, { origin, ws, code });
    const third = await pages[2].evaluate(() => session.id);
    await expect.poll(() => pages[0].evaluate(id => session.path(id), third), { timeout: 10000 }).toBe('relay');
    await pages[0].evaluate(() => session.send('chat', { text: 'mixed broadcast' }));
    for (const p of pages.slice(1)) await expect.poll(() => p.evaluate(() => received.filter(r => r.value.text === 'mixed broadcast').length)).toBe(1);
    await pages[2].evaluate(() => session.send('chat', { text: 'fallback broadcast' }));
    for (const p of pages.slice(0, 2)) await expect.poll(() => p.evaluate(() => received.filter(r => r.value.text === 'fallback broadcast').length)).toBe(1);

    // Real DC close, immediate fallback, then at most one new negotiation.
    await pages[0].evaluate(() => pcs.forEach(pc => pc.close()));
    await expect.poll(() => pages[0].evaluate(peer => paths.some(p => p.peer === peer && p.path === 'relay'), ids[1])).toBe(true);
    await pages[0].evaluate(() => session.send('chat', { text: 'after RTC close' }));
    await expect.poll(() => pages[1].evaluate(() => received.filter(r => r.value.text === 'after RTC close').length)).toBe(1);
    await expect.poll(() => pages[0].evaluate(peer => session.path(peer), ids[1]), { timeout: 15000 }).toBe('rtc');

    // Server process loss makes roster empty and invalidates all old PCs/ids.
    await kill();
    await expect.poll(() => pages[0].evaluate(() => session.members('chat').length)).toBe(0);
    assert.equal(await pages[0].evaluate(peer => session.path(peer), ids[1]), null);
    await start();
    await expect.poll(() => pages[0].evaluate(() => transitions.filter(t => t.kind === 'reconnect').length), { timeout: 20000 }).toBe(1);
    for (const [index, oldId] of ids.entries())
      await expect.poll(() => pages[index].evaluate(oldId => session.id !== oldId && session.members('chat').some(m => m.peer === session.id), oldId), { timeout: 20000 }).toBe(true);
    const newIds = await Promise.all(pages.slice(0, 2).map(p => p.evaluate(() => session.id)));
    assert.notDeepEqual(newIds, ids);
    for (const [index, peer] of [[0, newIds[1]], [1, newIds[0]]])
      await expect.poll(() => pages[index].evaluate(peer => session.path(peer), peer), { timeout: 15000 }).toBe('rtc');
    await pages[0].evaluate(() => session.send('chat', { text: 'after relay reconnect' }));
    await expect.poll(() => pages[1].evaluate(() => received.filter(r => r.value.text === 'after relay reconnect').length)).toBe(1);
    assert.equal(await pages[0].evaluate(() => pcs.slice(0, 1).every(pc => pc.connectionState === 'closed')), true);

    // Two simultaneous authenticated connections with the same key, real WebRTC.
    const duplicateId = await pages[1].evaluate(async ({ origin, ws }) => {
      const admission = await sdk.requestAdmission(origin, material.signedDescriptor.descriptor.code, material.transport.publicKey);
      window.duplicate = await sdk.MeshSession.connect(ws, admission.admission, material.transport, { keepalive: false },
        { signedDescriptor: material.signedDescriptor });
      await duplicate.subscribe('chat'); return duplicate.id;
    }, { origin, ws });
    await expect.poll(() => pages[1].evaluate(peer => session.path(peer), duplicateId), { timeout: 15000 }).toBe('rtc');
    await pages[1].evaluate(() => duplicate.close());
    for (const context of contexts) await context.close();

    // The public playground is the sole browser demo: use its real DOM and SDK.
    const ui = await browser.newContext({ viewport: { width: 1360, height: 900 } }); const host = await ui.newPage(), guest = await ui.newPage();
    const qrRequests = []; ui.on('request', r => qrRequests.push(r.url()));
    await ui.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await ui.addInitScript(() => {
      localStorage.setItem('romzo-lang', 'en');
      window.turnstile = { render: (_box, options) => { window.meshVerification = options.callback; return 1; }, execute: () => window.meshVerification('local-mesh-fixture'), remove: () => {} };
    });
    for (const p of [host, guest]) { p.on('pageerror', e => errors.push(e.message)); await p.goto(app + '/play.html'); }
    assert.deepEqual(await host.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, accent: getComputedStyle(document.querySelector('#create')).backgroundColor })),
      { bg: 'rgb(250, 249, 246)', accent: 'rgb(189, 66, 28)' });
    await expect(host.locator('#message')).toBeDisabled();
    mkdirSync(resolve('test-results'), { recursive: true });
    await host.screenshot({ path: resolve('test-results/play-mesh-idle.png'), fullPage: true });
    await host.locator('#create').click(); await expect(host.locator('#create-result')).toBeVisible();
    const uiCode = await host.locator('#room-code').textContent();
    await ui.grantPermissions(['clipboard-read', 'clipboard-write']);
    await host.locator('#copy-invite').click(); await expect(host.locator('#room-feedback')).toContainText('Copied');
    assert.equal(await host.evaluate(() => navigator.clipboard.readText()), await host.locator('#invite-link').textContent());
    await expect(host.locator('#invite-qr')).toBeVisible();
    assert.equal(qrRequests.some(u => u.includes('/decode-')), false, 'decoder must not load for QR generation');
    const qrImage = await host.locator('#invite-qr').screenshot();
    const qrSource = await host.locator('#invite-qr').getAttribute('src');
    assert.deepEqual(await host.evaluate(async () => {
      const image = document.getElementById('invite-qr'); await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 368;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0, 368, 368);
      const qr = await import('/sdk/qr.js'); return qr.readInviteQr(ctx.getImageData(0, 0, 368, 368), { allowLoopbackHttp: true });
    }), { code: uiCode, origin });
    await guest.locator('#mode-join').click(); await expect(guest.locator('#mode-join')).toHaveAttribute('aria-pressed', 'true');
    await guest.locator('#join-code').fill(uiCode); await guest.locator('#join').click(); await expect(guest.locator('#create-result')).toBeVisible();
    await expect(host.locator('.play-path[data-path="rtc"]')).toHaveCount(1, { timeout: 15000 });
    await host.locator('#message').fill('playground mesh'); await host.locator('#message').press('Enter');
    await expect(guest.locator('#log')).toContainText('playground mesh');
    await expect(host.locator('#log .is-mine')).toContainText('playground mesh');
    await guest.locator('#message').fill('Thanks — connected over RTC.'); await guest.locator('#send').click();
    await expect(host.locator('#log')).toContainText('Thanks — connected over RTC.');
    await host.locator('.lang > button').click(); await host.locator('[data-set-lang="zh"]').click();
    await expect(host.locator('html')).toHaveAttribute('data-lang', 'zh');
    await expect(host.getByRole('heading', { name: '在线体验', exact: true })).toBeVisible();
    await expect(host.locator('#transport-paths')).toContainText('参与者');
    await expect(host.locator('#log .is-peer .play-message-meta')).toContainText('参与者 2');
    await host.screenshot({ path: resolve('test-results/play-mesh.png'), fullPage: true });
    for (const width of [768, 390, 320]) {
      await host.setViewportSize({ width, height: 844 });
      assert.deepEqual(await host.evaluate(() => {
        const room = document.querySelector('.play-room').getBoundingClientRect(), chat = document.querySelector('.play-chat').getBoundingClientRect();
        return { overflow: document.documentElement.scrollWidth > innerWidth, overlap: room.bottom > chat.top,
          controlsOutside: [...document.querySelectorAll('input,button,textarea')].filter(e => e.getClientRects().length).some(e => {
            const r = e.getBoundingClientRect(); return r.left < 0 || r.right > innerWidth + 1;
          }) };
      }), { overflow: false, overlap: false, controlsOutside: false });
      if (width === 390) await host.screenshot({ path: resolve('test-results/play-mesh-mobile.png'), fullPage: true });
    }
    await host.locator('#message').fill('mobile mesh'); await host.locator('#send').click();
    await expect(guest.locator('#log')).toContainText('mobile mesh');
    // The real play page also freezes controls and restores its RTC paths.
    await kill();
    await expect(host.locator('#message')).toBeDisabled(); await expect(host.locator('#transport-paths')).toBeHidden();
    await start();
    await expect(host.locator('#connection-badge')).toHaveAttribute('data-state', 'online', { timeout: 25000 });
    await expect(guest.locator('#connection-badge')).toHaveAttribute('data-state', 'online', { timeout: 25000 });
    await expect(host.locator('.play-path[data-path="rtc"]')).toHaveCount(1, { timeout: 15000 });
    await host.locator('#message').fill('play reconnected'); await host.locator('#send').click();
    await expect(guest.locator('#log')).toContainText('play reconnected');
    // A shared invite uses the same public playground admission flow.
    const invitePage = await ui.newPage(); await invitePage.goto(await host.locator('#invite-link').textContent());
    await expect(invitePage.locator('#create-result')).toBeVisible(); await expect(invitePage.locator('#room-code')).toHaveText(uiCode);
    await expect(host.locator('.play-path[data-path="rtc"]')).toHaveCount(2, { timeout: 15000 });
    await invitePage.locator('#message').fill('third participant'); await invitePage.locator('#send').click();
    await expect(host.locator('#log .is-peer').filter({ hasText: 'third participant' }).locator('.play-message-meta')).toContainText('参与者 3');
    // Rooms without the current mesh declaration must fail explicitly.
    const oldCode = await host.evaluate(async origin => {
      const sdk = await import('/sdk.js'); const room = await sdk.createRoom(origin, { identityPolicy:{exclusive:true,ttlMs:1800000}, channels: [{ name: 'lobby', maxFrameBytes: 16384 }] });
      return room.descriptor.code;
    }, origin);
    const oldGuest = await ui.newPage(); await oldGuest.goto(`${app}/play.html#${oldCode}/127.0.0.1:${port}`);
    await expect(oldGuest.locator('#create-result')).toBeHidden();
    await expect(oldGuest.locator('#message')).toBeDisabled();
    await expect(oldGuest.locator('#join-error')).toContainText('signal');
    // Image upload decodes locally and joins through the real admission API.
    const imageGuest = await ui.newPage(); imageGuest.on('pageerror', e => errors.push(e.message)); await imageGuest.goto(app + '/play.html');
    await imageGuest.locator('#mode-join').click();
    await imageGuest.locator('#scan-join').click();
    await imageGuest.locator('#scan-image').setInputFiles({ name: 'room.png', mimeType: 'image/png', buffer: qrImage });
    await expect(imageGuest.locator('#create-result')).toBeVisible(); await expect(imageGuest.locator('#room-code')).toHaveText(uiCode);
    await imageGuest.locator('#message').fill('joined via QR image'); await imageGuest.locator('#send').click();
    await expect(host.locator('#log')).toContainText('joined via QR image');
    // Controlled real video frames exercise the software camera decoder and cleanup.
    const cameraGuest = await ui.newPage(); cameraGuest.on('pageerror', e => errors.push(e.message)); await cameraGuest.goto(app + '/play.html');
    await cameraGuest.locator('#mode-join').click();
    await cameraGuest.evaluate(async src => {
      const image = new Image(); image.src = src; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 512, 512); ctx.drawImage(image, 0, 0, 512, 512);
      window.cameraFrames = canvas;
      window.BarcodeDetector = undefined;
      navigator.mediaDevices.getUserMedia = async () => {
        const stream = window.qrCameraStream = canvas.captureStream(5);
        const paint = setInterval(() => {
          if (stream.getTracks().every(t => t.readyState === 'ended')) { clearInterval(paint); return; }
          ctx.drawImage(image, 0, 0, 512, 512);
        }, 100);
        return stream;
      };
    }, qrSource);
    await cameraGuest.locator('#scan-join').click();
    await expect(cameraGuest.locator('#create-result')).toBeVisible({ timeout: 15000 });
    await expect(cameraGuest.locator('#room-code')).toHaveText(uiCode);
    assert.equal(await cameraGuest.evaluate(() => qrCameraStream.getTracks().every(t => t.readyState === 'ended') && document.getElementById('scan-video').srcObject === null), true);
    // Exit resets the room and keeps manual admission usable; denied camera has a file fallback.
    await cameraGuest.locator('#leave-room').click(); await expect(cameraGuest.locator('#create-result')).toBeHidden();
    await expect(cameraGuest.locator('#message')).toBeDisabled(); await cameraGuest.locator('#mode-join').click();
    await cameraGuest.evaluate(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('denied', 'NotAllowedError'); }; });
    await cameraGuest.locator('#scan-join').click(); await expect(cameraGuest.locator('#scan-status')).toContainText('permission');
    await cameraGuest.locator('#scan-close').click(); await expect(cameraGuest.locator('#scan-dialog')).toBeHidden();
    await cameraGuest.locator('#join-code').fill(uiCode); await cameraGuest.locator('#join').click();
    await expect(cameraGuest.locator('#create-result')).toBeVisible();
    // Enter and Shift+Enter follow normal chat conventions; empty send is disabled.
    await expect(cameraGuest.locator('#send')).toBeDisabled();
    await cameraGuest.locator('#message').fill('first line'); await cameraGuest.locator('#message').press('Shift+Enter');
    await cameraGuest.locator('#message').pressSequentially('second line');
    await expect(cameraGuest.locator('#message')).toHaveValue('first line\nsecond line');
    await cameraGuest.locator('#message').press('Enter'); await expect(host.locator('#log')).toContainText('second line');
    await expect(cameraGuest.locator('#send')).toBeDisabled();
    assert.deepEqual(errors, []); await ui.close();
    console.log('PASS: local RTC, mixed fallback, DC retry, relay recovery, same-key pair; public play UI with RTC paths, bilingual shared styling, desktop/mobile messages, invites and rejection of outdated rooms. Verification stub only; public NAT/TURN acceptance remains separate.');
  } finally {
    await browser?.close(); await kill(); await new Promise(r => site.close(r));
    if (dirname(resolve(output)) !== resolve(tmpdir())) throw Error('unexpected cleanup path');
    rmSync(output, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
