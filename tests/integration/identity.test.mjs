import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { chromium, expect } from '@playwright/test';

const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('persistent identity: real IndexedDB, tabs, expiry, restart and hosted verification', {timeout:120000},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'romzo-identities-'));
  const binary=join(dir,process.platform==='win32'?'relay.exe':'relay');
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
  const origin=`http://127.0.0.1:${port}`;
  const verify=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;assert.match(body,/test-token/);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({success:true,hostname:'127.0.0.1',action:'fixture-action'}));});
  verify.listen(0,'127.0.0.1');await once(verify,'listening');
  const site=createServer((req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname;
    if(path==='/fixture'){res.setHeader('Content-Type','text/html');res.end('<html><body>identity fixture</body></html>');return;}
    if(!/^\/[\w/.-]+$/.test(path)||path.includes('..')){res.writeHead(400).end();return;}
    try{let body=readFileSync(new URL('../../website'+path,import.meta.url));if(path==='/play.html')body=body.toString().replace("const ORIGIN = 'https://romzo.net';",`const ORIGIN = '${origin}';`);res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':path.endsWith('.svg')?'image/svg+xml':path.endsWith('.png')?'image/png':'text/html');res.end(body);}catch{res.writeHead(404).end();}
  });
  site.listen(0,'127.0.0.1');await once(site,'listening');const app=`http://127.0.0.1:${site.address().port}`;
  const env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,LISTEN:`127.0.0.1:${port}`,PUBLIC_ORIGIN:origin,CREATE_AUTH:'turnstile',AUTH_SALT:randomBytes(32).toString('hex'),TICKET_KEY:randomBytes(32).toString('hex'),GRANT_KEY:randomBytes(32).toString('hex'),TURNSTILE_SECRET:'fixture',TURNSTILE_SITEKEY:'fixture',TURNSTILE_ACTION:'fixture-action',TURNSTILE_HOSTNAMES:'127.0.0.1',TURNSTILE_VERIFY_URL:`http://127.0.0.1:${verify.address().port}`,CLIENT_ORIGINS:'*',MEMBER_STATE_FILE:join(dir,'members.json')};
  let relay,browser;
  async function start(){relay=spawn(binary,[],{env,windowsHide:true,stdio:['ignore','ignore','pipe']});relay.stderr.on('data',v=>console.log(v.toString()));for(let n=0;n<100;n++){if(await fetch(origin+'/readyz').then(r=>r.ok).catch(()=>false))return;if(relay.exitCode!==null)throw Error('relay exited');await pause(50);}throw Error('relay readiness timeout');}
  async function kill(){if(!relay||relay.exitCode!==null)return;const exit=once(relay,'exit');relay.kill();await exit;}
  try{
    execFileSync('go',['build','-o',binary,'.'],{cwd:new URL('../../relay/',import.meta.url),windowsHide:true});await start();
    browser=await chromium.launch();const context=await browser.newContext();const errors=[];
    context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
    await context.route('https://challenges.cloudflare.com/**',route=>route.fulfill({contentType:'text/javascript',body:"window.turnstile={render:(_,o)=>setTimeout(()=>o.callback('test-token'),5)};window.ready();"}));
    const host=await context.newPage();await host.goto(app+'/play.html');await host.locator('#create').click();
    await expect(host.locator('#create-result')).toBeVisible({timeout:15000});
    const code=await host.locator('#room-code').textContent();const invite=host.url();
    async function records(page){return page.evaluate(async()=>{const {openIdentityStore}=await import('/sdk/storage.js');const s=await openIdentityStore({namespace:'romzo-playground'});try{return(await s.list()).map(r=>({id:r.identityId,key:r.transport.publicKey,host:!!r.host,expiresAt:r.expiresAt}));}finally{s.close();}});}
    const initial=(await records(host))[0];assert.ok(initial.host);assert.ok(initial.expiresAt>Date.now());
    // New tab has no identity label: the server rejects the online host key, so it allocates another identity.
    const guest=await context.newPage();await guest.goto(invite);await expect(guest.locator('#create-result')).toBeVisible({timeout:15000});
    assert.equal((await records(host)).length,2);
    const guestKey=(await records(host)).find(r=>r.id!==initial.id).key;
    const guestLabel=await guest.evaluate(()=>Object.values(sessionStorage)[0]);assert.ok(guestLabel);
    await guest.reload();await expect(guest.locator('#create-result')).toBeVisible({timeout:15000});
    assert.equal((await records(host)).find(r=>r.id===guestLabel).key,guestKey);
    // Copied tab labels do not authorize stealing an active identity.
    const copied=await context.newPage();await copied.addInitScript(({origin,code,label})=>sessionStorage.setItem(JSON.stringify(['romzo-identity','romzo-playground',origin,code]),label),{origin,code,label:guestLabel});
    await copied.goto(invite);await expect(copied.locator('#join-error')).toContainText('identity',{timeout:18000});
    await copied.locator('#join-error button').click();await expect(copied.locator('#create-result')).toBeVisible();assert.equal((await records(host)).length,3);
    await copied.locator('#leave-room').click();await expect(copied.locator('#create-result')).toBeHidden();assert.equal((await records(host)).length,2);
    await copied.close();
    await guest.reload();await expect(guest.locator('#create-result')).toBeVisible({timeout:15000});
    // Restart exercises durable public identity state and SDK reconnect with saved private keys.
    await kill();await start();await expect(host.locator('#role-status-zh')).not.toContainText('正在重新连接',{timeout:15000});
    await host.locator('#message').fill('after restart');await host.locator('#send').click();await expect(guest.locator('.play-message-body').last()).toHaveText('after restart',{timeout:15000});
    await guest.close();await pause(300);const reopened=await context.newPage();const raced=await context.newPage();await Promise.all([reopened.goto(invite),raced.goto(invite)]);await expect(reopened.locator('#create-result')).toBeVisible({timeout:15000});await expect(raced.locator('#create-result')).toBeVisible({timeout:15000});
    const labels=await Promise.all([reopened,raced].map(p=>p.evaluate(()=>Object.values(sessionStorage)[0])));assert.equal(new Set(labels).size,2);assert.ok(labels.includes(guestLabel),'one racing tab should recover the offline identity');assert.equal((await records(reopened)).length,3);
    // Real IndexedDB cleanup removes expired records and selection pointers; no separate last-used field.
    const fixture=await context.newPage();await fixture.goto(app+'/fixture');
    const expiry=await fixture.evaluate(async()=>{
      const {openIdentityStore}=await import('/sdk/storage.js');const {createRoom,generateKeyPair,RelaySession}=await import('/sdk/romzo.js');
      const s=await openIdentityStore({namespace:'expiry',identityTtlMs:300});
      const key=await generateKeyPair();const probe={...((await(await openIdentityStore({namespace:'romzo-playground'})).list())[0])};
      const row=await s.save({...probe,transport:key,host:undefined,recovery:undefined,identityId:undefined,expiresAt:Date.now()+300});await s.select(row);
      const tracker=s.track(row);await tracker.remove();await tracker.onRecovery({ticket:{key:key.publicKey,instance:row.instance,origin:row.origin,code:row.code,purpose:'recovery'}});if((await s.list()).length)throw Error('deleted identity resurrected');
      const expired=await s.save({...probe,host:undefined,identityId:undefined,expiresAt:Date.now()-1});await s.cleanup();const remaining=await s.list();s.close();return remaining.length;
    });assert.equal(expiry,0);
    // Embedded UI cancellation and event-origin binding are tested without a Cloudflare response.
    await fixture.unroute('https://challenges.cloudflare.com/**').catch(()=>{});
    await fixture.route('https://challenges.cloudflare.com/**',route=>route.fulfill({contentType:'text/javascript',body:'window.turnstile={render:()=>1};window.ready();'}));
    const binding=await fixture.evaluate(async origin=>{
      const sdk=await import('/sdk/romzo.js');const d=await sdk.discover(origin);const key=await sdk.generateKeyPair();const controller=new AbortController();
      const pending=sdk.requestEmbeddedGrant(origin,d,key.publicKey,{signal:controller.signal});let settled=false;pending.then(()=>settled=true,()=>settled=true);
      const frame=document.querySelector('iframe');const request=new URL(frame.src).searchParams.get('request');
      dispatchEvent(new MessageEvent('message',{source:frame.contentWindow,origin:location.origin,data:{type:'romzo-grant',request,grant:{}}}));
      await new Promise(r=>setTimeout(r,50));if(settled)throw Error('foreign-origin message accepted');controller.abort();try{await pending;}catch(e){return {code:e.code,frames:document.querySelectorAll('iframe').length};}
    },origin);assert.deepEqual(binding,{code:'attestation_cancelled',frames:0});
    const failures=await fixture.evaluate(async()=>{
      const {openIdentityStore}=await import('/sdk/storage.js');const s=await openIdentityStore({namespace:'failure-tests'});
      const existingStore=await openIdentityStore({namespace:'romzo-playground'});const original=(await existingStore.list())[0];existingStore.close();
      const record=await s.save({...original,identityId:undefined});const tracker=s.track(record);
      const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,...args){const result=put.call(this,value,...args);if(value.namespace==='failure-tests')this.transaction.abort();return result;};
      let rejected=false;try{await tracker.onRecovery(original.recovery);}catch{rejected=true;}finally{IDBObjectStore.prototype.put=put;}
      if(!rejected)throw Error('aborted persistence reported success');
      await s.remove(record);s.close();
      const native=indexedDB;Object.defineProperty(window,'indexedDB',{value:undefined,configurable:true});let unavailable=false;try{await openIdentityStore({namespace:'blocked'});}catch(e){unavailable=e.message==='identity_storage_unavailable';}finally{Object.defineProperty(window,'indexedDB',{value:native,configurable:true});}
      return {rejected,unavailable};
    });assert.deepEqual(failures,{rejected:true,unavailable:true});
    await fixture.routeWebSocket('**/ws',socket=>socket.close());
    const networkFailure=await fixture.evaluate(async({origin,code})=>{
      const {openIdentityStore,connectPersistentRoom}=await import('/sdk/storage.js');const {RelaySession}=await import('/sdk/romzo.js');
      const s=await openIdentityStore({namespace:'romzo-playground'});const rows=await s.list({origin,code});const row=rows[0];const tabKey=JSON.stringify(['romzo-identity',s.namespace,origin,code]);sessionStorage.setItem(tabKey,row.identityId);
      let rejected=false;try{await connectPersistentRoom(s,origin,code,(ticket,key,signed,opts)=>RelaySession.connect(origin.replace('http:','ws:')+'/ws',ticket,key,opts));}catch{rejected=true;}
      const result={rejected,unchanged:(await s.list({origin,code})).length===rows.length,label:sessionStorage.getItem(tabKey)===row.identityId};s.close();return result;
    },{origin,code});assert.deepEqual(networkFailure,{rejected:true,unchanged:true,label:true});
    const custom=await context.newPage();await custom.goto(app+'/fixture');
    const ttlResult=await custom.evaluate(async origin=>{
      const {openIdentityStore}=await import('/sdk/storage.js');const sdk=await import('/sdk/romzo.js');
      const room=await sdk.createRoom(origin,{identityPolicy:{exclusive:true,ttlMs:1500},channels:[{name:'chat',maxFrameBytes:16384}]},{turnstileToken:'test-token'});
      const s=await openIdentityStore({namespace:'custom-ttl'});const row=await s.save({origin,code:room.descriptor.code,instance:room.descriptor.instance,host:room.host,transport:room.transport,signedDescriptor:room.signedDescriptor,recovery:room.recovery});
      if(row.expiresAt-Date.now()>1500)throw Error('signed room TTL was not applied');
      const tracker=s.track(row);const session=await sdk.RelaySession.connect(origin.replace('http:','ws:')+'/ws',room.admission,room.transport,{onRecovery:tracker.onRecovery,keepaliveIntervalMs:500});tracker.bind(session);
      await session.subscribe('chat');await session.keepalive();await new Promise(r=>setTimeout(r,1700));const live=!!await s.get(row,row.identityId);
      session.close();await tracker.flush();await new Promise(r=>setTimeout(r,1800));const expired=(await s.get(row,row.identityId))===null;
      let rejected=false;try{await sdk.restoreSession(row.signedDescriptor,row.recovery,row.transport);}catch{rejected=true;}s.close();return {live,expired,rejected};
    },origin);assert.deepEqual(ttlResult,{live:true,expired:true,rejected:true});
    const visual=await context.newPage();await visual.setViewportSize({width:390,height:844});
    await visual.route('https://challenges.cloudflare.com/**',route=>route.fulfill({contentType:'text/javascript',body:'window.turnstile={render:()=>1};window.ready();'}));
    await visual.goto(app+'/play.html');await visual.locator('#create').click();await expect(visual.locator('dialog[aria-label="Romzo verification"]')).toBeVisible();
    const verificationFrame=visual.frameLocator('iframe[title="Romzo verification"]');await expect(verificationFrame.locator('body')).toHaveCSS('font-family','system-ui');
    mkdirSync('test-results',{recursive:true});await visual.screenshot({path:'test-results/identity-verification-dialog.png',fullPage:true});
    assert.equal(await visual.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'verification dialog overflow');
    await visual.locator('dialog[aria-label="Romzo verification"] button').click();await expect(visual.locator('dialog[aria-label="Romzo verification"]')).toHaveCount(0);
    assert.deepEqual(errors,[]);await context.close();
  }finally{await browser?.close();await kill();await new Promise(r=>site.close(r));await new Promise(r=>verify.close(r));if(dirname(resolve(dir))!==resolve(tmpdir())||!dir.split(/[\\/]/).at(-1).startsWith('romzo-identities-'))throw Error('unexpected identity fixture directory');rmSync(dir,{recursive:true,force:true});}
});
