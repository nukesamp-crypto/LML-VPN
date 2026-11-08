'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {LanternPing,systemHttpsPing}=require('../lib/lantern-ping.cjs');
const {historyLatency}=require('../lib/lantern.cjs');
const tick=()=>new Promise(r=>setImmediate(r));
test('Lantern internal delay rejects stale, failed, unavailable and impossible results',()=>{
 const now=new Date().toISOString();
 assert.equal(historyLatency({selection_history:{last_success_delay_ms:42,last_outcome_at:now}}),42);
 for(const h of [{last_success_delay_ms:0,last_outcome_at:now},{last_success_delay_ms:90,last_outcome_at:new Date(Date.now()-3600000).toISOString()},{last_success_delay_ms:10,last_outcome_at:now,consecutive_failures:1},{last_success_delay_ms:200000,last_outcome_at:now},{}])assert.equal(historyLatency({selection_history:h}),null);
 assert.equal(historyLatency(null),null);
});
test('Lantern falls back to a labeled authenticated HTTPS system measurement',async()=>{
 let selected=0,system=0,emitted=[];
 const p=new LanternPing({selected:async()=>{selected++;return null},system:async()=>{system++;return 74},onChange:value=>emitted.push(value)});
 assert.deepEqual(p.update(true),{pingMs:null,pingSource:null});await tick();
 assert.deepEqual(p.update(true),{pingMs:74,pingSource:'system'});assert.equal(selected,1);assert.equal(system,1);assert.deepEqual(emitted,[{pingMs:74,pingSource:'system'}]);
 assert.deepEqual(p.update(false),{pingMs:null,pingSource:null});
});
test('Lantern reports selected-server history, not a fabricated live ping',async()=>{
 let fallback=0;const p=new LanternPing({selected:async()=>36,system:async()=>{fallback++;return 2}});
 p.update(true);await tick();assert.deepEqual(p.update(true),{pingMs:36,pingSource:'lantern'});assert.equal(fallback,0);
});
test('disconnect aborts a pending measurement and ignores stale results',async()=>{
 let release;const pending=new Promise(r=>release=r),emitted=[];
 const p=new LanternPing({selected:async()=>null,system:async()=>pending,onChange:x=>emitted.push(x)});
 p.update(true);await tick();p.update(false);release(23);await tick();assert.equal(emitted.length,0);assert.deepEqual(p.update(false),{pingMs:null,pingSource:null});
});
test('HTTPS measurement uses normal certificate verification and resolves on a response',async()=>{
 let options;function request(opts,cb){options=opts;const req=new EventEmitter();req.destroy=()=>{};req.end=()=>{const res={statusCode:204,resume(){}};setImmediate(()=>cb(res));};return req;}
 const ms=await systemHttpsPing({request});assert(ms>=1);assert.equal(options.rejectUnauthorized,true);assert.equal(options.agent,false);assert.equal(options.method,'HEAD');
});

test('selected latency reads the live registry over the allowed HTTP/2 pipe route',async t=>{
 const http2=require('node:http2'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{selectedLatency,request}=require('../lib/lantern.cjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lml-lantern-latency-')),sock=path.join(dir,'lantern.sock'),calls=[];
 const server=http2.createServer();server.on('stream',(stream,headers)=>{const url=headers[':path'];calls.push([headers[':method'],url]);stream.respond({':status':200,'content-type':'application/json'});
  if(url==='/server/selected')stream.end(JSON.stringify({exists:true,server:{tag:'selected',selection_history:{last_success_delay_ms:5,last_outcome_at:'2020-01-01T00:00:00Z'}}}));
  else stream.end(JSON.stringify([{tag:'selected',secret:'not exposed',selection_history:{last_success_delay_ms:88,last_outcome_at:new Date().toISOString()}}]));});
 await new Promise(r=>server.listen(sock,r));t.after(async()=>{await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});});
 assert.equal(await selectedLatency({socketPath:sock}),88);assert.deepEqual(calls,[['GET','/server/selected'],['GET','/servers']]);
 await assert.rejects(request('POST','/servers',null,{socketPath:sock}),/نامعتبر/);
});
