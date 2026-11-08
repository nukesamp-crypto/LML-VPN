'use strict';
// Public Telegram posts via the bundled official TheFeed TeleMirror; data, never code.
const fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http'),https=require('node:https'),tls=require('node:tls');
const {ThefeedController,WINDOWS_SHA256}=require('./thefeed.cjs');
const dns=require('node:dns/promises'),net=require('node:net');
const {GeoCountry,flagFromRemark}=require('./country.cjs');
const {validateOfficialResolvers}=require('./thefeed-resolvers.cjs');
const {extractLinks,parseLink,publicEntry}=require('./config-links.cjs');
const CHANNELS=require('./telegram-channels.cjs');
// Unverified candidates stay private; only a successful HTTPS test can enter the
// public list. Scan more candidates than the 1,000-result display target.
const MAX_ENTRIES=1000,MAX_CANDIDATES=6000,MAX_DNS_CHANNELS=200,WEB_CONCURRENCY=1,MAX_HIDDEN=10000;
// Reserve room for every channel while acquisition is in progress. If capacity
// remains after all sources have finished, take more in fair round-robin order.
const MAX_CACHED_AT_START=1000,WEB_FIRST=10,WEB_PER_CHANNEL=50,MERGE_STEP=100;
const GOOGLE_HOST='www.google.com',GOOGLE_MIRROR='t-me.translate.goog';
// A fixed allowlist of Google-owned edges and Google-operated TLS names. IP
// routes avoid a poisoned system DNS response; every route still validates
// Google's certificate for its explicit SNI and asks Google's Translate host.
const GOOGLE_ROUTES=Object.freeze({
 fronted:Object.freeze({hostname:'www.google.com',servername:'www.google.com'}),
 edge38:Object.freeze({hostname:'216.239.38.120',servername:'www.google.com'}),
 edge32:Object.freeze({hostname:'216.239.32.120',servername:'www.google.com'}),
 edge34:Object.freeze({hostname:'216.239.34.120',servername:'www.google.com'}),
 edge36:Object.freeze({hostname:'216.239.36.120',servername:'www.google.com'}),
 maps:Object.freeze({hostname:'maps.google.com',servername:'maps.google.com'}),
 edgeMaps:Object.freeze({hostname:'216.239.38.120',servername:'maps.google.com'}),
 mail:Object.freeze({hostname:'mail.google.com',servername:'mail.google.com'}),
 edgeMail:Object.freeze({hostname:'216.239.38.120',servername:'mail.google.com'}),
 translate:Object.freeze({hostname:'t-me.translate.goog',servername:'t-me.translate.goog'})
});
const GOOGLE_QUERY='?_x_tr_sl=auto&_x_tr_tl=en&_x_tr_hl=en&_x_tr_pto=wapp';
// Wake DNS polling immediately when a user stops a scan.
function pause(ms,signal){return new Promise(resolve=>{
 if(signal?.aborted)return resolve();let done=false;const finish=()=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',finish);resolve();};
 const timer=setTimeout(finish,ms);signal?.addEventListener('abort',finish,{once:true});
});}
async function mapLimited(list,limit,fn,signal){
 const values=Array(list.length);let next=0;
 await Promise.all(Array.from({length:Math.min(limit,list.length)},async()=>{while(!signal?.aborted){const i=next++;if(i>=list.length)break;values[i]=await fn(list[i],i);}}));
 return values;
}
function localRequest(endpoint,route,method='GET',body,timeout=5000,signal){
 return new Promise((resolve,reject)=>{
  const data=body===undefined?null:Buffer.from(JSON.stringify(body));
  const headers={Authorization:'Basic '+Buffer.from('lml:'+endpoint.secret).toString('base64')};
  if(data){headers['Content-Type']='application/json';headers['Content-Length']=data.length;}
  const req=http.request({host:'127.0.0.1',port:endpoint.port,path:route,method,headers,timeout,signal},res=>{
   const chunks=[];let size=0;res.on('data',b=>{size+=b.length;if(size>5_000_000)req.destroy(new Error('response too large'));else chunks.push(b);});
   res.on('error',reject);res.on('end',()=>{if(res.statusCode!==200)return reject(new Error('local API '+res.statusCode));try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(new Error('invalid local API'));}});
  });req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('local API timeout')));req.end(data);
 });
}
// Connect only to Google-operated HTTPS hosts. The fronted route authenticates
// www.google.com and asks Google's edge for t-me.translate.goog via Host; the
// direct Translate-host route is an independent fallback. There is no request
// from the user's device to t.me, other collectors or third-party mirrors.
function googleTelegram(channel,{signal,route='fronted',timeoutMs=12000,request=https.request}={}){
 if(!CHANNELS.includes(channel))return Promise.reject(new Error('unknown source'));
 if(!Object.hasOwn(GOOGLE_ROUTES,route))return Promise.reject(new Error('unknown Google route'));
 if(signal?.aborted)return Promise.reject(new Error('جست‌وجو متوقف شد.'));
 const {hostname,servername}=GOOGLE_ROUTES[route];
 const routePath='/s/'+encodeURIComponent(channel)+GOOGLE_QUERY,max=3_000_000;
 const delay=Math.max(1,Math.min(12000,Number(timeoutMs)||12000));
 return new Promise((resolve,reject)=>{
  let done=false,req=null;const chunks=[];let size=0;
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);if(error){try{req?.destroy();}catch{}reject(error);}else resolve(value);};
  const timer=setTimeout(()=>{const e=Object.assign(new Error('Google mirror timeout'),{code:'ETIMEDOUT'});try{req?.destroy(e);}catch{}finish(e);},delay);
  try{
   req=request({hostname,servername,port:443,path:routePath,method:'GET',signal,rejectUnauthorized:true,checkServerIdentity:(_name,cert)=>tls.checkServerIdentity(servername,cert),
    headers:{Host:GOOGLE_MIRROR,'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36','Accept':'text/html,application/xhtml+xml','Accept-Encoding':'identity','Referer':'https://www.google.com/'}},res=>{
     res.once('error',finish);res.once('aborted',()=>finish(new Error('Google mirror response interrupted')));
     // Never follow a redirect to Telegram or an arbitrary origin. A failed
     // Google route can instead be retried on the other fixed Google host.
     if(res.statusCode!==200)return finish(Object.assign(new Error('Google mirror HTTP '+res.statusCode),{code:'HTTP_'+res.statusCode}));
     if(Number(res.headers?.['content-length']||0)>max)return finish(new Error('Google mirror response too large'));
     res.on('data',b=>{size+=b.length;if(size>max)finish(new Error('Google mirror response too large'));else chunks.push(Buffer.from(b));});
     res.once('end',()=>{
      const text=Buffer.concat(chunks).toString('utf8');
      // Captcha, rate-limit, or generic Google pages are not channel results.
      if(!/tgme_/i.test(text))return finish(Object.assign(new Error('Google mirror did not return a Telegram page'),{code:'MIRROR_CONTENT'}));
      try{finish(null,extractLinks(text,'@'+channel+' · Google'));}catch(e){finish(e);}
     });
    });
   req.once('error',finish);req.end();
  }catch(e){finish(e);}
 });
}

