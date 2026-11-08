'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {ConfigSources,DnsFeedSource,CHANNELS}=require('../lib/config-source.cjs');const {parseLink}=require('../lib/config-links.cjs');
const link=n=>`vless://11111111-1111-4111-8111-11111111111${n}@example.com:443?security=tls#Node${n}`;
const entry=(n,source)=>({...parseLink(link(n)),source});
const mark=(source,id,ms)=>{const c=source.get(id);source.setLatency(id,ms,ms>=0?{...c,address:'8.8.8.8',transport:{...c.transport}}:null);};
async function fixture(t,{fetchTelegram=async()=>[],dnsSource={fetch:async()=>[],stop:async()=>{}}}={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lml-config-source-'));const source=new ConfigSources({app:{getPath:()=>dir,isPackaged:false},binDir:()=>dir,fetchTelegram,dnsSource});
 t.after(async()=>{await source.stop();await fs.rm(dir,{recursive:true,force:true});});return source;
}
test('deduplicates simultaneous Google refreshes, caches privately, and exposes only freshly verified results',async t=>{
 let release,started;const gate=new Promise(r=>release=r),begun=new Promise(r=>started=r);let dnsCalls=0;
 const one=entry(1,'@'+CHANNELS[0]+' · Google'),two=entry(2,'@'+CHANNELS[1]+' · Google');
 const s=await fixture(t,{fetchTelegram:async name=>{if(name===CHANNELS[0]){started();await gate;return [one];}return name===CHANNELS[1]?[two]:[];},dnsSource:{fetch:async()=>{dnsCalls++;return [one];},stop:async()=>{}}});
 const a=s.refresh();assert.strictEqual(s.refresh(),a);await begun;release();const result=await a;
 assert.equal(dnsCalls,0);assert.equal(result.refreshing,false);assert.equal(result.candidateCount,2);assert.deepEqual(result.items,[]);
 assert(s.get(one.id).source.includes('Google'));assert(!JSON.stringify(result).includes('11111111-1111'));assert.equal(typeof s.addManual,'undefined');
 const cached=JSON.parse(await fs.readFile(s.file,'utf8'));assert.equal(cached.source,'thefeed-google-mirror-v1');assert.equal(cached.links.length,2);
 mark(s,one.id,125.7);mark(s,two.id,30);assert.deepEqual(s.snapshot().items.map(x=>x.latency),[30,126]);
 assert(s.snapshot().items.every(x=>x.name==='LML VPN'&&x.source==='Google'));
 const again=await fixture(t);again.file=s.file;await again.load();assert.equal(again.snapshot().items.length,0);assert.equal(again.snapshot().stale,true);assert.equal(again.pendingIds().length,2);
 mark(again,one.id,61);assert.deepEqual(again.snapshot().items.map(x=>x.id),[one.id]);
});
test('network failure preserves a private cache and no manual entries or stale measurements are loaded',async t=>{
 const s=await fixture(t,{fetchTelegram:async()=>{throw Error('offline')}});
 await fs.writeFile(s.file,JSON.stringify({source:'thefeed-google-mirror-v1',fetchedAt:Date.now(),latencies:{bogus:1},links:[{raw:link(1),source:'@'+CHANNELS[0]+' · Google'},{raw:link(2),source:'ورودی دستی'}]}));await s.load();
 const r=await s.refresh();assert.equal(r.stale,true);assert.equal(r.items.length,0);assert.equal(r.candidateCount,1);assert(!r.refreshing);
 mark(s,entry(1,'').id,98);assert.equal(s.snapshot().items.length,1);
});
test('shutdown cancels an in-flight Google refresh without starting a DNS child or overwriting cache',async t=>{
 let dnsCalls=0;const s=await fixture(t,{fetchTelegram:async()=>{throw Error('offline')},dnsSource:{fetch:async()=>{dnsCalls++;return [];},stop:async()=>{}}});
 const job=s.refresh();await s.stop();await job;assert.equal(dnsCalls,0);await assert.rejects(s.refresh(),/بسته/);
});
async function listen(t,handler){const server=http.createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));return {port:server.address().port,secret:'x'};}
function json(res,value){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));}
test('active feed DNS is copied to an isolated list without changing the user profile',async t=>{
 const userRequests=[],isolatedRequests=[];
 const user=await listen(t,(req,res)=>{userRequests.push([req.method,req.url]);json(res,{resolvers:['1.1.1.1:53','8.8.8.8:53']});});
 const isolated=await listen(t,(req,res)=>{let body='';req.on('data',b=>body+=b);req.on('end',()=>{isolatedRequests.push([req.method,req.url,body?JSON.parse(body):null]);if(req.method==='GET')json(res,{lists:[]});else json(res,{ok:true});});});
 const d=new DnsFeedSource({executable:'unused',dataDir:os.tmpdir(),expectedHash:null,sharedController:{endpoint:user,start:async()=>{throw Error('must not start shared feed')},stop:async()=>{throw Error('must not stop shared feed')}}});
 assert.equal(await d.useSharedResolvers(isolated),true);assert.deepEqual(userRequests,[['GET','/api/resolvers/active']]);
 const create=isolatedRequests.find(x=>x[1]==='/api/resolvers/lists');assert.deepEqual(create[2].resolvers,['1.1.1.1:53','8.8.8.8:53']);
 assert(isolatedRequests.some(x=>x[1]==='/api/resolvers/lists/select'&&x[2].noScan));
});

