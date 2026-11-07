'use strict';
// Public Telegram posts and the official DNS feed, kept as data, never code.
const fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http');
const {ThefeedController,WINDOWS_SHA256}=require('./thefeed.cjs');
const dns=require('node:dns/promises'),net=require('node:net');
const {GeoCountry,flagFromRemark}=require('./country.cjs');
const {validateOfficialResolvers}=require('./thefeed-resolvers.cjs');
const {extractLinks,parseLink,publicEntry}=require('./config-links.cjs');
const CHANNELS=require('./telegram-channels.cjs');
// Unverified candidates stay private; only a successful HTTPS test can enter the
// public list. Scan more candidates than the 1,000-result display target.
const MAX_ENTRIES=1000,MAX_CANDIDATES=6000,MAX_DNS_CHANNELS=200,WEB_CONCURRENCY=8,MAX_HIDDEN=10000;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function mapLimited(list,limit,fn){
 const values=Array(list.length);let next=0;
 await Promise.all(Array.from({length:Math.min(limit,list.length)},async()=>{for(;;){const i=next++;if(i>=list.length)break;values[i]=await fn(list[i],i);}}));
 return values;
}
function localRequest(endpoint,route,method='GET',body,timeout=5000){
 return new Promise((resolve,reject)=>{
  const data=body===undefined?null:Buffer.from(JSON.stringify(body));
  const headers={Authorization:'Basic '+Buffer.from('lml:'+endpoint.secret).toString('base64')};
  if(data){headers['Content-Type']='application/json';headers['Content-Length']=data.length;}
  const req=http.request({host:'127.0.0.1',port:endpoint.port,path:route,method,headers,timeout},res=>{
   const chunks=[];let size=0;res.on('data',b=>{size+=b.length;if(size>5_000_000)req.destroy(new Error('response too large'));else chunks.push(b);});
   res.on('error',reject);res.on('end',()=>{if(res.statusCode!==200)return reject(new Error('local API '+res.statusCode));try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(new Error('invalid local API'));}});
  });req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('local API timeout')));req.end(data);
 });
}
async function limitedText(response,max=3_000_000){
 if(Number(response.headers.get('content-length')||0)>max||!response.body)throw new Error('invalid response');
 const reader=response.body.getReader(),chunks=[];let size=0;
 try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>max)throw new Error('response too large');chunks.push(Buffer.from(value));}}
 finally{reader.releaseLock();}
 return Buffer.concat(chunks).toString('utf8');
}
async function telegram(channel,{signal}={}){
 if(!CHANNELS.includes(channel))throw new Error('unknown source');
 const timeout=AbortSignal.timeout(12000),combined=signal?AbortSignal.any([signal,timeout]):timeout;
 const response=await fetch('https://t.me/s/'+encodeURIComponent(channel),{redirect:'error',signal:combined,headers:{'User-Agent':'Mozilla/5.0 LML-VPN/1.0'}});
 if(!response.ok)throw new Error('channel unavailable');return extractLinks(await limitedText(response),'@'+channel+' · وب');
}
class DnsFeedSource {
 constructor({executable,dataDir,expectedHash=WINDOWS_SHA256,sharedController=null}){
  this.controller=new ThefeedController({executable,dataDir,expectedHash});
  this.sharedController=sharedController;this.busy=null;this.closed=false;this.usingShared=false;
 }
 check(){if(this.closed)throw new Error('دریافت فید متوقف شد.');}
 async useSharedResolvers(endpoint){
  this.usingShared=false;if(!this.sharedController)return false;
  try{
   // Read only the live DNS list from the user's actual feed. Never change its
   // active profile, list, bank, scores, or resolver files.
   const shared=await this.sharedController.start();this.check();
   const active=await localRequest(shared,'/api/resolvers/active');this.check();
   if(!Array.isArray(active?.resolvers)||!active.resolvers.length)return false;
   const resolvers=validateOfficialResolvers(active.resolvers.slice(0,100));
   const lists=await localRequest(endpoint,'/api/resolvers/lists?include=resolvers');this.check();
   const name='LML shared DNS',old=(lists.lists||[]).find(x=>x.name===name);
   if(!old)await localRequest(endpoint,'/api/resolvers/lists','POST',{name,resolvers});
   else {
    const previous=Array.isArray(old.resolvers)?old.resolvers:[];
    const remove=previous.filter(x=>!resolvers.includes(x)),add=resolvers.filter(x=>!previous.includes(x));
    if(remove.length)await localRequest(endpoint,'/api/resolvers/lists/remove','POST',{name,resolvers:remove});
    if(add.length)await localRequest(endpoint,'/api/resolvers/lists/add','POST',{name,resolvers:add});
   }
   this.check();await localRequest(endpoint,'/api/resolvers/lists/select','POST',{name,noScan:true});
   this.usingShared=true;return true;
  }catch{this.check();return false;}
 }
 async init(){
  this.check();const e=await this.controller.start();this.check();
  const defaults=await localRequest(e,'/api/profiles/defaults');
  const d=(defaults.profiles||[]).find(p=>typeof p?.nickname==='string'&&p.nickname.includes('فیلترشکن'))||(defaults.profiles||[]).find(p=>/^cfg\./i.test(p?.domain||''));
  if(!d||!d.domain||!d.key)throw new Error('config feed preset unavailable');
  const p=await localRequest(e,'/api/profiles');this.check();const profiles=Array.isArray(p.profiles)?p.profiles:[];
  const current=profiles.find(x=>x?.config?.domain===d.domain);
  if(!current)await localRequest(e,'/api/profiles','POST',{action:'create',profile:{id:'',nickname:d.nickname||d.domain,config:{domain:d.domain,key:d.key,serverKey:d.serverKey||'',extraDomains:d.extraDomains||[],queryMode:'single',rateLimit:6}},skipCheck:true},10000);
  else if(p.active!==current.id)await localRequest(e,'/api/profiles/switch','POST',{id:current.id,skipCheck:true},10000);
  this.check();const shared=await this.useSharedResolvers(e);this.check();
  if(!shared){
   const active=await localRequest(e,'/api/resolvers/active').catch(()=>null);
   if(!Array.isArray(active?.resolvers)||!active.resolvers.length)await localRequest(e,'/api/rescan','POST',undefined,4000).catch(()=>{});
  }
  return e;
 }
 fetch(){
  if(this.closed)return Promise.reject(new Error('دریافت فید متوقف شد.'));
  if(this.busy)return this.busy;
  const job=this._fetch().finally(()=>{if(this.busy===job)this.busy=null;});this.busy=job;return job;
 }
 async _fetch(){
  const e=await this.init(),deadline=Date.now()+55000;let channels=[];
  while(Date.now()<deadline&&!this.closed){
   const list=await localRequest(e,'/api/channels').catch(()=>null);channels=Array.isArray(list)?list:[];
   if(channels.length)break;await pause(1500);
  }
  this.check();if(!channels.length)return [];
  // Explicit previous channels take priority; additional channels come only
  // from the official config-feed profile. Keep their true names and indices.
  const indexed=channels.map((c,i)=>({name:String(c?.Name||c?.name||'').slice(0,60),index:i+1})).filter(c=>c.name&&!/[\x00-\x1f]/.test(c.name));
  const priority=indexed.filter(c=>CHANNELS.some(x=>x.toLowerCase()===c.name.toLowerCase()));
  const selected=[...priority,...indexed.filter(c=>!priority.includes(c))].slice(0,MAX_DNS_CHANNELS);
  await mapLimited(selected,10,c=>localRequest(e,'/api/refresh?channel='+c.index,'POST',undefined,5000).catch(()=>null));
  let result=[],firstResultAt=0;
  while(Date.now()<deadline&&!this.closed){
   const buckets=await mapLimited(selected,10,async c=>{
    const data=await localRequest(e,'/api/messages/'+c.index).catch(()=>null),items=[];
    const messages=Array.isArray(data?.messages)?data.messages:[];
    for(const message of messages){items.push(...extractLinks(String(message?.Text||message?.text||''),'@'+c.name+' · DNS/فید'));if(items.length>=100)break;}
    return items.slice(0,100);
   });
   result=[];const longest=Math.max(0,...buckets.map(b=>b.length));
   for(let i=0;i<longest&&result.length<MAX_CANDIDATES;i++)for(const bucket of buckets)if(bucket[i]&&result.length<MAX_CANDIDATES)result.push(bucket[i]);
   if(result.length&&!firstResultAt)firstResultAt=Date.now();
   if(firstResultAt&&(new Set(result.map(x=>x.source)).size>=Math.min(10,selected.length)||Date.now()-firstResultAt>=10000))break;
   await pause(1500);
  }
  this.check();return result.slice(0,MAX_CANDIDATES);
 }
 async stop(){this.closed=true;await this.controller.stop();}
}
class ConfigSources {
 constructor({app,binDir,onChange=()=>{},fetchTelegram=telegram,dnsSource=null,sharedController=null,geo=null,resolveHost=null}){
  this.file=path.join(app.getPath('userData'),'public-configs.json');this.onChange=onChange;this.fetchTelegram=fetchTelegram;
  this.entries=new Map();this.latencies={};this.prepared=new Map();this.hidden=new Set();this.busy=null;this.saveQueue=Promise.resolve();this.closed=false;this.aborter=null;this.fetchedAt=null;this.stale=false;this.note='';
  this.geo=geo||new GeoCountry(path.join(binDir(),'geoip.dat'));
  this.resolveHost=resolveHost||(async host=>(await dns.lookup(host,{family:4})).address);
  this.hostCountries=new Map();
  const dev=!app.isPackaged&&process.platform!=='win32'&&process.env.LML_FEED_DEV_BIN;
  // The shipped version is fixed; no automatic GitHub core update runs here.
  this.dns=dnsSource||new DnsFeedSource({executable:dev||path.join(binDir(),'thefeed-client.exe'),dataDir:path.join(app.getPath('userData'),'thefeed-config-source'),expectedHash:dev?null:WINDOWS_SHA256,sharedController});
 }
 snapshot(){
  const tested=[...this.entries.values()].filter(c=>this.prepared.has(c.id)&&Number.isFinite(this.latencies[c.id])&&this.latencies[c.id]>=0);
  tested.sort((a,b)=>this.latencies[a.id]-this.latencies[b.id]||a.id.localeCompare(b.id));
  return {items:tested.slice(0,MAX_ENTRIES).map(c=>({...publicEntry(c),source:'LML',countryCode:c.countryCode||flagFromRemark(c.remark),countrySource:c.countrySource||(flagFromRemark(c.remark)?'label':''),latency:this.latencies[c.id]})),candidateCount:this.entries.size,failedCount:Object.values(this.latencies).filter(ms=>ms===-1).length,fetchedAt:this.fetchedAt,stale:this.stale,note:this.note,refreshing:!!this.busy,hiddenCount:this.hidden.size};
 }
 // Candidate identities never leave the main process until a real HTTPS test
 // succeeds. On reload no previous test result is trusted as current.
 pendingIds(){return [...this.entries.keys()].filter(id=>!Object.hasOwn(this.latencies,id));}
 getUsable(id){
  const c=this.entries.get(id),ms=this.latencies[id];
  const pinned=this.prepared.get(id);
  if(!c||!pinned||!Number.isFinite(ms)||ms<0)return null;
  return {...c,address:pinned.address,transport:{...pinned.transport}};
 }
 emit(){this.onChange(this.snapshot());}
 async load(){
  try{
   const stat=await fs.stat(this.file);if(stat.size>50_000_000)return;
   const saved=JSON.parse(await fs.readFile(this.file,'utf8'));if(!Array.isArray(saved.links)||!Number.isFinite(saved.fetchedAt))return;
   this.hidden=new Set((Array.isArray(saved.hidden)?saved.hidden:[]).filter(id=>typeof id==='string'&&/^[a-f0-9]{24}$/.test(id)).slice(-MAX_HIDDEN));
   for(const item of saved.links.slice(0,MAX_CANDIDATES)){try{if(item.source==='ورودی دستی')continue;const c=parseLink(item.raw);c.source=String(item.source||'ذخیره‌شده').slice(0,100);if(!this.hidden.has(c.id))this.entries.set(c.id,c);}catch{}}
   this.fetchedAt=saved.fetchedAt;this.stale=true;this.note='موارد ذخیره‌شده پیش از نمایش دوباره آزمایش می‌شوند.';
  }catch{}
 }
 persist(){
  const contents=JSON.stringify({fetchedAt:this.fetchedAt||Date.now(),hidden:[...this.hidden].slice(-MAX_HIDDEN),links:[...this.entries.values()].slice(0,MAX_CANDIDATES).map(c=>({raw:c.raw,source:c.source}))});
  this.saveQueue=this.saveQueue.catch(()=>{}).then(async()=>{await fs.mkdir(path.dirname(this.file),{recursive:true});const tmp=this.file+'.tmp';await fs.writeFile(tmp,contents,{mode:0o600});await fs.rename(tmp,this.file);});return this.saveQueue;
 }
 get(id){return this.entries.get(id)||null;}
 setLatency(id,ms,prepared=null){
  if(!this.entries.has(id))return;
  // A connection completing after a refresh may report its old latency after
  // the refresh discarded its pin. Never turn that into an unpinned success.
  if(Number.isFinite(ms)&&ms>=0&&!prepared&&!this.prepared.has(id))return;
  this.latencies[id]=Number.isFinite(ms)&&ms>=0?Math.max(1,Math.round(ms)):-1;
  if(this.latencies[id]<0)this.prepared.delete(id);else if(prepared)this.prepared.set(id,{address:prepared.address,transport:{...prepared.transport}});
  this.emit();
  // Hostname DNS resolution is only done after the user actually tests or
  // connects to that server. It identifies ingress IP, not the exit country.
  if(this.latencies[id]>=0)void this.enrichCountry(id,true);
 }
 async enrichCountry(id,allowDNS=false){
  const c=this.entries.get(id);if(!c||c.countryCode||flagFromRemark(c.remark))return;
  try{
   let host=String(c.address||'').replace(/^\[|\]$/g,'');
   if(net.isIP(host)!==4){
    if(!allowDNS||net.isIP(host))return;
    if(!this.hostCountries.has(host))this.hostCountries.set(host,this.resolveHost(host).then(ip=>this.geo.lookup(ip)).catch(()=>''));
    const code=await this.hostCountries.get(host);
    if(code&&this.entries.get(id)===c){c.countryCode=code;c.countrySource='ip';this.emit();}return;
   }
   const code=await this.geo.lookup(host);
   if(code&&this.entries.get(id)===c){c.countryCode=code;c.countrySource='ip';this.emit();}
  }catch{}
 }
 async enrichLiteralIPs(){
  const list=[...this.entries.values()].filter(c=>!c.countryCode&&!flagFromRemark(c.remark)&&net.isIP(String(c.address||''))===4);
  // Loading the same GeoIP index is shared; update the list in one renderer event.
  if(!list.length)return;
  let changed=false;
  for(const c of list){try{const code=await this.geo.lookup(c.address);if(code&&this.entries.get(c.id)===c){c.countryCode=code;c.countrySource='ip';changed=true;}}catch{}}
  if(changed&&!this.closed)this.emit();
 }
 async remove(id){
  if(typeof id!=='string'||!this.entries.has(id))return 0;
  this.hidden.add(id);while(this.hidden.size>MAX_HIDDEN)this.hidden.delete(this.hidden.values().next().value);
  this.entries.delete(id);delete this.latencies[id];this.prepared.delete(id);this.emit();await this.persist();return 1;
 }
 async removeFailed(){
  // null means untested and must never be interpreted as a failed test.
  const ids=[...this.entries.keys()].filter(id=>this.latencies[id]===-1);
  for(const id of ids){this.hidden.add(id);this.entries.delete(id);delete this.latencies[id];this.prepared.delete(id);}
  while(this.hidden.size>MAX_HIDDEN)this.hidden.delete(this.hidden.values().next().value);
  this.emit();if(ids.length)await this.persist();return ids.length;
 }
 async restoreRemoved(){this.hidden.clear();await this.persist();this.emit();return true;}
 refresh(){
  if(this.closed)return Promise.reject(new Error('بخش کانفیگ بسته شده است.'));if(this.busy)return this.busy;
  // A new refresh is a new measurement, not a promise that yesterday's
  // successes still work. Failed entries also get a fresh chance.
  this.latencies={};this.prepared.clear();
  this.aborter=new AbortController();const core=this._refresh(this.aborter.signal);let job;
  job=core.finally(()=>{if(this.busy===job)this.busy=null;this.aborter=null;this.emit();}).then(()=>this.snapshot());
  this.busy=job;this.note='در حال بررسی ۲۰۰ کانال تلگرام و DNS فید…';this.emit();return job;
 }
 async _refresh(signal){
  // A bounded pool prevents 200 simultaneous requests. DNS and web run in
  // parallel; results appear as sources finish rather than after all timeouts.
  const groups=Array(CHANNELS.length).fill(null);let dnsItems=[],finished=0,unavailable=0,hadFresh=false,lastEmit=0;
  const merge=()=>{
   const buckets=[];
   const perDns=new Map();for(const c of dnsItems){const key=c.source||'DNS/فید';if(!perDns.has(key))perDns.set(key,[]);perDns.get(key).push(c);}
   for(const items of perDns.values())buckets.push({items,dns:true});
   for(const r of groups)if(r?.items?.length)buckets.push({items:r.items,dns:false});
   if(!buckets.length)return false;
   hadFresh=true;const previous=this.entries,merged=new Map(),max=Math.max(...buckets.map(b=>b.items.length));
   for(let i=0;i<max&&merged.size<MAX_CANDIDATES;i++)for(const bucket of buckets){
    const c=bucket.items[i];if(!c||!c.id||this.hidden.has(c.id))continue;
    const found=merged.get(c.id);
    if(found){
     if(bucket.dns&&!found.source.includes('DNS/فید'))found.source+=' + DNS/فید';
     else if(!bucket.dns&&found.source.includes('DNS/فید')&&!found.source.includes('وب'))found.source+=' + وب';
    }else if(merged.size<MAX_CANDIDATES){
     const old=previous.get(c.id);merged.set(c.id,{...c,countryCode:old?.countryCode||c.countryCode||'',countrySource:old?.countrySource||c.countrySource||''});
    }
   }
   this.entries=merged;this.latencies=Object.fromEntries(Object.entries(this.latencies).filter(([id])=>merged.has(id)));
   for(const id of this.prepared.keys())if(!merged.has(id))this.prepared.delete(id);
   this.fetchedAt=Date.now();this.stale=false;return true;
  };
  const announce=(force=false)=>{
   if(this.closed)return;
   const now=Date.now();if(!force&&now-lastEmit<250)return;
   lastEmit=now;merge();this.note=`بررسی کانال‌های وب: ${finished.toLocaleString('fa-IR')} از ${CHANNELS.length.toLocaleString('fa-IR')}؛ DNS فید جداگانه بررسی می‌شود.`;this.emit();
  };
  let next=0;
  const worker=async()=>{
   while(!signal.aborted&&!this.closed){
    const i=next++;if(i>=CHANNELS.length)break;
    try{const items=await this.fetchTelegram(CHANNELS[i],{signal});groups[i]={items:Array.isArray(items)?items:[]};}
    catch{groups[i]={items:[]};unavailable++;}
    finished++;announce(finished===1);
   }
  };
  const dnsJob=Promise.resolve().then(()=>this.closed?[]:this.dns.fetch()).catch(()=>[]).then(items=>{dnsItems=Array.isArray(items)?items:[];announce(true);});
  await Promise.all(Array.from({length:Math.min(WEB_CONCURRENCY,CHANNELS.length)},worker));
  if(this.closed)return;announce(true);await dnsJob;if(this.closed)return;merge();
  if(hadFresh){
   this.note=dnsItems.length?`کانال‌های وب و کانال‌های موجود در DNS فید بررسی شدند${unavailable?'؛ برخی منابع وب در دسترس نبودند.':'.'}`:(unavailable?'بعضی کانال‌های وب یا DNS فید در دسترس نبودند؛ فهرست ممکن است ناقص باشد.':'کانال‌های وب بررسی شدند؛ DNS فید موردی برنگرداند.');
   await this.persist();
  }else{this.stale=true;this.note=this.entries.size?'دریافت تازه ناموفق بود؛ موارد ذخیره‌شده پس از آزمون نمایش داده می‌شوند.':'کانال‌ها و فید در دسترس نیستند؛ DNS فعال فید را بررسی کن و دوباره تلاش کن.';}
 }
 async stop(){this.closed=true;this.aborter?.abort();await this.dns.stop();await this.saveQueue.catch(()=>{});}
}
module.exports={CHANNELS,MAX_ENTRIES,MAX_CANDIDATES,WEB_CONCURRENCY,ConfigSources,DnsFeedSource,telegram,localRequest,limitedText};