// Only fixed categories are exposed; never show an exception containing a URL,
// proxy credential, private address, config or other local/network data.
function googleErrorHint(error){
 const code=String(error?.code||'').toUpperCase();
 if(code==='ETIMEDOUT'||code==='ESOCKETTIMEDOUT'||code.includes('TIMEOUT'))return 'اتصال به آینهٔ گوگل به پایان زمان انتظار رسید';
 if(code==='ENOTFOUND'||code==='EAI_AGAIN')return 'نام گوگل از DNS پیدا نشد';
 if(code.includes('CERT')||code.includes('ISSUER')||code.includes('SELF_SIGNED'))return 'گواهی HTTPS گوگل تأیید نشد؛ تاریخ ویندوز و شبکه را بررسی کن';
 if(code==='HTTP_429')return 'گوگل تعداد درخواست‌ها را محدود کرده است (۴۲۹)';
 if(/^HTTP_\d{3}$/.test(code))return 'آینهٔ گوگل پاسخ HTTP '+code.slice(5)+' داد';
 if(code==='MIRROR_CONTENT')return 'پاسخ گوگل محتوای قابل‌خواندن کانال نداشت';
 if(['ECONNRESET','ECONNREFUSED','EHOSTUNREACH','ENETUNREACH','EPIPE','EPROTO'].includes(code))return 'اتصال امن به گوگل قطع شد یا در دسترس نبود';
 return 'ارتباط امن با مسیر گوگل برقرار نشد';
}

