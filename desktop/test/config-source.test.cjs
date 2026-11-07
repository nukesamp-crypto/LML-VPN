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
test('fetches web and DNS concurrently, caches privately, and exposes only freshly verified LML results',async t=>{
 let release,started;const gate=new Promise(r=>release=r),dnsStarted=new Promise(r=>started=r);
 const one=entry(1,'@'+CHANNELS[0]+' · وب'),two=entry(2,'@other · DNS/فید');
 const s=await fixture(t,{fetchTelegram:async name=>{await gate;return name===CHANNELS[0]?[one]:[];},dnsSource:{fetch:async()=>{started();return [{...one,source:'@'+CHANNELS[0]+' · DNS/فید'},two];},stop:async()=>{}}});
 const a=s.refresh();assert.strictEqual(s.refresh(),a);await dnsStarted;release();const result=await a;
 assert.equal(result.refreshing,false);assert.equal(result.candidateCount,2);assert.deepEqual(result.items,[]);
 assert(s.get(one.id).source.includes('DNS/فید'));assert(!JSON.stringify(result).includes('11111111-1111'));assert.equal(typeof s.addManual,'undefined');
 const cached=JSON.parse(await fs.readFile(s.file,'utf8'));assert.equal(cached.links.length,2);
 mark(s,one.id,125.7);mark(s,two.id,30);assert.deepEqual(s.snapshot().items.map(x=>x.latency),[30,126]);
 assert(s.snapshot().items.every(x=>x.name==='LML VPN'&&x.source==='LML'));
 const again=await fixture(t);again.file=s.file;await again.load();assert.equal(again.snapshot().items.length,0);assert.equal(again.snapshot().stale,true);assert.equal(again.pendingIds().length,2);
 mark(again,one.id,61);assert.deepEqual(again.snapshot().items.map(x=>x.id),[one.id]);
});
test('network failure preserves a private cache and no manual entries or stale measurements are loaded',async t=>{
 const s=await fixture(t,{fetchTelegram:async()=>{throw Error('offline')}});
 await fs.writeFile(s.file,JSON.stringify({fetchedAt:Date.now(),latencies:{bogus:1},links:[{raw:link(1),source:'@channel · وب'},{raw:link(2),source:'ورودی دستی'}]}));await s.load();
 const r=await s.refresh();assert.equal(r.stale,true);assert.equal(r.items.length,0);assert.equal(r.candidateCount,1);assert(!r.refreshing);
 mark(s,entry(1,'').id,98);assert.equal(s.snapshot().items.length,1);
});
test('shutdown cancels an in-flight refresh without starting a later DNS child or overwriting cache',async t=>{
 let dnsCalls=0;const s=await fixture(t,{fetchTelegram:async()=>{throw Error('offline')},dnsSource:{fetch:async()=>{dnsCalls++;return [];},stop:async()=>{}}});
 const job=s.refresh();await s.stop();await job;assert.equal(dnsCalls,0);await assert.rejects(s.refresh(),/بسته/);
});
async function listen(t,handler){const server=http.createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));return {port:server.address().port,secret:'x'};}
function json(res,value){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));}
test('active feed DNS is copied to an isolated list without changing the user profile',async t=>{
 const userRequests=[],isolatedRequests=[];
 const user=await listen(t,(req,res)=>{userRequests.push([req.method,req.url]);json(res,{resolvers:['1.1.1.1:53','8.8.8.8:53']});});
 const isolated=await listen(t,(req,res)=>{let body='';req.on('data',b=>body+=b);req.on('end',()=>{isolatedRequests.push([req.method,req.url,body?JSON.parse(body):null]);if(req.method==='GET')json(res,{lists:[]});else json(res,{ok:true});});});
 const d=new DnsFeedSource({executable:'unused',dataDir:os.tmpdir(),expectedHash:null,sharedController:{start:async()=>user}});
 assert.equal(await d.useSharedResolvers(isolated),true);assert.deepEqual(userRequests,[['GET','/api/resolvers/active']]);
 const create=isolatedRequests.find(x=>x[1]==='/api/resolvers/lists');assert.deepEqual(create[2].resolvers,['1.1.1.1:53','8.8.8.8:53']);
 assert(isolatedRequests.some(x=>x[1]==='/api/resolvers/lists/select'&&x[2].noScan));
});