test('every Google-mirrored channel remains represented when sources exceed the private cap',async t=>{
 const s=await fixture(t,{fetchTelegram:async n=>{
  const i=CHANNELS.indexOf(n);return Array.from({length:20},(_,j)=>({...parseLink(`vless://11111111-1111-4111-8111-111111111111@node${i}-${j}.example.com:443#node${i}-${j}`)}));
 }});
 let previousFound=0,maxStep=0;s.onChange=value=>{if(value.scan){maxStep=Math.max(maxStep,value.scan.found-previousFound);previousFound=value.scan.found;}};
 const result=await s.refresh();assert.equal(result.candidateCount,6000);assert.equal(result.items.length,0);assert(maxStep<=100,`candidate count stepped by ${maxStep}`);
 for(const n of CHANNELS)assert([...s.entries.values()].some(c=>c.source==='@'+n+' · Google'),'channel represented: '+n);
 const first=[...s.entries.values()][0];mark(s,first.id,45);assert.deepEqual(s.snapshot().items.map(x=>x.id),[first.id]);assert.equal(s.snapshot().items[0].source,'Google');
});

test('a ping recorded while later Google channels are still fetching survives the merged list',async t=>{
 let resolve,started;const gate=new Promise(r=>resolve=r),second=new Promise(r=>started=r),c=entry(1,'@'+CHANNELS[0]+' · Google');
 const s=await fixture(t,{fetchTelegram:async n=>{if(n===CHANNELS[0])return [c];if(n===CHANNELS[1]){started();await gate;return [entry(2,'@'+n+' · Google')];}return [];}});
 const job=s.refresh();await second;assert(s.get(c.id));mark(s,c.id,71);resolve();const result=await job;
 assert.equal(result.items.find(x=>x.id===c.id).latency,71);assert.equal(result.candidateCount,2);
});

test('400 Google-mirrored Telegram channels are visited in order with sequential concurrency and fair representation',async t=>{
 assert.equal(CHANNELS.length,400);assert.equal(new Set(CHANNELS.map(n=>n.toLowerCase())).size,400);
 let running=0,maxRunning=0,dnsCalls=0;const seen=[];
 const s=await fixture(t,{fetchTelegram:async name=>{
  running++;maxRunning=Math.max(maxRunning,running);seen.push(name);await new Promise(r=>setTimeout(r,2));running--;
  const i=CHANNELS.indexOf(name);
  return Array.from({length:9},(_,j)=>({...parseLink(`vless://11111111-1111-4111-8111-111111111111@node${i}-${j}.example.com:443#channel${i}-${j}`)}));
 },dnsSource:{fetch:async()=>{dnsCalls++;return [entry(1,'@feed · DNS/فید')];},stop:async()=>{}}});
 const r=await s.refresh();assert.deepEqual(seen,CHANNELS);assert.equal(maxRunning,1);assert.equal(dnsCalls,0);assert.equal(r.candidateCount,3600);assert.equal(r.items.length,0);
 const represented=new Set([...s.entries.values()].map(x=>x.source));
 for(const channel of CHANNELS)assert(represented.has('@'+channel+' · Google'),channel);
});

