import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { chromium, webkit, devices, expect } from '@playwright/test';
import { _android } from 'playwright';

test('mobile playground: real relay creation, manual/link joining and bidirectional messages', { timeout: 180000 }, async () => {
  const output = mkdtempSync(join(tmpdir(), 'romzo-mobile-'));
  const binary = join(output, process.platform === 'win32' ? 'relay.exe' : 'relay');
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(r => probe.close(r));
  const relayOrigin = `http://127.0.0.1:${port}`;
  const root = new URL('../../website/', import.meta.url);
  const site = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (!/^\/[a-zA-Z0-9/_.-]+$/.test(pathname) || pathname.includes('..')) { res.writeHead(400).end(); return; }
    try {
      let body = readFileSync(new URL('.' + pathname, root));
      // Test-only origin substitution; the deployed page always targets romzo.net.
      if (pathname === '/play.html') body = body.toString().replace("const ORIGIN = 'https://romzo.net';", `const ORIGIN = '${relayOrigin}';`).replaceAll('} catch (e) {', '} catch (e) { console.error(e.name, e.message);');
      res.setHeader('Content-Type', pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : pathname.endsWith('.svg') ? 'image/svg+xml' : 'text/html');
      res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  let relay, browser, android;
  const androidSerial = process.env.ROMZO_ANDROID_SERIAL;
  const forwardedPorts = [];
  function dismissChromeNotice() {
    if (!android) return;
    execFileSync('adb', ['-s', androidSerial, 'shell', 'uiautomator', 'dump', '/sdcard/window.xml'], { windowsHide: true });
    const ui = execFileSync('adb', ['-s', androidSerial, 'shell', 'cat', '/sdcard/window.xml'], { encoding: 'utf8', windowsHide: true });
    const button = /<node\b[^>]*text="No thanks"[^>]*resource-id="com\.android\.chrome:id\/negative_button"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(ui);
    if (button) execFileSync('adb', ['-s', androidSerial, 'shell', 'input', 'tap', String(Math.floor((+button[1] + +button[3]) / 2)), String(Math.floor((+button[2] + +button[4]) / 2))], { windowsHide: true });
  }
  try {
    execFileSync('go', ['build', '-trimpath', '-o', binary, '.'], { cwd: new URL('../../relay/', import.meta.url), windowsHide: true });
    relay = spawn(binary, [], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      LISTEN: `127.0.0.1:${port}`, PUBLIC_ORIGIN: relayOrigin, CREATE_AUTH: 'anonymous',
      AUTH_SALT: randomBytes(32).toString('hex'), TICKET_KEY: randomBytes(32).toString('hex'), CLIENT_ORIGINS: '*',
      MEMBER_STATE_FILE: join(output, 'members.json'),
    } });
    relay.stderr.on('data', chunk => console.log(chunk.toString().trim()));
    for (let n = 0; ; n++) {
      if (await fetch(relayOrigin + '/healthz').then(r => r.ok).catch(() => false)) break;
      if (n === 100 || relay.exitCode !== null) throw Error('relay failed to start');
      await new Promise(r => setTimeout(r, 50));
    }
    site.listen(0, '127.0.0.1'); await once(site, 'listening');
    const app = `http://127.0.0.1:${site.address().port}/play.html`;
    let targets = [[chromium, 'Pixel 7'], [webkit, 'iPhone 13']];
    if (androidSerial) {
      android = (await _android.devices()).find(device => device.serial() === androidSerial);
      if (!android) throw Error('Requested Android device is not connected');
      for (const localPort of [port, site.address().port]) {
        execFileSync('adb', ['-s', androidSerial, 'reverse', `tcp:${localPort}`, `tcp:${localPort}`], { windowsHide: true });
        forwardedPorts.push(localPort);
      }
      targets = [[{
        name: () => 'android',
        launch: async () => ({ newContext: async () => android.launchBrowser({ pkg: 'com.android.chrome', hasTouch: true, viewport: null }), close: async () => {} }),
      }, 'Android device']];
    }
    for (const [engine, device] of targets) {
      // Override OS proxies: WebKit on Windows otherwise proxies loopback WS.
      browser = await engine.launch({ proxy: { server: 'http://127.0.0.1:9', bypass: '127.0.0.1,localhost' } });
      for (const fallback of [false, true]) {
        const context = await browser.newContext(devices[device]);
        const errors = [];
        const requests = [];
        context.on('page', p => { p.on('pageerror', e => errors.push(e.message)); p.on('console', m => { if (m.type() === 'error') requests.push(m.text()); }); });
        context.on('response', r => requests.push(`${r.status()} ${r.url()}`));
        context.on('requestfailed', r => requests.push(`FAILED ${r.url()}: ${r.failure()?.errorText}`));
        // Network independence: the SDK must load with all remote requests blocked.
        await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
        await context.addInitScript(({ fallback }) => {
          // Only verification is stubbed. All room HTTP requests and WebSockets use the Go relay.
          window.turnstile = { render: (_box, options) => { window.testVerification = options.callback; return 1; }, execute: () => window.testVerification('test-verification'), remove: () => {} };
          if (fallback && crypto.subtle) for (const method of ['generateKey', 'importKey']) {
            const original = crypto.subtle[method].bind(crypto.subtle);
            crypto.subtle[method] = (...args) => {
              const algorithm = args[method === 'generateKey' ? 0 : 2];
              if ((typeof algorithm === 'string' ? algorithm : algorithm.name) === 'Ed25519') return Promise.reject(new DOMException('Unsupported', 'NotSupportedError'));
              return original(...args);
            };
          }
        }, { fallback });
        try {
          const host = await context.newPage(); await host.goto(app);
          dismissChromeNotice();
          if (android) console.log(JSON.stringify(await host.evaluate(() => ({ userAgent: navigator.userAgent, secure: isSecureContext }))));
          await host.locator('#create').tap();
          await expect(host.locator('#create-result')).toBeVisible({ timeout: 15000 });
          const code = await host.locator('#room-code').textContent();
          const invite = await host.locator('#invite-link').textContent();
          assert.ok(invite.includes('#' + code + '/127.0.0.1:'));
          assert.ok(!invite.includes('@'));
          const guest = await context.newPage(); await guest.goto(app);
          await guest.locator('#mode-join').tap(); await guest.locator('#join-code').fill(code);
          await guest.locator('#join').tap(); await expect(guest.locator('#create-result')).toBeVisible({ timeout: 15000 });
          const viaLink = await context.newPage(); await viaLink.goto(invite);
          await expect(viaLink.locator('#create-result')).toBeVisible({ timeout: 15000 });
          const legacy = await context.newPage(); await legacy.goto(invite.replace('#' + code + '/', '#' + code + '@'));
          await expect(legacy.locator('#create-result')).toBeVisible({ timeout: 15000 });
          // Pasted full link also exercises application input parsing.
          const pasted = await context.newPage(); await pasted.goto(app);
          await pasted.locator('#mode-join').tap(); await pasted.locator('#join-code').fill(invite);
          await pasted.locator('#join').tap(); await expect(pasted.locator('#create-result')).toBeVisible({ timeout: 15000 });
          await host.locator('#message').fill('host to mobile'); await host.locator('#send').tap();
          await expect(guest.locator('.play-message-body').last()).toHaveText('host to mobile');
          await guest.locator('#message').fill('mobile to host'); await guest.locator('#send').tap();
          await expect(host.locator('.play-message-body').last()).toHaveText('mobile to host');
          assert.deepEqual(errors, [], `${device}, fallback=${fallback}`);
          assert.equal(await host.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile horizontal overflow');
          await host.evaluate(() => scrollTo(0, 0));
          const screenshot = resolve('test-results', `mobile-${engine.name()}-${fallback ? 'fallback' : 'native'}.png`);
          if (android) { await host.bringToFront(); dismissChromeNotice(); writeFileSync(screenshot, await android.screenshot()); }
          else await host.screenshot({ path: screenshot, fullPage: true });
          console.log(`${device}: ${fallback ? 'forced Ed25519 fallback' : 'automatic backend'} create/manual/link/legacy/paste/chat passed`);
        } catch (error) { console.log({device, fallback, errors, requests}); throw error; }
        finally { await context.close(); }
      }
      await browser.close(); browser = undefined;
    }
  } finally {
    await browser?.close();
    for (const localPort of forwardedPorts) execFileSync('adb', ['-s', androidSerial, 'reverse', '--remove', `tcp:${localPort}`], { windowsHide: true });
    await android?.close();
    if (site.listening) await new Promise(r => site.close(r));
    if (relay && relay.exitCode === null) { const done = once(relay, 'exit'); relay.kill(); await done; }
    if (dirname(resolve(output)) !== resolve(tmpdir())) throw Error('unexpected cleanup path');
    rmSync(output, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