test('DNS candidates remain represented when web sources exceed the private cap',async t=>{
 const web=Array.from({length:6100},(_,i)=>({...parseLink(`vless://11111111-1111-4111-8111-111111111111@node${i}.example.com:443#web${i}`),source:'@web · وب'}));
 const dns=entry(2,'@dns · DNS/فید');
 const s=await fixture(t,{fetchTelegram:async n=>n===CHANNELS[0]?web:[],dnsSource:{fetch:async()=>[dns],stop:async()=>{}}});
 const result=await s.refresh();assert.equal(result.candidateCount,6000);assert.equal(result.items.length,0);assert(s.get(dns.id),'DNS candidate retained');
 mark(s,dns.id,45);assert.deepEqual(s.snapshot().items.map(x=>x.id),[dns.id]);assert.equal(s.snapshot().items[0].source,'LML');
});

test('a ping recorded while DNS is still fetching survives the merged list',async t=>{
 let resolveDns;const dnsWait=new Promise(r=>resolveDns=r),c=entry(1,'@web · وب');
 const s=await fixture(t,{fetchTelegram:async n=>n===CHANNELS[0]?[c]:[],dnsSource:{fetch:()=>dnsWait,stop:async()=>{}}});
 const job=s.refresh();for(let i=0;i<20&&!s.snapshot().candidateCount;i++)await new Promise(r=>setTimeout(r,5));
 mark(s,c.id,71);resolveDns([entry(2,'@dns · DNS/فید')]);const result=await job;
 assert.equal(result.items.find(x=>x.id===c.id).latency,71);
});

test('200 Telegram sources are visited with bounded concurrency and fair candidate representation',async t=>{
 assert.equal(CHANNELS.length,200);assert.equal(new Set(CHANNELS.map(n=>n.toLowerCase())).size,200);
 let running=0,maxRunning=0;const seen=[];
 const s=await fixture(t,{fetchTelegram:async name=>{
  running++;maxRunning=Math.max(maxRunning,running);seen.push(name);await new Promise(r=>setTimeout(r,2));running--;
  const i=CHANNELS.indexOf(name);
  return Array.from({length:9},(_,j)=>({...parseLink(`vless://11111111-1111-4111-8111-111111111111@node${i}-${j}.example.com:443#channel${i}-${j}`),source:'@'+name+' · وب'}));
 },dnsSource:{fetch:async()=>[entry(1,'@feed · DNS/فید')],stop:async()=>{}}});
 const r=await s.refresh();assert.equal(seen.length,200);assert(maxRunning<=8);assert.equal(r.candidateCount,1801);assert.equal(r.items.length,0);
 const represented=new Set([...s.entries.values()].map(x=>x.source));
 for(const channel of CHANNELS)assert(represented.has('@'+channel+' · وب'),channel);
 assert(represented.has('@feed · DNS/فید'));
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
 assert(result.items.every(item=>item.name==='LML VPN'&&item.source==='LML'));
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
 assert(result.items.every((x,i,a)=>x.source==='LML'&&x.name==='LML VPN'&&(i===0||a[i-1].latency<=x.latency)));
 assert.equal(s.pendingIds().length,2);
});
test('a successful result retains the pinned public address for its eventual connection, and refresh invalidates it',async t=>{
 const c=entry(1,'@web · وب');const s=await fixture(t,{fetchTelegram:async n=>n===CHANNELS[0]?[c]:[]});await s.refresh();
 assert.equal(s.getUsable(c.id),null);s.setLatency(c.id,20);assert.equal(s.snapshot().items.length,0);assert(s.pendingIds().includes(c.id));
 const prepared={...c,address:'8.8.8.8',transport:{...c.transport}};s.setLatency(c.id,80,prepared);
 assert.equal(s.getUsable(c.id).address,'8.8.8.8');assert.equal(s.getUsable(c.id).tls.sni,'example.com');
 await s.refresh();assert.equal(s.getUsable(c.id),null);assert(s.pendingIds().includes(c.id));
});
