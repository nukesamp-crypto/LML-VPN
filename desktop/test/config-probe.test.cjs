'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {ConfigProbe}=require('../lib/config-probe.cjs'),{parseLink}=require('../lib/config-links.cjs');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
test('group HTTPS probes record latency and remove their temporary session',{skip:!process.env.LML_XRAY_TEST_BIN},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lml-probe-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const c=parseLink('vless://11111111-1111-4111-8111-111111111111@example.com:443?security=none'),lat=[];
 const sources={get:id=>id==='one'?c:null,setLatency:(id,ms)=>lat.push([id,ms])};
 const p=new ConfigProbe({binDir:dir,dataDir:dir,sources,devBinary:process.env.LML_XRAY_TEST_BIN,resolver:{address:async()=> '8.8.8.8'},verify:async()=>{await wait(20);return true;}});t.after(()=>p.stop());
 p.start(['one','one']);const until=Date.now()+10000;while(p.snapshot().running&&Date.now()<until)await wait(30);
 assert.deepEqual(p.snapshot(),{running:false,done:1,total:1});assert.equal(lat.length,1);assert(lat[0][1]>=10);
 await assert.rejects(fs.stat(path.join(dir,'probe-0','config-engine','session.json')),{code:'ENOENT'});
});
test('cancelling a probe kills its core and does not save a stale result',{skip:!process.env.LML_XRAY_TEST_BIN},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lml-probe-stop-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const c=parseLink('vless://11111111-1111-4111-8111-111111111111@example.com:443?security=none');let begun,release;const started=new Promise(r=>begun=r),gate=new Promise(r=>release=r),lat=[];
 const sources={get:()=>c,setLatency:(id,ms)=>lat.push([id,ms])};
 const p=new ConfigProbe({binDir:dir,dataDir:dir,sources,devBinary:process.env.LML_XRAY_TEST_BIN,resolver:{address:async()=> '8.8.8.8'},verify:async()=>{begun();await gate;return true;}});
 t.after(async()=>{release();await p.stop();});p.start(['one']);await started;const stopping=p.stop();await wait(30);release();await stopping;
 assert.equal(p.snapshot().running,false);assert.equal(lat.length,0);await assert.rejects(fs.stat(path.join(dir,'probe-0','config-engine','session.json')),{code:'ENOENT'});
});

test('real core probing uses at most six parallel workers and advances all results',{skip:!process.env.LML_XRAY_TEST_BIN},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lml-probe-workers-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const items=new Map(Array.from({length:15},(_,i)=>[String(i),parseLink(`vless://11111111-1111-4111-8111-111111111111@node${i}.example.com:443?security=none`)]));
 const results=[];let concurrent=0,maxConcurrent=0;
 const sources={get:id=>items.get(id),setLatency:(id,ms,pinned)=>results.push({id,ms,pinned})};
 const p=new ConfigProbe({binDir:dir,dataDir:dir,sources,devBinary:process.env.LML_XRAY_TEST_BIN,resolver:{address:async()=> '8.8.8.8'},verify:async()=>{concurrent++;maxConcurrent=Math.max(maxConcurrent,concurrent);await wait(160);concurrent--;return true;}});t.after(()=>p.stop());
 p.start([...items.keys()]);const until=Date.now()+15000;while(p.snapshot().running&&Date.now()<until)await wait(40);
 assert.deepEqual(p.snapshot(),{running:false,done:15,total:15});assert.equal(results.length,15);assert(maxConcurrent>=2&&maxConcurrent<=6,`concurrency ${maxConcurrent}`);
 assert(results.every(r=>r.ms>=100&&r.pinned.address==='8.8.8.8'));
});
