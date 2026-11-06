'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {ConfigSources,DnsFeedSource,CHANNELS}=require('../lib/config-source.cjs');const {parseLink}=require('../lib/config-links.cjs');
const link=n=>`vless://11111111-1111-4111-8111-11111111111${n}@example.com:443?security=tls#Node${n}`;
const entry=(n,source)=>({...parseLink(link(n)),source});
async function fixture(t,{fetchTelegram=async()=>[],dnsSource={fetch:async()=>[],stop:async()=>{}}}={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lml-config-source-'));const source=new ConfigSources({app:{getPath:()=>dir,isPackaged:false},binDir:()=>dir,fetchTelegram,dnsSource});
 t.after(async()=>{await source.stop();await fs.rm(dir,{recursive:true,force:true});});return source;
}
test('fetches public channels and DNS simultaneously, merges honest labels and caches without exposing credentials',async t=>{
 let release,started;const gate=new Promise(r=>release=r),dnsStarted=new Promise(r=>started=r);
 const s=await fixture(t,{fetchTelegram:async name=>{await gate;return name===CHANNELS[0]?[entry(1,'@'+name+' · وب')]:[];},dnsSource:{fetch:async()=>{started();return [entry(1,'@'+CHANNELS[0]+' · DNS/فید'),entry(2,'@other · DNS/فید')];},stop:async()=>{}}});
 const a=s.refresh();assert.strictEqual(s.refresh(),a);await dnsStarted;release();const result=await a;
 assert.equal(result.refreshing,false);assert.equal(result.items.length,2);assert(result.items.find(x=>x.id===entry(1,'').id).source.includes('DNS/فید'));
 assert(!JSON.stringify(result).includes('11111111-1111'));assert.equal(typeof s.addManual,'undefined');
 const cached=JSON.parse(await fs.readFile(s.file,'utf8'));assert.equal(cached.links.length,2);
 const again=await fixture(t);again.file=s.file;await again.load();assert.equal(again.snapshot().items.length,2);assert.equal(again.snapshot().stale,true);
 s.setLatency(result.items[0].id,125.7);assert.equal(s.snapshot().items[0].latency,126);
});
test('network failure preserves a previous cache and no manual entries are loaded',async t=>{
 const s=await fixture(t,{fetchTelegram:async()=>{throw Error('offline')}});
 await fs.writeFile(s.file,JSON.stringify({fetchedAt:Date.now(),links:[{raw:link(1),source:'@channel · وب'},{raw:link(2),source:'ورودی دستی'}]}));await s.load();
 const r=await s.refresh();assert.equal(r.stale,true);assert.equal(r.items.length,1);assert(!r.refreshing);
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

test('DNS entries remain visible even when web sources exceed the list cap',async t=>{
 const web=Array.from({length:520},(_,i)=>({...parseLink(`vless://11111111-1111-4111-8111-111111111111@node${i}.example.com:443#web${i}`),source:'@web · وب'}));
 const s=await fixture(t,{fetchTelegram:async n=>n===CHANNELS[0]?web:[],dnsSource:{fetch:async()=>[entry(2,'@dns · DNS/فید')],stop:async()=>{}}});
 const result=await s.refresh();assert.equal(result.items.length,500);assert(result.items.some(x=>x.source==='@dns · DNS/فید'));
});

test('a ping recorded while DNS is still fetching survives the merged list',async t=>{
 let resolveDns;const dnsWait=new Promise(r=>resolveDns=r),c=entry(1,'@web · وب');
 const s=await fixture(t,{fetchTelegram:async n=>n===CHANNELS[0]?[c]:[],dnsSource:{fetch:()=>dnsWait,stop:async()=>{}}});
 const job=s.refresh();for(let i=0;i<20&&!s.snapshot().items.length;i++)await new Promise(r=>setTimeout(r,5));
 s.setLatency(c.id,71);resolveDns([entry(2,'@dns · DNS/فید')]);const result=await job;
 assert.equal(result.items.find(x=>x.id===c.id).latency,71);
});
