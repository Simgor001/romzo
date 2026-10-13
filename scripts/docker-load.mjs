// Isolated, reproducible container-local load test. No host ports or Docker socket
// are exposed to the load generator. Only named resources created here are removed.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, cp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const root = fileURLToPath(new URL('..', import.meta.url));
const token = 'romzo-load-' + randomBytes(5).toString('hex');
const names = { network: token + '-net', volume: token + '-data', anchor: token + '-netns', relay: token + '-relay', worker: token + '-worker' };
const reportDir = join(root, 'test-results', 'docker-load', new Date().toISOString().replace(/[:.]/g,'-'));
const stage = await mkdtemp(join(tmpdir(), 'romzo-load-build-'));
const docker = (...args) => execFileSync('docker', args, { cwd: root, windowsHide: true, stdio: ['ignore','pipe','pipe'], encoding: 'utf8', maxBuffer: 4*1024*1024 }).trim();
const resources = [], events = [];
let sampler, pendingRestart, workerExit = 1;
function run(command, args) {
  return new Promise((ok, fail) => {
    const p = spawn(command,args,{cwd:root,windowsHide:true,stdio:'inherit'});
    p.on('error',fail);p.on('exit',code=>code===0?ok():fail(Error(command+' exited '+code)));
  });
}
function bytes(text) { const m=/([\d.]+)\s*(B|kB|MB|GB|KiB|MiB|GiB)/.exec(text); if(!m)return 0; return Math.round(+m[1]*({B:1,kB:1000,MB:1e6,GB:1e9,KiB:1024,MiB:1048576,GiB:1073741824}[m[2]])); }
async function sample() {
  const result = await new Promise(resolveResult => {
    const p=spawn('docker',['stats','--no-stream','--format','{{json .}}',names.relay,names.worker],{windowsHide:true});
    let out='';p.stdout.on('data',v=>out+=v);p.on('error',()=>resolveResult(''));p.on('exit',()=>resolveResult(out));
  });
  for(const line of result.trim().split('\n').filter(Boolean)) {
    try { const s=JSON.parse(line);resources.push({time:new Date().toISOString(),name:s.Name,cpuPercent:parseFloat(s.CPUPerc),memoryBytes:bytes(s.MemUsage.split('/')[0]),pids:+s.PIDs,network:s.NetIO,block:s.BlockIO}); } catch { /* container may be restarting */ }
  }
}
try {
  docker('version','--format','{{.Server.Version}}');
  await mkdir(reportDir,{recursive:true});
  await run(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'-p','packages/romzo-client/tsconfig.build.json']);
  await run('docker',['build','-f','deploy/Dockerfile','-t','romzo-load-relay:local','relay']);
  await cp(join(root,'packages/romzo-client/dist'),join(stage,'sdk'),{recursive:true});
  for(const dep of ['ws','@noble/curves','@noble/hashes','qr']) await cp(join(root,'node_modules',dep),join(stage,'node_modules',dep),{recursive:true});
  await cp(join(root,'tests/load/relay-worker.mjs'),join(stage,'worker.mjs'));
  await writeFile(join(stage,'package.json'),'{"type":"module"}\n');
  await writeFile(join(stage,'Dockerfile'),'FROM node:24-alpine\nWORKDIR /load\nCOPY . .\nCMD ["node","worker.mjs"]\n');
  await run('docker',['build','-t','romzo-load-generator:local',stage]);
  const metricsKey=randomBytes(32).toString('hex');
  const envPath=join(stage,'load.env');
  const runtimeEnv={ LISTEN:'127.0.0.1:9224',PUBLIC_ORIGIN:'http://127.0.0.1:9224',CREATE_AUTH:'anonymous',
    AUTH_SALT:randomBytes(32).toString('hex'),TICKET_KEY:randomBytes(32).toString('hex'),
    METRICS_KEY:metricsKey,CLIENT_ORIGINS:'*',ADMIN_ORIGINS:'https://load.example',
    MEMBER_STATE_FILE:'/data/members.json',METRICS_HISTORY_FILE:'/data/history.json',
    ROMZO_LOAD_SMOKE:process.argv.includes('--smoke')?'1':'0' };
  await writeFile(envPath,Object.entries(runtimeEnv).map(([key,value])=>key+'='+value).join('\n')+'\n',{mode:0o600});
  docker('network','create','--internal',names.network);
  docker('volume','create',names.volume);
  docker('run','--rm','--network','none','-v',names.volume+':/data','node:24-alpine','node','-e',"const f=require('node:fs');f.chownSync('/data',65532,65532);f.chmodSync('/data',0o700)");
  docker('run','-d','--name',names.anchor,'--network',names.network,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','node:24-alpine','node','-e','setInterval(()=>{},1000000)');
  docker('run','-d','--name',names.relay,'--network','container:'+names.anchor,'--env-file',envPath,'--memory','256m','--cpus','2','--pids-limit','128','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','-v',names.volume+':/data','romzo-load-relay:local');
  console.log('Container load test started; 2 CPU / 256 MiB relay; internal namespace; no published ports.');
  workerExit=await new Promise((done,fail)=>{
    const p=spawn('docker',['run','--name',names.worker,'--network','container:'+names.anchor,'--env-file',envPath,'--memory','1g','--cpus','4','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--mount',`type=bind,source=${reportDir},target=/report`,'romzo-load-generator:local'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    p.stderr.on('data',v=>process.stderr.write(v));
    const lines=createInterface({input:p.stdout});
    lines.on('line',line=>{
      try {
        const event=JSON.parse(line);events.push(event);
        if(event.event==='restart-request') {
          console.log('Restarting only the test relay container for recovery verification.');
          pendingRestart=run('docker',['restart',names.relay]);pendingRestart.catch(e=>console.error(e.message));
        } else if(event.event==='phase-complete') console.log(`${event.name}: ${event.pass?'PASS':'FAIL'}, ${event.received}/${event.expectedDeliveries} deliveries, p95 ${event.receiveP95Ms} ms, errors ${event.sendFailures}, disconnects ${event.unexpectedDisconnects}`);
        else console.log(line);
      } catch { console.log(line); }
    });
    let sampling=false;
    sampler=setInterval(()=>{if(!sampling){sampling=true;void sample().finally(()=>sampling=false);}},3000);
    p.on('error',fail);p.on('exit',done);
  });
  await pendingRestart; clearInterval(sampler);await sample();
  const report=JSON.parse(await readFile(join(reportDir,'worker.json'),'utf8'));
  const inspection=JSON.parse(docker('inspect',names.relay))[0];
  report.container={ image:docker('image','inspect','romzo-load-relay:local','--format','{{.Id}}'),sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),memoryLimitBytes:inspection.HostConfig.Memory,cpuLimit:inspection.HostConfig.NanoCpus/1e9,readOnly:inspection.HostConfig.ReadonlyRootfs,oomKilled:inspection.State.OOMKilled,restartCount:inspection.RestartCount,status:inspection.State.Status,exitCode:inspection.State.ExitCode,error:inspection.State.Error };
  report.resources=resources;report.workerExit=workerExit;
  report.container.sourceTreeDirty=!!execFileSync('git',['status','--porcelain','--','relay','deploy/Dockerfile'],{cwd:root,encoding:'utf8'}).trim();
  report.historyDiagnostics=JSON.parse(docker('run','--rm','--network','none','-v',names.volume+':/data:ro','node:24-alpine','node','-e',"const f=require('node:fs');const a=JSON.parse(f.readFileSync('/data/history.json'));console.log(JSON.stringify(a.map(r=>({observedAt:r.observedAt,updatedAt:r.updatedAt,endedAt:r.endedAt??0,onlineMillis:r.onlineMillis,wallSpanMillis:r.updatedAt-r.observedAt,validOnlineBound:r.onlineMillis<=r.updatedAt-r.observedAt}))))"));
  const relaySamples=resources.filter(r=>r.name===names.relay);
  report.peakRelayMemoryBytes=Math.max(0,...relaySamples.map(r=>r.memoryBytes));
  report.peakRelayCpuPercent=Math.max(0,...relaySamples.map(r=>r.cpuPercent));
  report.pass=report.pass&&workerExit===0&&!report.container.oomKilled&&report.finalMetrics?.connections===0&&report.finalMetrics?.queueBytes===0;
  await writeFile(join(reportDir,'report.json'),JSON.stringify(report,null,2));
  const logs=spawnSync('docker',['logs',names.relay],{windowsHide:true,encoding:'utf8'});
  await writeFile(join(reportDir,'relay.log'),(logs.stdout??'')+(logs.stderr??''));
  if(!report.pass)console.log('Relay state:',JSON.stringify(report.container),'Logs:',(logs.stdout??'')+(logs.stderr??''));
  const markdown=[`# Docker 内部打流测试：${report.pass?'通过':'失败'}`,`\n开始：${report.startedAt}；结束：${report.finishedAt}`,`\n提交：${report.container.sourceCommit}；relay ${report.serverVersion}；2 CPU / 256 MiB；只读、非特权、无宿主端口。`,
    '\n| 场景 | 连接数 | 确认发送 | 实际/预期投递 | 投递/s | 接收 p95 / p99 ms | 通过 |','|---|---:|---:|---:|---:|---:|---|',
    ...report.phases.map(p=>`| ${p.name} | ${p.connections} | ${p.acknowledged} | ${p.received}/${p.expectedDeliveries} | ${p.deliveriesPerSecond} | ${p.receiveP95Ms} / ${p.receiveP99Ms} | ${p.pass} |`),
    `\n采样峰值：relay ${(report.peakRelayMemoryBytes/1048576).toFixed(1)} MiB，CPU ${report.peakRelayCpuPercent}%（Docker 单核为 100%）。`,
    ...report.checks.map(c=>`\n- ${c.name}：${c.pass?'通过':'失败'}`),
    `\n退出后连接数 ${report.finalMetrics?.connections}，队列字节 ${report.finalMetrics?.queueBytes}。`,
    '\n范围：本机 Linux Docker 内部网络，真实 SDK、真实 relay。创建免验证；默认连接帧率/字节/IP 限额；节点总出口/房间累计额外限额未启用。未验证公网、TLS、Turnstile、NAT/TURN 或浏览器 RTC，不证明长时间生产稳定性。',
    '\n完整计数、逐秒 relay 指标和 Docker 资源采样见 report.json。',
  ].join('\n');
  await writeFile(join(reportDir,'report.md'),markdown);
  console.log(`REPORT ${reportDir}\nRESULT ${report.pass?'PASS':'FAIL'}`);
  if(!report.pass)process.exitCode=1;
} catch(e) { console.error(e.stack);process.exitCode=1; }
finally {
  clearInterval(sampler);
  for(const name of [names.worker,names.relay,names.anchor]) {try{docker('rm','-f',name);}catch{/* not created */}}
  try{docker('volume','rm',names.volume);}catch{/* not created */}
  try{docker('network','rm',names.network);}catch{/* not created */}
  // stage is an OS-created temporary directory, never a computed workspace path.
  if(dirname(resolve(stage))!==resolve(tmpdir()) || !stage.split(/[\\/]/).at(-1).startsWith('romzo-load-build-'))throw Error('unsafe temporary cleanup path');
  await rm(stage,{recursive:true,force:true,maxRetries:3,retryDelay:200});
}
