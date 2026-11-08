'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {ConfigSources,CHANNELS}=require('../lib/config-source.cjs'),{ConfigProbe}=require('../lib/config-probe.cjs'),{AutoProbe}=require('../lib/auto-probe.cjs'),{parseLink}=require('../lib/config-links.cjs');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(fn,timeout=12000){const end=Date.now()+timeout;while(!fn()){if(Date.now()>end)throw Error('timed out');await wait(5);}}
const candidate=(i,source='@cached · وب')=>({...parseLink(`vless://11111111-1111-4111-8111-111111111111@node${i}.example.com:443#n${i}`),source,countryCode:'US'});

test('a new source batch never drops a queued/failed candidate or a cumulative test counter',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lml-progress-'));let release,auto;const gate=new Promise(r=>release=r);const snapshots=[],batches=[];
 const s=new ConfigSources({app:{getPath:()=>dir,isPackaged:false},binDir:()=>dir,geo:{lookup:async()=>''},
  dnsSource:{fetch:async()=>[],stop:async()=>{}},onChange:x=>{snapshots.push(x.scan);auto?.schedule();},
  fetchTelegram:async(name)=>{if(name===CHANNELS[0]){await gate;return Array.from({length:50},(_,j)=>candidate(1000+j,'@first · وب'));}if(name===CHANNELS[1])return Array.from({length:50},(_,j)=>candidate(1050+j,'@second · وب'));return [];}
 });
 for(let i=0;i<1000;i++){const c=candidate(i);s.entries.set(c.id,c);}
 const p=new ConfigProbe({binDir:dir,dataDir:dir,sources:s,workerYieldMs:0,resolver:{address:async()=> '8.8.8.8'},
  engineFactory:()=>({start:async()=>({httpPort:80}),stop:async()=>{}}),verify:async()=>true,
  onChange:v=>{if(!v.running)auto?.schedule();}});
 const originalStart=p.start.bind(p);p.start=ids=>{batches.push({size:ids.length,scan:s.snapshot().scan});return originalStart(ids);};
 auto=new AutoProbe({sources:s,probe:p,delay:1,canFinish:()=>!s.busy,onState:enabled=>{if(!enabled)s.finishScan();snapshots.push(s.snapshot().scan);}});
 t.after(async()=>{release();await auto.stop();await s.stop();await fs.rm(dir,{recursive:true,force:true});});
 auto.enable();const job=s.refresh();await waitFor(()=>s.snapshot().scan.tested===1000&&!p.snapshot().running);
 const before=s.snapshot();assert.equal(before.scan.found,1000);assert.equal(before.scan.tested,1000);assert.equal(before.items.length,1000);
 release();await job;await waitFor(()=>!auto.enabled);
 const final=s.snapshot();assert.equal(final.scan.found,1100);assert.equal(final.scan.tested,1100);assert.equal(final.scan.channelsDone,400);assert.equal(final.scan.active,false);
 assert.equal(final.items.length,1000);assert(batches.length>=2);assert(batches.every(x=>x.size<=12),'small batches let new results jump ahead of stale cached configs');
 assert(batches.slice(1).every((x,i)=>x.scan.tested>=batches[i].scan.tested),'a new small batch must not reset the displayed total');
 let last={found:0,tested:0,channelsDone:0};for(const x of snapshots.filter(Boolean)){assert(x.found>=last.found);assert(x.tested>=last.tested);assert(x.channelsDone>=last.channelsDone);last=x;}
});

test('only actually finished channels count, skipped candidates are not counted as tests',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lml-counts-'));let release;const gate=new Promise(r=>release=r);
 const s=new ConfigSources({app:{getPath:()=>dir,isPackaged:false},binDir:()=>dir,dnsSource:{fetch:async()=>[],stop:async()=>{}},
  fetchTelegram:async name=>{if(name===CHANNELS[0])return [candidate(1)];await gate;return [candidate(2)];}});
 t.after(async()=>{release();await s.stop();await fs.rm(dir,{recursive:true,force:true});});
 const job=s.refresh();await waitFor(()=>s.snapshot().scan.channelsDone===1&&s.entries.size===1);
 const id=s.entries.keys().next().value;await s.remove(id);const x=s.snapshot().scan;
 assert.equal(x.found,1);assert.equal(x.tested,0);assert.equal(x.skipped,1);assert.equal(x.channelsDone,1);
 const stop=s.cancelRefresh();release();await stop;await job;const y=s.snapshot().scan;
 assert.equal(y.stopped,true);assert.equal(y.channelsDone,1);assert.equal(y.found,1);assert.equal(y.tested,0);
});
