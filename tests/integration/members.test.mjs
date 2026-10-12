import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { chromium, expect } from '@playwright/test';

const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('stable members: three real browsers, shared identity, hard restart, UI order', {timeout:90000}, async()=>{
  const output=mkdtempSync(join(tmpdir(),'romzo-members-'));
  const binary=join(output,process.platform==='win32'?'relay.exe':'relay');
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
  const port=probe.address().port;await new Promise(r=>probe.close(r));
  const origin=`http://127.0.0.1:${port}`,ws=origin.replace('http:','ws:')+'/ws';
  const env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,LISTEN:`127.0.0.1:${port}`,PUBLIC_ORIGIN:origin,
    CREATE_AUTH:'anonymous',AUTH_SALT:randomBytes(32).toString('hex'),TICKET_KEY:randomBytes(32).toString('hex'),
    CLIENT_ORIGINS:'*',MEMBER_STATE_FILE:join(output,'members.json')};
  const root=new URL('../../website/',import.meta.url);
  const site=createServer((req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname;
    if(path==='/fixture.html'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Member integration</title>');return;}
    if(!/^\/[a-zA-Z0-9/_.-]+$/.test(path)||path.includes('..')){res.writeHead(400).end();return;}
    try{
      let body=readFileSync(new URL('.'+path,root));
      if(path==='/play.html')body=body.toString().replace("const ORIGIN = 'https://romzo.net';",`const ORIGIN = '${origin}';`);
      res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':path.endsWith('.svg')?'image/svg+xml':'text/html');res.end(body);
    }catch{res.writeHead(404).end();}
  });
  let relay,browser;
  async function start(){
    relay=spawn(binary,[],{env,stdio:'ignore',windowsHide:true});
    for(let n=0;n<100;n++){
      if(await fetch(origin+'/healthz').then(r=>r.ok).catch(()=>false))return;
      if(relay.exitCode!==null)throw Error('relay exited');await pause(50);
    }throw Error('relay readiness timeout');
  }
  async function kill(){if(!relay||relay.exitCode!==null)return;const exited=once(relay,'exit');relay.kill('SIGKILL');await exited;}
  try{
    execFileSync('go',['build','-trimpath','-o',binary,'.'],{cwd:new URL('../../relay/',import.meta.url),windowsHide:true});
    await start();site.listen(0,'127.0.0.1');await once(site,'listening');
    const app=`http://127.0.0.1:${site.address().port}`;
    assert.equal((await fetch(origin+'/.well-known/romzo').then(r=>r.json())).stableMemberOrder,true);
    browser=await chromium.launch();
    const contexts=await Promise.all([1,2,3].map(()=>browser.newContext()));
    const pages=await Promise.all(contexts.map(c=>c.newPage()));
    const errors=[];for(const p of pages)p.on('pageerror',e=>errors.push(e.message));
    for(const p of pages)await p.goto(app+'/fixture.html');
    const code=await pages[0].evaluate(async({origin,ws})=>{
      window.sdk=await import('/sdk/romzo.js');
      window.room=await sdk.createRoom(origin,{channels:[{name:'chat',maxFrameBytes:16384},{name:'hidden',maxFrameBytes:16384}]});
      window.material={signedDescriptor:room.signedDescriptor,transport:room.transport,admission:room.admission};
      window.session=await sdk.RelaySession.connect(ws,material.admission,material.transport,{keepalive:false});
      await session.subscribe('chat');await session.keepalive();return room.descriptor.code;
    },{origin,ws});
    for(const p of pages.slice(1))await p.evaluate(async({origin,ws,code})=>{
      window.sdk=await import('/sdk/romzo.js');window.material=await sdk.joinRoom(origin,code);
      window.session=await sdk.RelaySession.connect(ws,material.admission,material.transport,{keepalive:false});
      await session.subscribe('chat');await session.keepalive();
      window.received=[];session.on('receive',(value,meta)=>received.push({text:value.text,joinSeq:meta.joinSeq}));
    },{origin,ws,code});
    for(const p of pages)await expect.poll(()=>p.evaluate(()=>session.members('chat').map(m=>m.joinSeq))).toEqual([1,2,3]);
    assert.deepEqual(await Promise.all(pages.map(p=>p.evaluate(()=>session.joinSeq))),[1,2,3]);
    await pages[2].evaluate(()=>session.send('chat',{text:'third speaks first'}));
    await pages[0].evaluate(()=>session.send('chat',{text:'first speaks second'}));
    await expect.poll(()=>pages[1].evaluate(()=>received)).toEqual([{text:'third speaks first',joinSeq:3},{text:'first speaks second',joinSeq:1}]);
    await pages[1].evaluate(async({ws})=>{
      window.duplicate=await sdk.RelaySession.connect(ws,material.admission,material.transport,{keepalive:false});await duplicate.subscribe('chat');
    },{ws});
    for(const p of pages)await expect.poll(()=>p.evaluate(()=>session.members('chat').map(m=>m.joinSeq))).toEqual([1,2,2,3]);
    await pages[1].evaluate(()=>duplicate.close());
    for(const p of pages)await expect.poll(()=>p.evaluate(()=>session.members('chat').map(m=>m.joinSeq))).toEqual([1,2,3]);
    // Hidden channel subscription never leaks the other chat-only members.
    await pages[0].evaluate(()=>session.subscribe('hidden'));
    assert.deepEqual(await pages[0].evaluate(()=>session.members('hidden').map(m=>m.joinSeq)),[1]);
    for(const p of pages)await p.evaluate(async()=>{await session.keepalive();window.recovery=session.currentRecovery();});
    await kill();
    for(const p of pages)await expect.poll(()=>p.evaluate(()=>session.members('chat').length)).toBe(0);
    await start();
    // Reverse recovery order: persisted identity order must win over reconnect order.
    for(const p of [...pages].reverse())await p.evaluate(async({ws})=>{
      const restored=await sdk.restoreSession(material.signedDescriptor,recovery,material.transport);
      window.session=await sdk.RelaySession.connect(ws,restored.admission,material.transport,{keepalive:false});await session.subscribe('chat');
    },{ws});
    for(const p of pages)await expect.poll(()=>p.evaluate(()=>session.members('chat').map(m=>m.joinSeq))).toEqual([1,2,3]);
    assert.deepEqual(await Promise.all(pages.map(p=>p.evaluate(()=>session.joinSeq))),[1,2,3]);
    await pages[2].evaluate(async({origin,ws,code})=>{
      const late=await sdk.joinRoom(origin,code);window.lateSession=await sdk.RelaySession.connect(ws,late.admission,late.transport,{keepalive:false});await lateSession.subscribe('chat');
    },{origin,ws,code});
    for(const p of pages)await expect.poll(()=>p.evaluate(()=>session.members('chat').map(m=>m.joinSeq))).toEqual([1,2,3,4]);
    assert.equal(await pages[2].evaluate(()=>lateSession.joinSeq),4);
    const saved=JSON.parse(readFileSync(env.MEMBER_STATE_FILE,'utf8'));
    assert.equal(Object.keys(Object.values(saved.records)[0].members).length,4);
    for(const c of contexts)await c.close();

    // Actual playground: join order differs from first-message order.
    const ui=await browser.newContext();
    await ui.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
    await ui.addInitScript(()=>{window.turnstile={render:(_box,o)=>{window.verify=o.callback;return 1;},execute:()=>window.verify('local-fixture'),remove:()=>{}};});
    const host=await ui.newPage();host.on('pageerror',e=>errors.push(e.message));await host.goto(app+'/play.html');
    await host.locator('#create').click();await expect(host.locator('#create-result')).toBeVisible();
    const uiCode=await host.locator('#room-code').textContent();
    const guests=[];for(let n=0;n<2;n++){
      const p=await ui.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto(app+'/play.html');
      await p.locator('#mode-join').click();await p.locator('#join-code').fill(uiCode);await p.locator('#join').click();
      await expect(p.locator('#create-result')).toBeVisible();guests.push(p);
    }
    await expect(host.locator('#connection-badge')).toContainText('3');
    await guests[1].locator('#message').fill('third first');await guests[1].locator('#send').click();
    await expect(host.locator('.play-message-meta').last()).toContainText('Participant 3');
    await guests[0].locator('#message').fill('second next');await guests[0].locator('#send').click();
    await expect(host.locator('.play-message-meta').last()).toContainText('Participant 2');
    await host.locator('#message').fill('host last');await host.locator('#send').click();
    await expect(host.locator('.play-message-meta').last()).toContainText('You · Participant 1');
    await expect(guests[1].locator('.play-message-meta').last()).toContainText('Participant 1');
    mkdirSync(resolve('test-results'),{recursive:true});
    await host.screenshot({path:resolve('test-results/member-order.png'),fullPage:true});
    assert.deepEqual(errors,[]);await ui.close();
    console.log('PASS: 3 isolated browser identities; shared-key connections; channel isolation; SIGKILL recovery in reverse order; real playground labels 3,2,1. Local verification stub only; no public-node acceptance claimed.');
  }finally{
    await browser?.close();await kill();await new Promise(r=>site.close(r));
    if(dirname(resolve(output))!==resolve(tmpdir()))throw Error('unexpected cleanup path');
    rmSync(output,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  }
});
