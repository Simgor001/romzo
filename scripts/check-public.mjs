import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true });
const root = git('rev-parse', '--show-toplevel').trim();
const findings = new Set();
function fail(label, rule) { findings.add(`${label}: ${rule}`); }
const patterns = [
  ['provider-token', /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}|\bsk-(?:proj-|ant-)[A-Za-z0-9_-]{20,}|\b(?:AKIA|ASIA|AKID)[A-Za-z0-9]{16,}|\bAIza[A-Za-z0-9_-]{30,}/],
  ['private-key-pem', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/],
  ['jwt-literal', /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/],
  ['machine-path', /\b[A-Z]:[\\/]|\/(?:Users|home)\/[A-Za-z0-9_.-]+\//],
  ['credential-url', /https?:\/\/[^\s/'"@]+:[^\s/'"@]+@/],
];
// Named public fixtures only; no blanket exemption for a tests directory.
const fixtureValues = new Set([
  'public-test-vector-password',
  'vector-password',
  '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
]);
function inspect(label, body) {
  if (label.replaceAll('\\', '/').includes('.romzo-history/')) fail(label, 'private-runtime-history');
  try {
    const value = JSON.parse(body);
    if (Array.isArray(value) && value.some(row => row && typeof row === 'object' && typeof row.id === 'string' && 'observedAt' in row && 'onlineMillis' in row && 'receivedBytes' in row)) fail(label, 'private-runtime-history');
  } catch {} // Source and binaries are normally not JSON.

  for (const [rule, pattern] of patterns) {
    // Bare three-byte drive prefixes can occur randomly in machine code.
    // Require an actual folder component for binaries; source stays stricter.
    const binary = /^artifact apps\/relay\/dist\/(?:romzo-relay-|integration-relay)/.test(label);
    const candidate = rule==='machine-path' && binary ? /\b[A-Z]:[\\/][\p{L}\p{N}_. -]+[\\/]|\/(?:Users|home)\/[A-Za-z0-9_.-]+\//u : pattern;
    if (candidate.test(body)) fail(label, rule);
  }
  if(label.endsWith('.env.example')) {
    for(const match of body.matchAll(/^(?:CREATE_PASSWORD|AUTH_SALT|TICKET_KEY|METRICS_KEY|TURNSTILE_SECRET)=([^\r\n]*)/gm)) {
      if(match[1].trim())fail(label,'nonempty-example-secret');
    }
  }
  const assignments = /\b(?:CREATE_PASSWORD|AUTH_SALT|TICKET_KEY|METRICS_KEY|TURNSTILE_SECRET|api[_-]?key|access[_-]?token|password|private[_-]?(?:key|seed)|secret)["']?\s*[:=]\s*["']([^"'\r\n]{8,})["']/gi;
  for (const match of body.matchAll(assignments)) {
    if (!fixtureValues.has(match[1])) fail(label, 'credential-literal');
  }
}
// Every git-tracked (and untracked, non-ignored) file is a public-boundary
// scan target; symlinks, non-regular files and oversized files are findings.
const paths = git('ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean);
let files = 0;
for (const path of new Set(paths)) {
  const full = resolve(root, path);
  if(!existsSync(full))continue; // Index and history are checked independently.
  const stat = lstatSync(full);
  if (stat.isSymbolicLink() || !stat.isFile()) { fail(path, 'non-regular-file'); continue; }
  if (stat.size > 2 * 1024 * 1024) { fail(path, 'unexpected-large-file'); continue; }
  inspect(path, readFileSync(full, 'utf8')); files++;
}
for (const record of git('ls-files', '--stage', '-z').split('\0').filter(Boolean)) {
  const [header,path] = record.split('\t'), [mode,oid,stage] = header.split(' ');
  if(mode==='120000')fail(path,'staged-symlink');
  if(stage!=='0')fail(path,'unmerged-index');
  inspect(`staged ${path}`,git('cat-file','blob',oid));
}
const objects = git('rev-list', '--objects', '--all').trim().split('\n').filter(Boolean);
for (const oid of git('rev-list', '--all').trim().split('\n').filter(Boolean)) {
  const body = git('cat-file', 'commit', oid);
  inspect(`commit ${oid.slice(0, 12)}`, body);
  for (const line of body.split('\n').filter(line => /^(author|committer) /.test(line))) {
    const email = /<([^>]+)>/.exec(line)?.[1];
    if (email && !email.endsWith('@users.noreply.github.com') && email !== 'noreply@github.com') fail(`commit ${oid.slice(0, 12)}`, 'non-public-commit-email');
  }
  // rev-list names each blob only once; check every tree entry's mode/type too.
  for(const entry of git('ls-tree','-r','-z','--full-tree',oid).split('\0').filter(Boolean)) {
    const [header,path] = entry.split('\t'), [mode,type] = header.split(' ');
    if(type!=='blob' || !['100644','100755'].includes(mode))fail(`history ${oid.slice(0,12)} ${path}`,'non-regular-history-entry');
  }
}
let blobs = 0;
for (const object of objects) {
  const split = object.indexOf(' '), oid = split < 0 ? object : object.slice(0, split), path = split < 0 ? '' : object.slice(split + 1);
  if (git('cat-file', '-t', oid).trim() !== 'blob') continue;
  inspect(`history ${oid.slice(0, 12)} ${path}`, git('cat-file', 'blob', oid)); blobs++;
}
let artifacts=0;
if(process.argv.includes('--artifacts')) {
  function walk(path) {
    const full=resolve(root,path), stat=lstatSync(full);
    if(stat.isSymbolicLink()){fail(path,'artifact-symlink');return;}
    if(stat.isDirectory()){for(const name of readdirSync(full))walk(path+'/'+name);return;}
    if(!stat.isFile() || stat.size>32*1024*1024){fail(path,'unexpected-artifact-size');return;}
    if(path.startsWith('packages/romzo-client/dist/') && !/^packages\/romzo-client\/dist\/[a-z]+\.(?:js|d\.ts)$/.test(path))fail(path,'unexpected-sdk-artifact');
    inspect(`artifact ${path}`,readFileSync(full,'utf8'));artifacts++;
  }
  for(const path of ['packages/romzo-client/dist','apps/relay/dist']) {
    if(!existsSync(resolve(root,path)))fail(path,'missing-artifacts');else walk(path);
  }
}
if (findings.size) {
  console.error('Public boundary check failed. Values omitted:\n' + [...findings].join('\n'));
  process.exitCode = 1;
} else console.log(`Public boundary check passed: ${files} files, ${blobs} reachable history blobs, ${artifacts} artifacts. No matching credential patterns; manual review still required.`);