class DnsFeedSource {
 constructor({executable,dataDir,expectedHash=WINDOWS_SHA256,sharedController=null}){
  this.controller=new ThefeedController({executable,dataDir,expectedHash});
  this.sharedController=sharedController;this.busy=null;this.closed=false;this.usingShared=false;this.aborter=null;
 }
 check(signal){if(this.closed||signal?.aborted)throw new Error('دریافت فید متوقف شد.');}
 async useSharedResolvers(endpoint,signal){
  this.usingShared=false;if(!this.sharedController)return false;
  try{
   // Read only the live DNS list from the user's actual feed. Never change its
   // active profile, list, bank, scores, or resolver files.
   // Never start or stop the user's TheFeed just to scan configs. Reuse its
   // resolver list only when its own process is already running.
   const shared=this.sharedController.endpoint;if(!shared)return false;this.check(signal);
   const active=await localRequest(shared,'/api/resolvers/active','GET',undefined,5000,signal);this.check(signal);
   if(!Array.isArray(active?.resolvers)||!active.resolvers.length)return false;
   const resolvers=validateOfficialResolvers(active.resolvers.slice(0,100));
   const lists=await localRequest(endpoint,'/api/resolvers/lists?include=resolvers','GET',undefined,5000,signal);this.check(signal);
   const name='LML shared DNS',old=(lists.lists||[]).find(x=>x.name===name);
   if(!old)await localRequest(endpoint,'/api/resolvers/lists','POST',{name,resolvers},5000,signal);
   else {
    const previous=Array.isArray(old.resolvers)?old.resolvers:[];
    const remove=previous.filter(x=>!resolvers.includes(x)),add=resolvers.filter(x=>!previous.includes(x));
    if(remove.length)await localRequest(endpoint,'/api/resolvers/lists/remove','POST',{name,resolvers:remove},5000,signal);
    if(add.length)await localRequest(endpoint,'/api/resolvers/lists/add','POST',{name,resolvers:add},5000,signal);
   }
   this.check(signal);await localRequest(endpoint,'/api/resolvers/lists/select','POST',{name,noScan:true},5000,signal);
   this.usingShared=true;return true;
  }catch{this.check(signal);return false;}
 }
 async init(signal){
  this.check(signal);const e=await this.controller.start();this.check(signal);
  const defaults=await localRequest(e,'/api/profiles/defaults','GET',undefined,5000,signal);
  const d=(defaults.profiles||[]).find(p=>typeof p?.nickname==='string'&&p.nickname.includes('فیلترشکن'))||(defaults.profiles||[]).find(p=>/^cfg\./i.test(p?.domain||''));
  if(!d||!d.domain||!d.key)throw new Error('config feed preset unavailable');
  const p=await localRequest(e,'/api/profiles','GET',undefined,5000,signal);this.check(signal);const profiles=Array.isArray(p.profiles)?p.profiles:[];
  const current=profiles.find(x=>x?.config?.domain===d.domain);
  if(!current)await localRequest(e,'/api/profiles','POST',{action:'create',profile:{id:'',nickname:d.nickname||d.domain,config:{domain:d.domain,key:d.key,serverKey:d.serverKey||'',extraDomains:d.extraDomains||[],queryMode:'single',rateLimit:6}},skipCheck:true},10000,signal);
  else if(p.active!==current.id)await localRequest(e,'/api/profiles/switch','POST',{id:current.id,skipCheck:true},10000,signal);
  this.check(signal);const shared=await this.useSharedResolvers(e,signal);this.check(signal);
  if(!shared){
   const active=await localRequest(e,'/api/resolvers/active','GET',undefined,5000,signal).catch(()=>null);this.check(signal);
   if(!Array.isArray(active?.resolvers)||!active.resolvers.length)await localRequest(e,'/api/rescan','POST',undefined,4000,signal).catch(()=>{});this.check(signal);
  }
  return e;
 }
 fetch({signal}={}){
  if(this.closed)return Promise.reject(new Error('دریافت فید متوقف شد.'));
  if(this.busy)return this.busy;
  const aborter=new AbortController(),forward=()=>aborter.abort();this.aborter=aborter;
  if(signal?.aborted)aborter.abort();else signal?.addEventListener('abort',forward,{once:true});
  let job;job=this._fetch(aborter.signal).finally(async()=>{
   signal?.removeEventListener('abort',forward);
   // Its private TheFeed must not continue background DNS work once this
   // on-demand search finishes. The user's shared TheFeed is never stopped.
   await this.controller.stop().catch(()=>{});
   if(this.busy===job)this.busy=null;if(this.aborter===aborter)this.aborter=null;
  });this.busy=job;return job;
 }
 async _fetch(signal){
  const e=await this.init(signal),deadline=Date.now()+55000;this.check(signal);let channels=[];
  while(Date.now()<deadline&&!this.closed&&!signal?.aborted){
   const list=await localRequest(e,'/api/channels','GET',undefined,5000,signal).catch(()=>null);channels=Array.isArray(list)?list:[];
   if(channels.length)break;await pause(1500,signal);
  }
  this.check(signal);if(!channels.length)return [];
  // Explicit previous channels take priority; additional channels come only
  // from the official config-feed profile. Keep their true names and indices.
  const indexed=channels.map((c,i)=>({name:String(c?.Name||c?.name||'').slice(0,60),index:i+1})).filter(c=>c.name&&!/[\x00-\x1f]/.test(c.name));
  const priority=indexed.filter(c=>CHANNELS.some(x=>x.toLowerCase()===c.name.toLowerCase()));
  const selected=[...priority,...indexed.filter(c=>!priority.includes(c))].slice(0,MAX_DNS_CHANNELS);
  await mapLimited(selected,10,c=>localRequest(e,'/api/refresh?channel='+c.index,'POST',undefined,5000,signal).catch(()=>null),signal);this.check(signal);
  let result=[],firstResultAt=0;
  while(Date.now()<deadline&&!this.closed&&!signal?.aborted){
   const buckets=await mapLimited(selected,10,async c=>{
    const data=await localRequest(e,'/api/messages/'+c.index,'GET',undefined,5000,signal).catch(()=>null),items=[];
    const messages=Array.isArray(data?.messages)?data.messages:[];
    for(const message of messages){items.push(...extractLinks(String(message?.Text||message?.text||''),'@'+c.name+' · DNS/فید'));if(items.length>=100)break;}
    return items.slice(0,100);
   },signal);this.check(signal);
   result=[];const longest=Math.max(0,...buckets.map(b=>b.length));
   for(let i=0;i<longest&&result.length<MAX_CANDIDATES;i++)for(const bucket of buckets)if(bucket[i]&&result.length<MAX_CANDIDATES)result.push(bucket[i]);
   if(result.length&&!firstResultAt)firstResultAt=Date.now();
   if(firstResultAt&&(new Set(result.map(x=>x.source)).size>=Math.min(10,selected.length)||Date.now()-firstResultAt>=10000))break;
   await pause(1500,signal);
  }
  this.check(signal);return result.slice(0,MAX_CANDIDATES);
 }
 async cancel(){
  const job=this.busy;this.aborter?.abort();await this.controller.stop();if(job)await job.catch(()=>{});
 }
 async stop(){this.closed=true;await this.cancel();}
}
// Use the *actual* bundled TheFeed v0.41.0 Mirror API, not the DNS Feed and
// not a separate JavaScript reimplementation of Google fronting. TheFeed's
// mirror fetches public Telegram widgets through Google's Translate proxy.
// The process has a private data directory: scanning does not add/remove the
// user's channels, touch their TheFeed profile, or stop their open TheFeed UI.
// This isolation also lets Stop kill a stuck upstream request: TheFeed's own
// handler intentionally continues fetching after an HTTP caller disconnects.
class TeleMirrorSource {
 constructor({executable,dataDir,expectedHash=WINDOWS_SHA256,controller=null}){
  this.controller=controller||new ThefeedController({executable,dataDir,expectedHash});
  this.closed=false;this.stopping=null;this.dataDir=dataDir;
 }
 async start(signal){
  if(this.closed||signal?.aborted)throw new Error('دریافت میرور متوقف شد.');
  const endpoint=await this.controller.start();
  if(this.closed||signal?.aborted)throw new Error('دریافت میرور متوقف شد.');
  return endpoint;
 }
 async fetch(channel,{signal}={}){
  if(!CHANNELS.includes(channel))throw new Error('unknown channel');
  const endpoint=await this.start(signal);
  // Only a short-lived cache written by this private TheFeed process is read.
  // A repeated search within five minutes avoids another network download.
  // Remove older cache files *before* asking the API: TheFeed otherwise serves
  // stale posts after 15s while refreshing in the background, which would
  // overlap the next channel. The user's own Mirror cache is not touched.
  const cacheFile=path.join(this.dataDir,'telemirror',channel.toLowerCase()+'.json');
  let result=null,hasFile=false;
  try{
   const stat=await fs.stat(cacheFile);hasFile=true;
   if(stat.size<=5_000_000){
    const cached=JSON.parse(await fs.readFile(cacheFile,'utf8'));
    const age=Date.now()-Date.parse(cached?.fetchedAt||'');
    if(age>=-30000&&age<=300000&&cached?.channel&&Array.isArray(cached.posts))result=cached;
   }
  }catch(error){if(error?.code!=='ENOENT'&&!hasFile)throw error;}
  if(!result&&hasFile)await fs.unlink(cacheFile).catch(e=>{if(e?.code!=='ENOENT')throw e;});
  if(!result){
   // This headless process is used only for config text. Prime its PRIVATE
   // avatar cache with a tiny transparent image so TheFeed does not download
   // hundreds of channel avatars that the config screen never displays.
   // It never touches the user's ordinary TheFeed image or channel cache.
   try{
    const images=path.join(this.dataDir,'telemirror','images'),key=channel.toLowerCase();
    await fs.mkdir(images,{recursive:true});
    const pixel=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR/0AAAAASUVORK5CYII=','base64');
    await fs.writeFile(path.join(images,key+'.bin'),pixel,{mode:0o600});
    await fs.writeFile(path.join(images,key+'.json'),JSON.stringify({url:key,contentType:'image/png',storedAt:new Date().toISOString()}),{mode:0o600});
   }catch{} // Avatar optimisation is optional; never break Mirror text.
   if(signal?.aborted||this.closed)throw new Error('دریافت میرور متوقف شد.');
   // On a cache miss the official client can try multiple TLS fingerprints
   // for up to three minutes. Let it finish; never overlap channel calls.
   try{result=await localRequest(endpoint,'/api/telemirror/channel/'+encodeURIComponent(channel)+'?refresh=1','GET',undefined,190000,signal);}
   catch(error){
    const msg=String(error?.message||'');
    if(msg==='local API 404')throw Object.assign(new Error('channel unavailable'),{code:'MIRROR_NOT_FOUND'});
    if(msg==='local API 502')throw Object.assign(new Error('mirror upstream unavailable'),{code:'MIRROR_UPSTREAM'});
    if(msg==='local API timeout')throw Object.assign(new Error('mirror timeout'),{code:'MIRROR_TIMEOUT'});
    throw error;
   }
  }
  if(signal?.aborted||this.closed)throw new Error('دریافت میرور متوقف شد.');
  if(!result||!result.channel||!Array.isArray(result.posts))throw Object.assign(new Error('invalid mirror response'),{code:'MIRROR_CONTENT'});
  const out=new Map();
  for(const post of result.posts.slice(0,200)){
   if(typeof post?.text!=='string')continue;
   for(const candidate of extractLinks(post.text,'@'+channel+' · Google')){
    if(!out.has(candidate.id))out.set(candidate.id,candidate);
    if(out.size>=WEB_PER_CHANNEL)break;
   }
   if(out.size>=WEB_PER_CHANNEL)break;
  }
  return [...out.values()];
 }
 async cancel(){
  if(this.stopping)return this.stopping;
  const job=Promise.resolve().then(()=>this.controller.stop()).finally(()=>{if(this.stopping===job)this.stopping=null;});
  this.stopping=job;return job;
 }
 async stop(){this.closed=true;await this.cancel();}
}
function mirrorErrorHint(error){
 switch(String(error?.code||'')){
  case 'MIRROR_NOT_FOUND':return 'کانال پیدا نشد یا خصوصی است';
  case 'MIRROR_UPSTREAM':return 'میرور TheFeed نتوانست کانال را دریافت کند';
  case 'MIRROR_TIMEOUT':return 'زمان انتظار میرور TheFeed تمام شد';
  case 'MIRROR_CONTENT':return 'پاسخ میرور TheFeed قابل‌خواندن نبود';
  default:return 'دریافت کانال از میرور TheFeed ممکن نشد';
 }
}