test('single deletion works before any ping, bulk deletion removes only failures and persists',async t=>{
 const first=entry(1,'@a · وب'),failed=entry(2,'@b · وب'),untested=entry(3,'@c · وب');
 const s=await fixture(t,{fetchTelegram:async n=>n===CHANNELS[0]?[first,failed,untested]:[]});
 await s.refresh();assert.equal(await s.remove(first.id),1);assert(!s.get(first.id));
 mark(s,failed.id,-1);assert.equal(await s.removeFailed(),1);assert(s.get(untested.id),'untested config must remain');
 await s.refresh();assert(!s.get(first.id));assert(!s.get(failed.id));assert(s.get(untested.id));
 const again=await fixture(t);again.file=s.file;await again.load();assert.equal(again.snapshot().hiddenCount,2);assert.equal(again.snapshot().items.length,0);assert.equal(again.snapshot().candidateCount,1);
 mark(again,untested.id,50);assert.equal(again.snapshot().items.length,1);
 await s.restoreRemoved();await s.refresh();assert.equal(s.snapshot().items.length,0);assert.equal(s.snapshot().candidateCount,3);
 for(const c of [first,failed,untested])mark(s,c.id,70);assert.equal(s.snapshot().items.length,3);
});

test('hostname geolocation waits until the user pings and reports only IP metadata',async t=>{
 let queries=0;const c=entry(1,'@a · وب');
 const s=await fixture(t,{fetchTelegram:async n=>n===CHANNELS[0]?[c]:[]});
 s.resolveHost=async()=>{queries++;return '8.8.8.8'};s.geo={lookup:async()=> 'US'};
 await s.refresh();assert.equal(queries,0);assert.equal(s.snapshot().items.length,0);
 mark(s,c.id,144);for(let i=0;i<20&&!s.snapshot().items[0].countryCode;i++)await new Promise(r=>setTimeout(r,2));
 const item=s.snapshot().items[0];assert.equal(queries,1);assert.equal(item.countryCode,'US');assert.equal(item.countrySource,'ip');
});

test('DNS feed can use more than twenty channels supplied by its own profile',async t=>{
 const channels=Array.from({length:30},(_,i)=>({Name:`feed${i+1}`}));
 const endpoint=await listen(t,(req,res)=>{
  if(req.url==='/api/channels')return json(res,channels);
  if(req.url.startsWith('/api/refresh?channel='))return json(res,{});
  const m=req.url.match(/^\/api\/messages\/(\d+)$/);
  if(m){const n=Number(m[1]);return json(res,{messages:[{Text:`vless://11111111-1111-4111-8111-111111111111@feed${n}.example.com:443#feed${n}`} ]});}
  res.writeHead(404);res.end();
 });
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lml-dns-many-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const source=new DnsFeedSource({executable:'none',dataDir:dir,expectedHash:null});source.init=async()=>endpoint;t.after(()=>source.stop());
 const entries=await source.fetch();assert.equal(entries.length,30);assert(entries.every(x=>x.source.includes('DNS/فید')));assert(entries.some(x=>x.source.includes('@feed30')));
});

