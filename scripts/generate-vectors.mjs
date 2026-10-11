// Public deterministic fixtures only. Never deployment credentials.
import { webcrypto as crypto } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { canonical, hash, hex } from '@romzo/client/canonical';
const path = new URL('../protocol/relay-v1-vectors.json', import.meta.url);
const original = JSON.parse(readFileSync(path, 'utf8'));
const {value,domain,password,salt,iterations,genericOptions} = original;
assert.equal(password, 'public-test-vector-password');
assert.equal(salt, 'ab'.repeat(32));
assert.equal(iterations, 600000);
const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);
const key=await crypto.subtle.deriveBits({name:'PBKDF2',salt:Buffer.from(salt,'hex'),iterations,hash:'SHA-256'},material,256);
const hmac=await crypto.subtle.importKey('raw',key,{name:'HMAC',hash:'SHA-256'},false,['sign']);
const signingBytes = new TextEncoder().encode(domain+'\0'+canonical(value));
const privateSeed='9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'; // RFC 8032 test 1
const privateKey=await crypto.subtle.importKey('pkcs8',Buffer.from('302e020100300506032b657004220420'+privateSeed,'hex'),'Ed25519',false,['sign']);
const generated={value,domain,canonical:canonical(value),digest:await hash(domain,value),password,salt,iterations,
  derived:hex(key),hmac:hex(await crypto.subtle.sign('HMAC',hmac,signingBytes)),
  createProof:hex(await crypto.subtle.sign('HMAC',hmac,new TextEncoder().encode('romzo/relay-create/v1\0'+canonical(value)))),
  publicKey:'d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
  signature:hex(await crypto.subtle.sign('Ed25519',privateKey,signingBytes)),relayVersion:'1.3.0',genericOptions,
  genericOptionsHash:await hash('romzo/lobby-options/v1',genericOptions)};
if(process.argv.includes('--check')) {assert.deepEqual(generated, original);console.log('Shared deterministic vectors match.');}
else writeFileSync(path,JSON.stringify(generated,null,2)+'\n');
