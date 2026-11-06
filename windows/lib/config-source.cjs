'use strict';
// Public Telegram posts and the official DNS feed, kept as data, never code.
const fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http');
const {ThefeedController,WINDOWS_SHA256,RELEASE,inspectCore}=require('./thefeed.cjs');
const {ThefeedUpdater}=require('./thefeed-updater.cjs');
const {validateOfficialResolvers}=require('./thefeed-resolvers.cjs');
const {extractLinks,parseLink,publicEntry}=require('./config-links.cjs');
const CHANNELS=Object.freeze(['PrivateVPNs','persianvpnhub','Ln2Ray','emergencyconfigs','FreeNPV','ircfspace']);
const MAX_ENTRIES=500,MAX_DNS_CHANNELS=20;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
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
 constructor({executable,dataDir,expectedHash=WINDOWS_SHA256,updater=null,sharedController=null}){
  this.controller=new ThefeedController({executable,dataDir,expectedHash,updater});
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
  await Promise.all(selected.map(c=>localRequest(e,'/api/refresh?channel='+c.index,'POST',undefined,5000).catch(()=>null)));
  let result=[],firstResultAt=0;
  while(Date.now()<deadline&&!this.closed){
   const pages=await Promise.all(selected.map(async c=>({name:c.name,data:await localRequest(e,'/api/messages/'+c.index).catch(()=>null)})));
   result=[];for(const page of pages)for(const message of page.data?.messages||[])result.push(...extractLinks(String(message?.Text||message?.text||''),'@'+page.name+' · DNS/فید'));
   if(result.length&&!firstResultAt)firstResultAt=Date.now();
   if(firstResultAt&&(new Set(result.map(x=>x.source)).size>=4||Date.now()-firstResultAt>=10000))break;
   await pause(1500);
  }
  this.check();return result.slice(0,MAX_ENTRIES);
 }
 async stop(){this.closed=true;await this.controller.stop();}
}
class ConfigSources {
 constructor({app,binDir,onChange=()=>{},fetchTelegram=telegram,dnsSource=null,sharedController=null}){
  this.file=path.join(app.getPath('userData'),'public-configs.json');this.onChange=onChange;this.fetchTelegram=fetchTelegram;
  this.entries=new Map();this.latencies={};this.busy=null;this.saveQueue=Promise.resolve();this.closed=false;this.aborter=null;this.fetchedAt=null;this.stale=false;this.note='';
  const dev=!app.isPackaged&&process.platform!=='win32'&&process.env.LML_FEED_DEV_BIN;
  const updater=app.isPackaged&&process.platform==='win32'?new ThefeedUpdater({directory:path.join(app.getPath('userData'),'thefeed-core-updates'),bundledVersion:RELEASE,validateBinary:(file,version,signal)=>inspectCore(file,{expectedVersion:version,checkUI:true,cancelled:()=>signal.aborted})}):null;
  this.dns=dnsSource||new DnsFeedSource({executable:dev||path.join(binDir(),'thefeed-client.exe'),dataDir:path.join(app.getPath('userData'),'thefeed-config-source'),expectedHash:dev?null:WINDOWS_SHA256,updater,sharedController});
 }
 snapshot(){return {items:[...this.entries.values()].slice(0,MAX_ENTRIES).map(c=>({...publicEntry(c),latency:this.latencies[c.id]??null})),fetchedAt:this.fetchedAt,stale:this.stale,note:this.note,refreshing:!!this.busy};}
 emit(){this.onChange(this.snapshot());}
 async load(){
  try{
   const stat=await fs.stat(this.file);if(stat.size>6_000_000)return;
   const saved=JSON.parse(await fs.readFile(this.file,'utf8'));if(!Array.isArray(saved.links)||!Number.isFinite(saved.fetchedAt))return;
   for(const item of saved.links.slice(0,MAX_ENTRIES)){try{if(item.source==='ورودی دستی')continue;const c=parseLink(item.raw);c.source=String(item.source||'ذخیره‌شده').slice(0,100);this.entries.set(c.id,c);}catch{}}
   this.fetchedAt=saved.fetchedAt;this.stale=true;this.note='فهرست ذخیره‌شده است؛ برای دریافت موارد تازه به‌روزرسانی را بزن.';
  }catch{}
 }
 persist(){
  const contents=JSON.stringify({fetchedAt:this.fetchedAt,links:[...this.entries.values()].slice(0,MAX_ENTRIES).map(c=>({raw:c.raw,source:c.source}))});
  this.saveQueue=this.saveQueue.catch(()=>{}).then(async()=>{await fs.mkdir(path.dirname(this.file),{recursive:true});const tmp=this.file+'.tmp';await fs.writeFile(tmp,contents,{mode:0o600});await fs.rename(tmp,this.file);});return this.saveQueue;
 }
 get(id){return this.entries.get(id)||null;}
 setLatency(id,ms){if(this.entries.has(id)){this.latencies[id]=Number.isFinite(ms)?Math.round(ms):-1;this.emit();}}
 refresh(){
  if(this.closed)return Promise.reject(new Error('بخش کانفیگ بسته شده است.'));if(this.busy)return this.busy;
  this.aborter=new AbortController();const core=this._refresh(this.aborter.signal);let job;
  job=core.finally(()=>{if(this.busy===job)this.busy=null;this.aborter=null;this.emit();}).then(()=>this.snapshot());
  this.busy=job;this.note='در حال دریافت از کانال‌ها و DNS فید…';this.emit();return job;
 }
 async _refresh(signal){
  // Both sources run concurrently: DNS never waits for a blocked Telegram web request.
  const dnsJob=Promise.resolve().then(()=>this.closed?[]:this.dns.fetch()).catch(()=>[]);
  const results=await Promise.all(CHANNELS.map(async name=>{try{return {name,items:await this.fetchTelegram(name,{signal}),ok:true};}catch{return {name,items:[],ok:false};}}));
  if(this.closed)return;const direct=results.flatMap(r=>r.items),unavailable=results.filter(r=>!r.ok).length;
  if(direct.length){this.entries=new Map(direct.slice(0,MAX_ENTRIES).map(c=>[c.id,c]));this.latencies={};this.fetchedAt=Date.now();this.stale=false;this.note='کانال‌های وب دریافت شد؛ فید DNS در حال بررسی است.';this.emit();}
  const dns=await dnsJob;if(this.closed)return;
  if(dns.length){
   // Interleave routes so a huge web response cannot crowd all DNS-only
   // entries out of the bounded list. Preserve the true source of each item.
   const merged=new Map();
   const insert=(c,viaDns)=>{const existing=merged.get(c.id);if(existing){if(viaDns&&!existing.source.includes('DNS/فید'))existing.source+=' + DNS/فید';}else if(merged.size<MAX_ENTRIES)merged.set(c.id,c);};
   for(let i=0;i<Math.max(direct.length,dns.length);i++){if(direct[i])insert(direct[i],false);if(dns[i])insert(dns[i],true);}
   this.entries=merged;this.latencies=Object.fromEntries(Object.entries(this.latencies).filter(([id])=>merged.has(id)));
  }
  if(direct.length||dns.length){
   this.fetchedAt=Date.now();this.stale=false;
   this.note=dns.length?`فهرست از کانال‌ها و DNS فید دریافت شد${unavailable?'؛ بعضی کانال‌های وب در دسترس نبودند.':'.'}`:(unavailable?'بعضی کانال‌ها و فید DNS در دسترس نبودند؛ فهرست ممکن است ناقص باشد.':'کانال‌های وب دریافت شدند؛ فید DNS پاسخی نداد.');
   await this.persist();
  }else{this.stale=true;this.note=this.entries.size?'دریافت ناموفق بود؛ فهرست ذخیره‌شده نمایش داده می‌شود.':'کانال‌ها و فید در دسترس نیستند؛ DNS فعال فید را بررسی کن و دوباره تلاش کن.';}
 }
 async stop(){this.closed=true;this.aborter?.abort();await this.dns.stop();await this.saveQueue.catch(()=>{});}
}
module.exports={CHANNELS,MAX_ENTRIES,ConfigSources,DnsFeedSource,telegram,localRequest,limitedText};