test('branding, raw identity, sorting and cache re-testing remain correct across fresh and cached configs',async t=>{
 const rawA=`vless://11111111-1111-4111-8111-111111111111@a.example.com:443?security=tls#%F0%9F%87%A9%F0%9F%87%AA%20First`;
 const rawB=`vless://22222222-2222-4222-8222-222222222222@b.example.com:443?security=tls#%F0%9F%87%B3%F0%9F%87%B1%20Second`;
 const a={...parseLink(rawA),source:'@same · وب'},b={...parseLink(rawB),source:'@same · وب'};
 const s=await fixture(t,{fetchTelegram:async name=>name===CHANNELS[0]?[a,b]:[]});
 let result=await s.refresh();assert.equal(result.items.length,0);assert.equal(result.candidateCount,2);
 assert.equal(s.get(a.id).raw,rawA);assert.equal(s.get(a.id).remark,'🇩🇪 First');assert.equal(s.get(b.id).raw,rawB);
 mark(s,a.id,123);mark(s,b.id,77);result=s.snapshot();assert.deepEqual(result.items.map(x=>x.latency),[77,123]);
 assert(result.items.every(item=>item.name==='LML VPN'&&item.source==='Google'));
 assert.deepEqual(result.items.map(x=>x.countryCode),['NL','DE']);assert(result.items.every(x=>x.countrySource==='label'));
 const saved=JSON.parse(await fs.readFile(s.file,'utf8'));assert.deepEqual(saved.links.map(x=>x.raw),[rawA,rawB]);
 const again=await fixture(t);again.file=s.file;await again.load();assert.equal(again.snapshot().items.length,0);assert.equal(again.pendingIds().length,2);
 mark(again,a.id,45);mark(again,b.id,33);assert.deepEqual(again.snapshot().items.map(x=>x.id),[b.id,a.id]);
 await again.remove(a.id);assert.deepEqual(again.snapshot().items.map(x=>x.id),[b.id]);
 // Every explicit refresh tests both earlier successes and failures again.
 mark(again,b.id,-1);assert.equal(again.pendingIds().length,0);
 await again.refresh();assert.equal(again.snapshot().items.length,0);assert(again.pendingIds().includes(b.id));
});
test('the public result cap is 1000 and selects the lowest measured latencies, never failures or untested candidates',async t=>{
 const s=await fixture(t);
 for(let i=0;i<1205;i++){
  const c=parseLink(`vless://11111111-1111-4111-8111-111111111111@node${i}.example.com:443#sample${i}`);
  s.entries.set(c.id,c);if(i<1203){s.latencies[c.id]=1204-i;s.prepared.set(c.id,{address:'8.8.8.8',transport:{...c.transport}});}
 }
 const result=s.snapshot();assert.equal(result.candidateCount,1205);assert.equal(result.items.length,1000);
 assert.equal(result.items[0].latency,2);assert.equal(result.items.at(-1).latency,1001);
 assert(result.items.every((x,i,a)=>x.source==='Google'&&x.name==='LML VPN'&&(i===0||a[i-1].latency<=x.latency)));
 assert.equal(s.pendingIds().length,2);
});
test('a successful result retains the pinned public address for its eventual connection, and refresh invalidates it',async t=>{
 const c=entry(1,'@web · وب');const s=await fixture(t,{fetchTelegram:async n=>n===CHANNELS[0]?[c]:[]});await s.refresh();
 assert.equal(s.getUsable(c.id),null);s.setLatency(c.id,20);assert.equal(s.snapshot().items.length,0);assert(s.pendingIds().includes(c.id));
 const prepared={...c,address:'8.8.8.8',transport:{...c.transport}};s.setLatency(c.id,80,prepared);
 assert.equal(s.getUsable(c.id).address,'8.8.8.8');assert.equal(s.getUsable(c.id).tls.sni,'example.com');
 await s.refresh();assert.equal(s.getUsable(c.id),null);assert(s.pendingIds().includes(c.id));
});

test('a scan does not start or stop the user’s shared TheFeed process',async t=>{
 let starts=0,stops=0;
 const d=new DnsFeedSource({executable:'unused',dataDir:os.tmpdir(),expectedHash:null,sharedController:{endpoint:null,start:async()=>{starts++;},stop:async()=>{stops++;}}});
 assert.equal(await d.useSharedResolvers({port:1,secret:'unused'}),false);await d.cancel();
 assert.equal(starts,0);assert.equal(stops,0);await d.stop();assert.equal(stops,0);
});

test('stopping a DNS scan aborts a hanging local request and permits a later restart',async t=>{
 let served;const first=new Promise(r=>served=r);let hang=true,closed=false;
 const endpoint=await listen(t,(req,res)=>{
  if(req.url==='/api/channels'&&hang){served();req.on('close',()=>{closed=true});return;}
  if(req.url==='/api/channels')return json(res,[{Name:'feed1'}]);
  if(req.url.startsWith('/api/refresh?channel='))return json(res,{});
  if(req.url==='/api/messages/1')return json(res,{messages:[{Text:link(1)}]});
  res.writeHead(404);res.end();
 });
 const source=new DnsFeedSource({executable:'unused',dataDir:os.tmpdir(),expectedHash:null});source.init=async()=>endpoint;t.after(()=>source.stop());
 const job=source.fetch();const rejected=assert.rejects(job,/متوقف/);await first;
 const start=Date.now();await source.cancel();await rejected;assert(Date.now()-start<1000,'cancellation must not wait for the request timeout');
 await new Promise(r=>setTimeout(r,20));assert(closed,'hanging local socket was closed');
 hang=false;const result=await source.fetch();assert.equal(result.length,1);assert(result[0].source.includes('DNS/فید'));
});

