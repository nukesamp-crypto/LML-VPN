'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{ConfigProbe,CONCURRENCY}=require('../lib/config-probe.cjs'),{parseLink}=require('../lib/config-links.cjs');
const base=parseLink('vless://11111111-1111-4111-8111-111111111111@example.com:443?security=tls');
const tick=()=>new Promise(r=>setImmediate(r));
test('a simulated scan of 1,205 candidates completes with a bounded worker pool',async()=>{
 const results=new Map(),items=new Map(Array.from({length:1205},(_,i)=>[String(i),{...base,id:String(i)}]));let running=0,peak=0;
 const sources={get:id=>items.get(id),setLatency:(id,ms,pin)=>results.set(id,{ms,pin})};
 const p=new ConfigProbe({binDir:'.',dataDir:'.',sources,workerYieldMs:0,resolver:{address:async()=> '8.8.8.8'},
  engineFactory:()=>({start:async(c,opts)=>{assert.equal(opts.systemProxy,false);assert.equal(opts.fastProbe,true);running++;peak=Math.max(peak,running);await tick();return {httpPort:80}},stop:async()=>{running--}}),verify:async()=>true});
 p.start([...items.keys()]);while(p.snapshot().running)await tick();
 assert.deepEqual(p.snapshot(),{running:false,done:1205,total:1205});assert.equal(results.size,1205);assert.equal(peak,CONCURRENCY);assert.equal(CONCURRENCY,2);assert([...results.values()].every(r=>r.ms>=0&&r.pin.address==='8.8.8.8'));
});
test('stopping a large scan preserves completed successes and does not save stale work',async()=>{
 let completed=0,release,entered;const gate=new Promise(r=>release=r),begun=new Promise(r=>entered=r),results=new Map();
 const sources={get:id=>({...base,id}),setLatency:(id,ms)=>{results.set(id,ms);completed++;}};
 const p=new ConfigProbe({binDir:'.',dataDir:'.',sources,workerYieldMs:0,resolver:{address:async()=> '8.8.8.8'},engineFactory:()=>({start:async()=>({httpPort:1}),stop:async()=>{}}),verify:async()=>{if(completed>=25){entered();await gate;}return true;}});
 p.start(Array.from({length:1205},(_,i)=>String(i)));await begun;const count=results.size,job=p.stop();release();await job;
 assert(count>=25);assert.equal(results.size,count);assert.equal(p.snapshot().running,false);assert(count<1205);
});

test('frequent successful probe updates coalesce expensive snapshots without dropping results',async t=>{
 const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{ConfigSources}=require('../lib/config-source.cjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lml-coalesce-'));let events=0;
 const sources=new ConfigSources({app:{getPath:()=>dir,isPackaged:false},binDir:()=>dir,onChange:()=>events++,dnsSource:{stop:async()=>{}},geo:{lookup:async()=>''}});
 t.after(async()=>{await sources.stop();await fs.rm(dir,{recursive:true,force:true});});
 for(let i=0;i<1205;i++){const c={...base,id:i.toString(16).padStart(24,'0'),countryCode:'US'};sources.entries.set(c.id,c);sources.setLatency(c.id,i+1,{address:'8.8.8.8',transport:c.transport});}
 assert.equal(events,0);assert.equal(sources.snapshot().items.length,1000);await new Promise(r=>setTimeout(r,300));assert.equal(events,1);
});
