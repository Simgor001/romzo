'use strict';
(() => {
 const $ = id => document.getElementById(id);
 const translations = {
 zh: {roomRecords:'房间记录',trafficTop:'流量 Top 10',onlineTop:'在线 Top 10',roomId:'房间号',creatorIP:'创建 IP',stopRoom:'下线',confirmStop:'让这个房间下线？有效恢复票据将被拒绝。',actionFailed:'操作失败，请刷新检查',adminStopped:'手动下线',traffic:'流量',onlineTime:'在线',state:'状态',live:'当前',ended:'已结束',limited:'已限停',trafficStopped:'流量限停',ageStopped:'时长限停',noRooms:'暂无记录',memoryHistory:'内存记录',fileHistory:'文件记录',writeFailed:'记录保存失败',noLimits:'限额未启用',nodeRate:'节点',limits:'限额',enforce:'到限停止转发',title:'节点状态',key:'访问密钥',connect:'查看',updated:'更新',refresh:'刷新',pause:'暂停',resume:'继续',logout:'退出',rooms:'房间',connections:'连接',unauthenticated:'未认证连接',queueBytes:'队列占用',inRate:'入站速率',outRate:'出站速率',counters:'累计计数',receivedBytes:'入站字节',sentBytes:'出站字节',receivedFrames:'入站帧',sentFrames:'出站帧',queueRejected:'队列拒绝',reasons:'关闭原因',semanticsLabel:'统计口径',semantics:'计数随进程重启清零。入站统计认证后的帧，出站按入队统计。字节数不含传输开销。房间记录包括当前房间及近 24 小时结束的房间；在线时长不含节点停机时间。',idle:'',loading:'正在读取…',online:'',paused:'已暂停',auth:'密钥无效',disabled:'监控接口未启用。',failed:'读取失败，数据未更新',none:'暂无关闭记录',reset:'计数已重置'},
 en: {roomRecords:'Room records',trafficTop:'Traffic Top 10',onlineTop:'Online Top 10',roomId:'Room',creatorIP:'Creator IP',stopRoom:'Stop',confirmStop:'Stop this room and reject its valid restore tickets?',actionFailed:'Action failed. Refresh to check.',adminStopped:'Stopped',traffic:'Traffic',onlineTime:'Online',state:'Status',live:'Current',ended:'Ended',limited:'Limited',trafficStopped:'Traffic limit',ageStopped:'Age limit',noRooms:'No records',memoryHistory:'Memory only',fileHistory:'File history',writeFailed:'History save failed',noLimits:'Limits disabled',nodeRate:'Node',limits:'Limits',enforce:'Stops forwarding at the limit',title:'Node status',key:'Access key',connect:'View',updated:'Updated',refresh:'Refresh',pause:'Pause',resume:'Resume',logout:'Sign out',rooms:'Rooms',connections:'Connections',unauthenticated:'Unauthenticated',queueBytes:'Queued bytes',inRate:'Inbound rate',outRate:'Outbound rate',counters:'Cumulative counters',receivedBytes:'Inbound bytes',sentBytes:'Outbound bytes',receivedFrames:'Inbound frames',sentFrames:'Outbound frames',queueRejected:'Queue rejections',reasons:'Close reasons',semanticsLabel:'Counting method',semantics:'Counters reset on restart. Inbound counts authenticated frames; outbound counts enqueued frames. Bytes exclude transport overhead. Records cover current rooms and rooms ended within 24 hours; online time excludes node downtime.',idle:'',loading:'Loading…',online:'',paused:'Paused',auth:'Invalid key',disabled:'Monitoring is disabled.',failed:'Fetch failed. Data is stale.',none:'No closures recorded',reset:'Counters reset'}
 };
 let lang;
 try { const saved=localStorage.getItem('romzo-lang'); if(saved==='zh'||saved==='en')lang=saved; } catch(_) {}
 for(const preferred of navigator.languages || [navigator.language || 'en']) {
  const primary=preferred.toLowerCase().split('-')[0];
  if(!lang && (primary==='zh'||primary==='en'))lang=primary;
 }
 lang=lang || 'en';
 let key = '', timer, request, generation = 0, paused = false, previous, snapshot, lastUpdated, status = 'idle', error = false, ranking = 'trafficTop';
 const t = name => translations[lang][name];
 const count = value => new Intl.NumberFormat(lang).format(value);
 const bytes = value => {const units=['B','KiB','MiB','GiB','TiB']; let i=0; while(value>=1024 && i<units.length-1){value/=1024;i++;} return `${count(Math.round(value*10)/10)} ${units[i]}`;};
 function notice(name, failed=false){status=name; error=failed; $('status').textContent=t(name); $('status').dataset.error=String(failed); $('status').hidden=!t(name);}
 function localize(){document.documentElement.lang=lang==='zh'?'zh-CN':'en'; document.title=`Romzo · ${t('title')}`; document.querySelectorAll('[data-i18n]').forEach(el=>el.textContent=t(el.dataset.i18n)); $('language').textContent=lang==='zh'?'English':'中文'; $('pause').textContent=t(paused?'resume':'pause'); notice(status,error); if(snapshot)render();}
 const duration = seconds => {const hours=Math.floor(seconds/3600),minutes=Math.floor(seconds%3600/60);return hours?`${hours}h ${minutes}m`:minutes?`${minutes}m`:`${Math.floor(seconds)}s`;};
 function renderHistory(){
  const history=snapshot.roomHistory;if(!history)return;
  $('history-mode').textContent=t(history.writeError?'writeFailed':history.persistent?'fileHistory':'memoryHistory');
  $('room-limits').textContent=history.maxBytes||history.maxSeconds?`${t('limits')}: ${[history.maxBytes?bytes(history.maxBytes):'',history.maxSeconds?duration(history.maxSeconds):''].filter(Boolean).join(' / ')}`:t('noLimits');
  if(history.nodeOutboundBytesPerSecond)$('room-limits').textContent+=` · ${t('nodeRate')} ${bytes(history.nodeOutboundBytesPerSecond)}/s`;
  $('traffic-tab').setAttribute('aria-pressed',String(ranking==='trafficTop'));$('online-tab').setAttribute('aria-pressed',String(ranking==='onlineTop'));
  const body=$('room-records');body.replaceChildren();const records=history[ranking];
  if(!records.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=7;td.textContent=t('noRooms');tr.append(td);body.append(tr);}
  for(const record of records){const tr=document.createElement('tr');for(const value of [record.code||'—',record.creatorIP||'—',bytes(record.receivedBytes+record.sentBytes),duration(record.onlineSeconds),count(record.connections),t(record.stopReason==='admin_stopped'?'adminStopped':record.stopReason==='room_traffic_limit'?'trafficStopped':record.stopReason==='room_lifetime_limit'?'ageStopped':record.stopReason?'limited':record.active?'live':'ended')]){const td=document.createElement('td');td.textContent=value;tr.append(td);}tr.firstChild.title=record.id;const actions=document.createElement('td');if(record.active){const b=document.createElement('button');b.textContent=t('stopRoom');b.onclick=()=>{act('rooms/stop',{id:record.id},b);};actions.append(b);}tr.append(actions);body.append(tr);}
 }
 async function act(action,body,button){const current=generation;button.disabled=true;const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),10000);try{const response=await fetch(`/api/v1/admin/${action}`,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal,cache:'no-store',credentials:'omit',redirect:'error',referrerPolicy:'no-referrer'});if(current!==generation)return;if(response.status===401){signOut('auth');return;}if(!response.ok)throw new Error();await refresh();}catch(_){if(current===generation)notice('actionFailed',true);}finally{clearTimeout(timeout);button.disabled=false;}}
 function render(){
  renderHistory();
  for(const field of ['rooms','connections','unauthenticated','receivedFrames','sentFrames','queueRejected']) $(field).textContent=count(snapshot[field]);
  for(const field of ['queueBytes','receivedBytes','sentBytes']) $(field).textContent=bytes(snapshot[field]);
  $('updated').textContent=lastUpdated.toLocaleTimeString(lang); $('updated').dateTime=lastUpdated.toISOString();
  $('inRate').textContent=snapshot.inRate===null?'—':`${bytes(snapshot.inRate)}/s`;
  $('outRate').textContent=snapshot.outRate===null?'—':`${bytes(snapshot.outRate)}/s`;
  $('reasons').replaceChildren();
  const reasons=Object.entries(snapshot.closedReasons).sort((a,b)=>b[1]-a[1]);
  if(!reasons.length){const li=document.createElement('li');li.textContent=t('none');$('reasons').append(li);}
  for(const [reason,n] of reasons){const li=document.createElement('li'),label=document.createElement('span'),value=document.createElement('span');label.textContent=reason;value.textContent=count(n);li.append(label,value);$('reasons').append(li);}
 }
 function stop(){clearTimeout(timer); timer=undefined; generation++; if(request)request.abort(); request=undefined;}
 function signOut(message='idle'){stop();key='';previous=undefined;snapshot=undefined;lastUpdated=undefined;paused=false;$('key').value='';$('login').hidden=false;$('dashboard').hidden=true;$('reasons').replaceChildren();$('room-records').replaceChildren();$('login').querySelector('button').disabled=false;$('refresh').disabled=false;for(const dd of document.querySelectorAll('dd'))dd.textContent='—';$('updated').textContent='—';notice(message,message!=='idle');$('key').focus();}
 function valid(data){return data && ['rooms','connections','unauthenticated','queueBytes','receivedFrames','receivedBytes','sentFrames','sentBytes','queueRejected'].every(k=>Number.isSafeInteger(data[k])&&data[k]>=0) && data.closedReasons && typeof data.closedReasons==='object' && !Array.isArray(data.closedReasons) && Object.values(data.closedReasons).every(n=>Number.isSafeInteger(n)&&n>=0);}
 async function refresh(){
  if(!key || request)return;
  clearTimeout(timer);const current=generation;const controller=new AbortController();request=controller;$('refresh').disabled=true;$('login').querySelector('button').disabled=true;if(!snapshot)notice('loading');
  const timeout=setTimeout(()=>controller.abort(),10000);
  try{
   const response=await fetch('/api/v1/metrics',{headers:{Authorization:`Bearer ${key}`},signal:controller.signal,cache:'no-store',credentials:'omit',redirect:'error',referrerPolicy:'no-referrer'});
   if(current!==generation)return;
   if(response.status===401 || response.status===403){signOut('auth');return;}
   if(response.status===404){signOut('disabled');return;}
   if(!response.ok)throw new Error('metrics unavailable');
   const data=await response.json();if(current!==generation)return;if(!valid(data))throw new Error('invalid metrics');
   const now=performance.now(); const reset=previous && ['receivedBytes','sentBytes','receivedFrames','sentFrames'].some(k=>data[k]<previous.data[k]);
   const seconds=previous?(now-previous.at)/1000:0;
   snapshot={...data,inRate:previous&&!reset&&seconds>0?(data.receivedBytes-previous.data.receivedBytes)/seconds:null,outRate:previous&&!reset&&seconds>0?(data.sentBytes-previous.data.sentBytes)/seconds:null};
   previous={data,at:now}; lastUpdated=new Date();$('login').hidden=true;$('dashboard').hidden=false;render();notice(reset?'reset':paused?'paused':'online');
  }catch(_){if(current===generation){notice('failed',true); if(!snapshot){key='';$('key').focus();}}}
  finally{clearTimeout(timeout);if(current===generation){request=undefined;$('refresh').disabled=false;$('login').querySelector('button').disabled=false;if(key&&!paused)timer=setTimeout(refresh,5000);}}
 }
 $('login').addEventListener('submit',event=>{event.preventDefault();stop();key=$('key').value;$('key').value='';previous=undefined;paused=false;refresh();});
 $('traffic-tab').addEventListener('click',()=>{ranking='trafficTop';renderHistory();});
 $('online-tab').addEventListener('click',()=>{ranking='onlineTop';renderHistory();});
 $('refresh').addEventListener('click',refresh);
 $('pause').addEventListener('click',()=>{paused=!paused;clearTimeout(timer);$('pause').textContent=t(paused?'resume':'pause');if(paused)notice('paused');else refresh();});
 $('logout').addEventListener('click',()=>signOut());
 $('language').addEventListener('click',()=>{lang=lang==='zh'?'en':'zh';try{localStorage.setItem('romzo-lang',lang);}catch(_){}localize();});
 window.addEventListener('pagehide',()=>signOut());
 localize();
})();