test('stopping during DNS polling wakes its delay immediately',async t=>{
 let served;const first=new Promise(r=>served=r);
 const endpoint=await listen(t,(req,res)=>{if(req.url==='/api/channels'){served();return json(res,[]);}res.writeHead(404);res.end();});
 const source=new DnsFeedSource({executable:'unused',dataDir:os.tmpdir(),expectedHash:null});source.init=async()=>endpoint;t.after(()=>source.stop());
 const job=source.fetch(),rejected=assert.rejects(job,/متوقف/);await first;await new Promise(r=>setTimeout(r,30));
 const start=Date.now();await source.cancel();await rejected;assert(Date.now()-start<500,'polling delay was interrupted');
});

test('stop cancels the Google scan, retains verified partial results, ignores late candidates and can restart',async t=>{
 const good=entry(1,'@'+CHANNELS[0]+' · Google'),late=entry(2,'@late · Google'),fresh=entry(3,'@fresh · Google');
 let stage=0,started=0,signalled,secondStarted,dnsCalls=0;const secondReady=new Promise(r=>secondStarted=r),firstReady=new Promise(r=>signalled=r);
 const abortResult=(signal,value)=>new Promise(resolve=>{if(signal.aborted)return resolve(value);signal.addEventListener('abort',()=>resolve(value),{once:true});});
 const dnsSource={fetch:async()=>{dnsCalls++;return [late];},cancel:async()=>{dnsCalls++;},stop:async()=>{dnsCalls++;}};
 const s=await fixture(t,{dnsSource,fetchTelegram:async(name,{signal})=>{
  started++;if(stage===1)return name===CHANNELS[0]?[fresh]:[];
  if(name===CHANNELS[0]){signalled();return [good];}
  secondStarted();return abortResult(signal,[late]);
 }});
 const job=s.refresh();await Promise.all([firstReady,secondReady]);
 for(let i=0;i<50&&!s.get(good.id);i++)await new Promise(r=>setTimeout(r,2));assert(s.get(good.id));mark(s,good.id,39);
 await s.cancelRefresh();await job;assert.equal(dnsCalls,0);assert(started<400);assert(!s.get(late.id),'aborted late result must not be merged');
 assert.deepEqual(s.snapshot().items.map(x=>x.id),[good.id]);assert.equal(s.snapshot().refreshing,false);assert.match(s.snapshot().note,/متوقف/);assert.equal(s.snapshot().scan.stopped,true);assert.equal(s.snapshot().scan.tested,1);assert(s.snapshot().scan.channelsDone<400);
 assert((JSON.parse(await fs.readFile(s.file,'utf8'))).links.some(x=>x.raw===good.raw),'partial work is persisted');
 stage=1;const restarted=await s.refresh();assert(s.get(fresh.id));assert.equal(restarted.items.length,0,'new session re-tests prior results');assert.equal(s.closed,false);
});

test('a verified cached candidate is not dropped when a new source batch arrives',async t=>{
 const previous=entry(1,'@cached · وب'),fresh=entry(2,'@fresh · وب');
 const s=await fixture(t,{fetchTelegram:async n=>n===CHANNELS[0]?[fresh]:[]});s.entries.set(previous.id,previous);
 const job=s.refresh();mark(s,previous.id,52);await job;
 assert(s.get(fresh.id));assert(s.get(previous.id));assert.deepEqual(s.snapshot().items.map(x=>x.id),[previous.id]);
});


test('normal DNS search completion also stops the isolated feed, never the shared feed',async t=>{
 let privateStops=0,sharedStops=0;
 const endpoint=await listen(t,(req,res)=>{
  if(req.url==='/api/channels')return json(res,[{Name:'feed1'}]);
  if(req.url.startsWith('/api/refresh?channel='))return json(res,{});
  if(req.url==='/api/messages/1')return json(res,{messages:[{Text:link(1)}]});
  res.writeHead(404);res.end();
 });
 const source=new DnsFeedSource({executable:'unused',dataDir:os.tmpdir(),expectedHash:null,sharedController:{stop:async()=>{sharedStops++;}}});
 source.init=async()=>endpoint;source.controller={stop:async()=>{privateStops++;}};
 assert.equal((await source.fetch()).length,1);assert.equal(privateStops,1);assert.equal(sharedStops,0);
});