class ConfigSources {
 constructor({app,binDir,onChange=()=>{},fetchTelegram=null,mirrorSource=null,geo=null,resolveHost=null}){
  // Do not present earlier independent Google/DNS caches as TheFeed results.
  // Keep them intact; this cache contains only data returned by TeleMirror.
  const dir=app.getPath('userData');this.file=path.join(dir,'thefeed-mirror-google-configs.json');this.onChange=onChange;
  const dev=!app.isPackaged&&process.platform!=='win32'&&process.env.LML_FEED_DEV_BIN;
  this.mirror=mirrorSource||(!fetchTelegram?new TeleMirrorSource({executable:dev||path.join(binDir(),'thefeed-client.exe'),dataDir:path.join(dir,'thefeed-config-mirror'),expectedHash:dev?null:WINDOWS_SHA256}):null);
  this.fetchTelegram=fetchTelegram||((channel,opts)=>this.mirror.fetch(channel,opts));
  this.entries=new Map();this.latencies={};this.prepared=new Map();this.hidden=new Set();this.busy=null;this.saveQueue=Promise.resolve();this.closed=false;this.aborter=null;this.fetchedAt=null;this.stale=false;this.note='';
  this.geo=geo||new GeoCountry(path.join(binDir(),'geoip.dat'));
  this.resolveHost=resolveHost||(async host=>(await dns.lookup(host,{family:4})).address);
  this.hostCountries=new Map();this.emitTimer=null;this.scan=null;this.nextScanId=0;this.revision=0;
 }
 snapshot(){
  const tested=[...this.entries.values()].filter(c=>this.prepared.has(c.id)&&Number.isFinite(this.latencies[c.id])&&this.latencies[c.id]>=0);
  tested.sort((a,b)=>this.latencies[a.id]-this.latencies[b.id]||a.id.localeCompare(b.id));
  const scan=this.scan&&{id:this.scan.id,active:this.scan.active,channelsDone:this.scan.channelsDone,channelsTotal:CHANNELS.length,errors:this.scan.errors,found:this.scan.seen.size,tested:this.scan.tested.size,skipped:this.scan.skipped.size,stopped:this.scan.stopped};
  return {items:tested.slice(0,MAX_ENTRIES).map(c=>({...publicEntry(c),source:'Google',countryCode:c.countryCode||flagFromRemark(c.remark),countrySource:c.countrySource||(flagFromRemark(c.remark)?'label':''),latency:this.latencies[c.id]})),candidateCount:this.entries.size,failedCount:Object.values(this.latencies).filter(ms=>ms===-1).length,fetchedAt:this.fetchedAt,stale:this.stale,note:this.note,refreshing:!!this.busy,hiddenCount:this.hidden.size,scan,revision:++this.revision};
 }
 // Candidate identities never leave the main process until a real HTTPS test
 // succeeds. On reload no previous test result is trusted as current.
 pendingIds(){
  const ids=[...this.entries.keys()].filter(id=>!Object.hasOwn(this.latencies,id));
  if(!this.scan?.active)return ids;
  // Cached links may be stale; allow freshly received Telegram candidates to
  // enter the next small batch instead of waiting behind 1,000 old results.
  return [...ids.filter(id=>!this.scan.cached.has(id)),...ids.filter(id=>this.scan.cached.has(id))];
 }
 getUsable(id){
  const c=this.entries.get(id),ms=this.latencies[id];
  const pinned=this.prepared.get(id);
  if(!c||!pinned||!Number.isFinite(ms)||ms<0)return null;
  return {...c,address:pinned.address,transport:{...pinned.transport}};
 }
 emit(){if(this.emitTimer){clearTimeout(this.emitTimer);this.emitTimer=null;}this.onChange(this.snapshot());}
 // Coalesce the expensive 1,000-item sort/serialization, not just the IPC.
 emitSoon(){if(this.closed||this.emitTimer)return;this.emitTimer=setTimeout(()=>{this.emitTimer=null;if(!this.closed)this.emit();},250);this.emitTimer.unref?.();}
 async load(){
  try{
   const stat=await fs.stat(this.file);if(stat.size>50_000_000)return;
   const saved=JSON.parse(await fs.readFile(this.file,'utf8'));if(saved.source!=='thefeed-google-mirror-v1'||!Array.isArray(saved.links)||!Number.isFinite(saved.fetchedAt))return;
   this.hidden=new Set((Array.isArray(saved.hidden)?saved.hidden:[]).filter(id=>typeof id==='string'&&/^[a-f0-9]{24}$/.test(id)).slice(-MAX_HIDDEN));
   for(const item of saved.links.slice(0,MAX_CANDIDATES)){try{const m=typeof item.source==='string'&&item.source.match(/^@([A-Za-z0-9_]+) · Google$/);if(!m||!CHANNELS.includes(m[1]))continue;const c=parseLink(item.raw);c.source=item.source;if(!this.hidden.has(c.id))this.entries.set(c.id,c);}catch{}}
   this.fetchedAt=saved.fetchedAt;this.stale=true;this.note='موارد ذخیره‌شده پیش از نمایش دوباره آزمایش می‌شوند.';
  }catch{}
 }
 persist(){
  const contents=JSON.stringify({source:'thefeed-google-mirror-v1',fetchedAt:this.fetchedAt||Date.now(),hidden:[...this.hidden].slice(-MAX_HIDDEN),links:[...this.entries.values()].slice(0,MAX_CANDIDATES).map(c=>({raw:c.raw,source:c.source}))});
  this.saveQueue=this.saveQueue.catch(()=>{}).then(async()=>{await fs.mkdir(path.dirname(this.file),{recursive:true});const tmp=this.file+'.tmp';await fs.writeFile(tmp,contents,{mode:0o600});await fs.rename(tmp,this.file);});return this.saveQueue;
 }
 get(id){return this.entries.get(id)||null;}
 setLatency(id,ms,prepared=null){
  if(!this.entries.has(id))return;
  // A connection completing after a refresh may report its old latency after
  // the refresh discarded its pin. Never turn that into an unpinned success.
  if(Number.isFinite(ms)&&ms>=0&&!prepared&&!this.prepared.has(id))return;
  this.latencies[id]=Number.isFinite(ms)&&ms>=0?Math.max(1,Math.round(ms)):-1;
  if(this.scan?.active&&this.scan.seen.has(id))this.scan.tested.add(id);
  if(this.latencies[id]<0)this.prepared.delete(id);else if(prepared)this.prepared.set(id,{address:prepared.address,transport:{...prepared.transport}});
  this.emitSoon();
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
    if(code&&this.entries.get(id)===c){c.countryCode=code;c.countrySource='ip';this.emitSoon();}return;
   }
   const code=await this.geo.lookup(host);
   if(code&&this.entries.get(id)===c){c.countryCode=code;c.countrySource='ip';this.emitSoon();}
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
  if(this.scan?.active&&this.scan.seen.has(id)&&!this.scan.tested.has(id))this.scan.skipped.add(id);
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
  // Start with at most the previous 1,000 displayable entries, preferring
  // verified ones. This leaves space for fresh Google-mirrored candidates; old pings
  // are never trusted as current. The count is reset only for a new search.
  if(this.entries.size>MAX_CACHED_AT_START){
   const all=[...this.entries],good=all.filter(([id])=>this.prepared.has(id)&&this.latencies[id]>=0),rest=all.filter(([id])=>!(this.prepared.has(id)&&this.latencies[id]>=0));
   this.entries=new Map([...good,...rest].slice(0,MAX_CACHED_AT_START));
  }
  this.latencies={};this.prepared.clear();
  this.scan={id:++this.nextScanId,active:true,channelsDone:0,errors:0,seen:new Set(this.entries.keys()),cached:new Set(this.entries.keys()),tested:new Set(),skipped:new Set(),stopped:false};
  this.aborter=new AbortController();const core=this._refresh(this.aborter.signal).finally(()=>this.mirror?.cancel().catch(()=>{}));let job;
  job=core.finally(()=>{if(this.busy===job)this.busy=null;this.aborter=null;this.emit();}).then(()=>this.snapshot());
  this.busy=job;this.note='در حال آماده‌سازی میرور خود TheFeed و بررسی ۴۰۰ کانال عمومی از طریق Google…';this.emit();return job;
 }
 // The automatic tester can finish after acquisition; keep cumulative counts
 // for the entire user-started search, not one internal batch at a time.
 finishScan(){if(this.scan)this.scan.active=false;}
 async _refresh(signal){
  // TheFeed selects its own verified Google transport/fingerprint; do not
  // implement or race a second source. Only one channel is visited at a time.
  if(this.mirror){
   try{await this.mirror.start(signal);}catch{
    if(!this.closed&&!signal.aborted){this.stale=true;this.note='میرور TheFeed راه‌اندازی نشد؛ فایل TheFeed و نصب برنامه را بررسی کن.';this.emit();}
    return;
   }
  }
  const groups=Array(CHANNELS.length).fill(null);
  let finished=0,unavailable=0,hadFresh=false,lastEmit=0,lastError='',consecutiveNetworkFailures=0,circuitOpen=false;
  const merge=(expand=false)=>{
   const buckets=groups.filter(g=>g?.items?.length).map(g=>g.items);if(!buckets.length)return false;
   hadFresh=true;const max=Math.max(...buckets.map(x=>x.length));
   const reserve=expand?0:(CHANNELS.length-finished)*WEB_FIRST;
   const limit=Math.min(MAX_CANDIDATES,Math.max(this.entries.size,MAX_CANDIDATES-reserve),this.entries.size+MERGE_STEP);
   // Keep every queued, tested or verified candidate during this search. Add
   // in bounded round-robin steps, reserving room for unvisited channels.
   for(let i=0;i<max&&this.entries.size<limit;i++)for(const bucket of buckets){
    const c=bucket[i];if(!c||!c.id||this.hidden.has(c.id))continue;
    if(this.entries.has(c.id))this.scan?.cached.delete(c.id);
    else if(this.entries.size<limit){
     this.entries.set(c.id,{...c,countryCode:c.countryCode||'',countrySource:c.countrySource||''});
     if(this.scan){this.scan.seen.add(c.id);this.scan.skipped.delete(c.id);}
    }
   }
   this.fetchedAt=Date.now();this.stale=false;return true;
  };
  const channelNote=()=>{
   let note=`میرور TheFeed از طریق Google · کانال‌های تلگرام: ${finished.toLocaleString('fa-IR')} از ${CHANNELS.length.toLocaleString('fa-IR')} بررسی شد`;
   if(unavailable)note+=`؛ دریافت ${unavailable.toLocaleString('fa-IR')} کانال ناموفق بود یا کانال وجود نداشت`;
   if(unavailable&&lastError)note+=`؛ ${lastError}`;
   if(circuitOpen)note+='؛ برای جلوگیری از مصرف بی‌فایدهٔ اینترنت، جست‌وجو پس از سه خطای پیاپی میرور متوقف شد';
   else if(finished>=2&&unavailable===finished)note+='؛ دسترسی شبکه به میرور Google را بررسی کن';
   return note+'.';
  };
  const announce=(force=false)=>{
   if(this.closed||signal.aborted)return;const now=Date.now();if(!force&&now-lastEmit<250)return;
   lastEmit=now;merge();this.note=channelNote();this.emit();
  };
  let next=0;
  const worker=async()=>{
   while(!signal.aborted&&!this.closed){
    const i=next++;if(i>=CHANNELS.length)break;
    let items=null,error=null;
    try{items=await this.fetchTelegram(CHANNELS[i],{signal});}catch(e){error=e;lastError=mirrorErrorHint(e);}
    if(signal.aborted||this.closed)break;
    if(items===null){
     groups[i]={items:[]};unavailable++;
     // A deleted/private channel (404) isn't evidence of an outage. But
     // repeatedly hitting a broken transport is slow and wastes mobile data.
     consecutiveNetworkFailures=error?.code==='MIRROR_NOT_FOUND'?0:consecutiveNetworkFailures+1;
    }else{
     groups[i]={items:Array.isArray(items)?items.slice(0,WEB_PER_CHANNEL).map(c=>({...c,source:'@'+CHANNELS[i]+' · Google'})):[]};
     consecutiveNetworkFailures=0;
    }
    finished++;if(this.scan){this.scan.channelsDone=finished;this.scan.errors=unavailable;}
    if(consecutiveNetworkFailures>=3)circuitOpen=true;
    announce(finished===1||circuitOpen);if(circuitOpen)break;
   }
  };
  await Promise.all(Array.from({length:Math.min(WEB_CONCURRENCY,CHANNELS.length)},worker));
  if(this.closed||signal.aborted){if(!this.closed)merge();return;}announce(true);
  while(!this.closed&&!signal.aborted&&this.entries.size<MAX_CANDIDATES){
   const before=this.entries.size;merge(true);if(this.entries.size===before)break;
   this.note=channelNote();this.emit();if(this.entries.size<MAX_CANDIDATES)await pause(25,signal);
  }
  if(this.closed||signal.aborted)return;
  if(hadFresh){this.note=channelNote();await this.persist();}
  else{this.stale=true;this.note=channelNote()+(this.entries.size?' مورد تازه پیدا نشد؛ موارد ذخیره‌شده پس از آزمون نمایش داده می‌شوند.':' کانفیگی از میرور TheFeed دریافت نشد؛ اتصال شبکه و دسترسی Google را بررسی کن.');}
 }

 async cancelRefresh(){
  const job=this.busy;this.aborter?.abort();
  if(this.mirror)await this.mirror.cancel().catch(()=>{});
  if(job)await job.catch(()=>{});
  if(!this.closed){
   // Keep partial candidates and verified results; a later explicit search can restart.
   if(job&&this.entries.size)await this.persist().catch(()=>{});
   if(this.scan){this.scan.stopped=true;this.scan.active=false;}
   const hasSuccess=[...this.entries.values()].some(c=>this.prepared.has(c.id)&&Number.isFinite(this.latencies[c.id])&&this.latencies[c.id]>=0);
   const outcome=hasSuccess?'نتیجه‌های موفق حفظ شدند.':'هنوز نتیجهٔ موفقی پیدا نشده است.';
   this.note=this.scan?`متوقف شد؛ میرور TheFeed و Google: ${this.scan.channelsDone.toLocaleString('fa-IR')} از ${CHANNELS.length.toLocaleString('fa-IR')} کانال بررسی شد. ${outcome}`:`جست‌وجو و آزمون متوقف شد. ${outcome}`;this.emit();
  }
 }
 async stop(){this.closed=true;if(this.emitTimer){clearTimeout(this.emitTimer);this.emitTimer=null;}this.aborter?.abort();if(this.mirror)await this.mirror.stop().catch(()=>{});if(this.busy)await this.busy.catch(()=>{});await this.saveQueue.catch(()=>{});}
}
module.exports={CHANNELS,MAX_ENTRIES,MAX_CANDIDATES,WEB_CONCURRENCY,GOOGLE_HOST,GOOGLE_MIRROR,GOOGLE_ROUTES,ConfigSources,TeleMirrorSource,DnsFeedSource,googleTelegram,localRequest};
