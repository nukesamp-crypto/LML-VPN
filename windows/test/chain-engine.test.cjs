'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
const {ChainEngine}=require('../lib/chain-engine.cjs');
const {PsiphonHop}=require('../lib/psiphon-hop.cjs');
const {ConfigEngine,freePort}=require('../lib/config-engine.cjs');
const {parseLink}=require('../lib/config-links.cjs');const {DEFAULTS}=require('../lib/config.cjs');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=2500){let stop=Date.now()+timeout;while(Date.now()<stop){if(fn())return;await wait(15);}throw Error('timed out');}
function fakeParts(){
 const calls=[],gate={};let proxy=false;
 const xray={running:false,active(){return this.running},async start(c,o){calls.push(['xray',o]);this.running=true;return {httpPort:3011,socksPort:3012}},async stop(){calls.push(['stop-xray']);this.running=false}};
 const hop={running:false,onEvent:()=>{},active(){return this.running},async start(o){calls.push(['hop',o]);this.running=true;return {httpPort:3021,socksPort:3022}},async stop(){calls.push(['stop-hop']);this.running=false}};
 const px={async activate(p){calls.push(['activate',p]);proxy=true},async restore(){calls.push(['restore']);proxy=false}};
 const chain=new ChainEngine({xray,hop,proxy:px,verify:async()=>true});
 return {calls,chain,xray,hop,px,gate,get proxy(){return proxy}};
}
for(const mode of ['psiphon-via-xray','xray-via-psiphon'])test(`${mode} starts hops in correct order and cleans up`,async()=>{
 const f=fakeParts();const immediate=f.chain.start({scheme:'vless'},{mode,settings:DEFAULTS,systemProxy:true});assert.equal(immediate.state,'connecting');
 await until(()=>f.chain.snapshot().tested===true);assert.equal(f.chain.snapshot().state,'connected');
 if(mode==='psiphon-via-xray'){
  assert.equal(f.calls[0][0],'xray');assert.equal(f.calls[1][0],'hop');assert.equal(f.calls[1][1].upstreamHttpPort,3011);assert.deepEqual(f.calls[2],['activate',3021]);
 }else{
  assert.equal(f.calls[0][0],'hop');assert.equal(f.calls[1][0],'xray');assert.equal(f.calls[1][1].upstreamSocksPort,3022);assert.deepEqual(f.calls[2],['activate',3011]);
 }
 await f.chain.stop();assert.equal(f.proxy,false);assert.equal(f.xray.running,false);assert.equal(f.hop.running,false);assert.equal(f.chain.snapshot().state,'disconnected');
});
test('cancel during registry activation waits for the operation and restores proxy',async()=>{
 const f=fakeParts();let release,begun,active=false;const gate=new Promise(r=>release=r),started=new Promise(r=>begun=r);
 f.px.activate=async()=>{begun();await gate;active=true};f.px.restore=async()=>{active=false};
 f.chain.start({scheme:'vless'},{mode:'xray-via-psiphon',settings:DEFAULTS,systemProxy:true});await started;
 let done=false;const stopping=f.chain.stop().then(()=>done=true);await wait(80);assert.equal(done,false);release();await stopping;assert.equal(active,false);assert.equal(f.chain.snapshot().state,'disconnected');
});
test('a hop crash shuts down the other hop and restores proxy',async()=>{
 const f=fakeParts();f.chain.start({scheme:'vless'},{mode:'xray-via-psiphon',settings:DEFAULTS});await until(()=>f.chain.snapshot().state==='connected');
 f.hop.onEvent('process-exit');await until(()=>f.chain.snapshot().state==='error');assert.equal(f.proxy,false);assert.equal(f.xray.running,false);assert.equal(f.hop.running,false);
});
test('real Psiphon traffic can pass through a local Xray VLESS hop',{skip:!process.env.LML_PSIPHON_TEST_BIN||!process.env.LML_XRAY_TEST_BIN,timeout:180000},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lml-realchain-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const binDir=path.resolve(__dirname,'..','resources','bin'),inbound=await freePort(),uuid='11111111-1111-4111-8111-111111111111';
 const config={log:{loglevel:'warning'},inbounds:[{listen:'127.0.0.1',port:inbound,protocol:'vless',settings:{clients:[{id:uuid}],decryption:'none'}}],outbounds:[{protocol:'freedom',settings:{}}]};
 const serverCfg=path.join(dir,'server.json');await fs.writeFile(serverCfg,JSON.stringify(config));
 const server=spawn(process.env.LML_XRAY_TEST_BIN,['run','-c',serverCfg],{stdio:'ignore'});t.after(()=>server.kill());await wait(350);
 const c=parseLink(`vless://${uuid}@127.0.0.1:${inbound}?security=none&type=tcp`,{allowLocal:true});
 const proxy={activate:async()=>{},restore:async()=>{}};
 const xray=new ConfigEngine({binDir,dataDir:dir,proxy,devBinary:process.env.LML_XRAY_TEST_BIN});
 const hop=new PsiphonHop({binDir,dataDir:dir,devBinary:process.env.LML_PSIPHON_TEST_BIN});
 const chain=new ChainEngine({xray,hop,proxy});t.after(()=>chain.stop());
 chain.start(c,{mode:'psiphon-via-xray',settings:DEFAULTS,systemProxy:false});
 await until(()=>['connected','error'].includes(chain.snapshot().state),120000);
 assert.equal(chain.snapshot().state,'connected',chain.snapshot().detail);
 await until(()=>chain.snapshot().tested!==null,20000);
 assert.equal(chain.snapshot().tested,true,chain.snapshot().detail);
 await chain.stop();assert.equal(hop.active(),false);assert.equal(xray.active(),false);
 await assert.rejects(fs.stat(path.join(dir,'psiphon-chain','chain-config.json')),{code:'ENOENT'});
});

test('a verified chain reports measured latency and a connection start time',async()=>{
 const f=fakeParts();const now=Date.now();f.chain.start({scheme:'vless',id:'a'.repeat(24)},{mode:'xray-via-psiphon',settings:DEFAULTS,systemProxy:false});
 await until(()=>f.chain.snapshot().tested===true);const s=f.chain.snapshot();assert(s.connectedAt>=now);assert(Number.isInteger(s.pingMs)&&s.pingMs>=1);assert.equal(s.id,'a'.repeat(24));
 await f.chain.stop();assert.equal(f.chain.snapshot().connectedAt,null);assert.equal(f.chain.snapshot().pingMs,null);
});
