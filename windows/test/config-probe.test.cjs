'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {ConfigProbe}=require('../lib/config-probe.cjs'),{parseLink}=require('../lib/config-links.cjs');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
test('group HTTPS probes record latency and remove their temporary session',{skip:!process.env.LML_XRAY_TEST_BIN},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lml-probe-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const c=parseLink('vless://11111111-1111-4111-8111-111111111111@example.com:443?security=none'),lat=[];
 const sources={get:id=>id==='one'?c:null,setLatency:(id,ms)=>lat.push([id,ms])};
 const p=new ConfigProbe({binDir:dir,dataDir:dir,sources,devBinary:process.env.LML_XRAY_TEST_BIN,verify:async()=>{await wait(20);return true;}});t.after(()=>p.stop());
 p.start(['one','one']);const until=Date.now()+10000;while(p.snapshot().running&&Date.now()<until)await wait(30);
 assert.deepEqual(p.snapshot(),{running:false,done:1,total:1});assert.equal(lat.length,1);assert(lat[0][1]>=10);
 await assert.rejects(fs.stat(path.join(dir,'probe-0','config-engine','session.json')),{code:'ENOENT'});
});
test('cancelling a probe kills its core and does not save a stale result',{skip:!process.env.LML_XRAY_TEST_BIN},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lml-probe-stop-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const c=parseLink('vless://11111111-1111-4111-8111-111111111111@example.com:443?security=none');let begun,release;const started=new Promise(r=>begun=r),gate=new Promise(r=>release=r),lat=[];
 const sources={get:()=>c,setLatency:(id,ms)=>lat.push([id,ms])};
 const p=new ConfigProbe({binDir:dir,dataDir:dir,sources,devBinary:process.env.LML_XRAY_TEST_BIN,verify:async()=>{begun();await gate;return true;}});
 p.start(['one']);await started;const stopping=p.stop();await wait(30);release();await stopping;
 assert.equal(p.snapshot().running,false);assert.equal(lat.length,0);await assert.rejects(fs.stat(path.join(dir,'probe-0','config-engine','session.json')),{code:'ENOENT'});
});
