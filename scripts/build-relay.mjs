import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, copyFileSync, existsSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, basename } from 'node:path';
const cwd = resolve('relay'), out = resolve('dist/relay');
function copyNotice(source, target) {
  if(existsSync(target))chmodSync(target,0o666);
  copyFileSync(source,target);chmodSync(target,0o644);
}
mkdirSync(out, {recursive: true});
const hashes = [];
for (const [GOOS, GOARCH] of [['linux','amd64'],['linux','arm64'],['windows','amd64']]) {
  const file = `romzo-relay-${GOOS}-${GOARCH}${GOOS === 'windows' ? '.exe' : ''}`;
  execFileSync('go', ['build','-trimpath','-ldflags=-s -w','-o',resolve(out,file),'.'], {cwd,env: {...process.env,CGO_ENABLED:'0',GOOS,GOARCH},stdio:'inherit',windowsHide:true});
  hashes.push(createHash('sha256').update(readFileSync(resolve(out,file))).digest('hex')+'  '+file);
}
writeFileSync(resolve(out,'SHA256SUMS'), hashes.join('\n')+'\n');
copyNotice(resolve('LICENSE'),resolve(out,'LICENSE'));
copyNotice(resolve('NOTICE'),resolve(out,'NOTICE'));
// Go dependencies are linked into the binaries: retain every module's notices.
const stream = execFileSync('go',['list','-deps','-json','.'],{cwd,encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024});
const modules = []; let depth=0,start=0,quoted=false,escaped=false;
for(let i=0;i<stream.length;i++) {
  const c=stream[i];
  if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
  if(c==='"'){quoted=true;continue;}
  if(c==='{'){if(depth===0)start=i;depth++;}
  if(c==='}'&&--depth===0)modules.push(JSON.parse(stream.slice(start,i+1)));
}
const notices=[];
const linkedModules = new Map(modules.filter(p=>p.Module && !p.Module.Main).map(p=>[p.Module.Path,p.Module]));
for (const module of linkedModules.values()) {
  const licenses = module.Dir && existsSync(module.Dir) ? readdirSync(module.Dir).filter(n=>/^(LICENSE|COPYING|NOTICE)(?:$|[.-])/i.test(n)) : [];
  if(!licenses.length) throw Error('Dependency license missing: '+module.Path);
  const directory=resolve(out,'licenses',module.Path.replace(/[^a-zA-Z0-9.-]/g,'_')+'@'+module.Version); mkdirSync(directory,{recursive:true});
  for(const name of licenses)copyNotice(resolve(module.Dir,name),resolve(directory,basename(name)));
  notices.push(`${module.Path} ${module.Version}`);
}
const goroot=execFileSync('go',['env','GOROOT'],{encoding:'utf8',windowsHide:true}).trim();
const goLicense=resolve(out,'licenses','go');mkdirSync(goLicense,{recursive:true});
for(const name of ['LICENSE','PATENTS'])if(existsSync(resolve(goroot,name)))copyNotice(resolve(goroot,name),resolve(goLicense,name));
notices.push(execFileSync('go',['version'],{encoding:'utf8',windowsHide:true}).trim().replace(/ windows\/amd64$/, ''));
writeFileSync(resolve(out,'THIRD_PARTY_NOTICES.txt'),notices.join('\n')+'\n');
console.log(`Built 3 binaries and retained license notices for ${notices.length} Go dependencies.`);
