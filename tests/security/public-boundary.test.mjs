import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
const checker = new URL('../../scripts/check-public.mjs', import.meta.url);
function fixture(run) {
  const path=mkdtempSync(join(tmpdir(),'romzo-public-test-'));
  const git=(...args)=>execFileSync('git',args,{cwd:path,stdio:'pipe',windowsHide:true});
  try {
    git('init','--quiet');git('config','user.name','Public fixture');git('config','user.email','fixture@users.noreply.github.com');
    mkdirSync(join(path,'scripts'));copyFileSync(checker,join(path,'scripts/check-public.mjs'));
    writeFileSync(join(path,'README.md'),'public documentation\n');
    git('add','README.md','scripts/check-public.mjs');git('commit','-m','Public fixture');
    const scan=()=>spawnSync(process.execPath,['scripts/check-public.mjs'],{cwd:path,encoding:'utf8',windowsHide:true});
    run({path,git,scan});
  } finally {
    if(dirname(resolve(path))!==resolve(tmpdir()) || !path.includes('romzo-public-test-'))throw Error('unexpected fixture cleanup path');
    rmSync(path,{recursive:true,force:true});
  }
}
test('provider token remains blocked after removal from the working tree',()=>fixture(({path,git,scan})=>{
  const synthetic=['gh','p_','a'.repeat(40)].join('');
  writeFileSync(join(path,'README.md'),synthetic);git('add','README.md');git('commit','-m','Synthetic finding');
  writeFileSync(join(path,'README.md'),'public documentation\n');
  const result=scan();assert.notEqual(result.status,0);assert.match(result.stderr,/history.*provider-token/);
  assert.ok(!result.stderr.includes(synthetic));
}));
test('redacting the working tree cannot hide a staged token',()=>fixture(({path,git,scan})=>{
  const synthetic=['gh','p_','b'.repeat(40)].join('');
  writeFileSync(join(path,'README.md'),synthetic);git('add','README.md');
  writeFileSync(join(path,'README.md'),'public documentation\n');
  const result=scan();assert.notEqual(result.status,0);assert.match(result.stderr,/staged.*provider-token/);
  assert.ok(!result.stderr.includes(synthetic));
}));
test('forced secret files and unexpected data cannot cross the public allowlist',()=>fixture(({path,git,scan})=>{
  writeFileSync(join(path,'.env'),'TICKET_KEY=synthetic-fixture-only\n');git('add','-f','.env');
  const result=scan();assert.notEqual(result.status,0);assert.match(result.stderr,/outside-public-allowlist/);
}));
test('an unreviewed literal credential fails without disclosing its value',()=>fixture(({path,scan})=>{
  const synthetic=['not','a','real','secret'].join('-');
  writeFileSync(join(path,'README.md'),['password',': ',JSON.stringify(synthetic),'\n'].join(''));
  const result=scan();assert.notEqual(result.status,0);assert.match(result.stderr,/credential-literal/);
  assert.ok(!result.stderr.includes(synthetic));
}));
test('named public vector fixtures remain usable',()=>fixture(({path,scan})=>{
  writeFileSync(join(path,'README.md'),'password: "public-test-vector-password"\n');
  assert.equal(scan().status,0);
}));
test('example configuration secret placeholders must stay empty',()=>fixture(({path,scan})=>{
  mkdirSync(join(path,'apps/relay'),{recursive:true});
  writeFileSync(join(path,'apps/relay/.env.example'),['TICKET_KEY','=','synthetic-fixture-only','\n'].join(''));
  const result=scan();assert.notEqual(result.status,0);assert.match(result.stderr,/nonempty-example-secret/);
}));
test('private commit email cannot accidentally enter public history',()=>fixture(({git,scan})=>{
  git('-c','user.email=private-fixture@example.invalid','commit','--allow-empty','-m','Synthetic private identity');
  const result=scan();assert.notEqual(result.status,0);assert.match(result.stderr,/non-public-commit-email/);
  assert.ok(!result.stderr.includes('private-fixture@example.invalid'));
}));
test('a shared history blob cannot hide a forbidden path',()=>fixture(({path,git,scan})=>{
  writeFileSync(join(path,'README.md'),'same public content\n');git('add','README.md');git('commit','-m','Shared content');
  copyFileSync(join(path,'README.md'),join(path,'private-data.txt'));git('add','private-data.txt');git('commit','-m','Synthetic forbidden path');
  git('rm','private-data.txt');git('commit','-m','Remove synthetic path');
  const result=scan();assert.notEqual(result.status,0);assert.match(result.stderr,/history.*private-data\.txt.*outside-public-allowlist/);
}));
test('history symlinks remain forbidden even after removal',()=>fixture(({path,git,scan})=>{
  const oid=execFileSync('git',['hash-object','-w','--stdin'],{cwd:path,input:'README.md',encoding:'utf8',windowsHide:true}).trim();
  git('update-index','--add','--cacheinfo','120000',oid,'scripts/relay.mjs');git('commit','-m','Synthetic symlink');
  git('rm','--cached','scripts/relay.mjs');git('commit','-m','Remove synthetic symlink');
  const result=scan();assert.notEqual(result.status,0);assert.match(result.stderr,/non-regular-history-entry/);
}));
