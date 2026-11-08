'use strict';
// The real main-process IPC handler must pass the selected, tested candidate to
// Xray. Two local VLESS servers make an accidental engine/config switch visible.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),fsSync=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),vm=require('node:vm'),{spawn}=require('node:child_process');
const {ConfigEngine,freePort}=require('../lib/config-engine.cjs'),{parseLink}=require('../lib/config-links.cjs'),{buildRouting}=require('../lib/routing.cjs'),{ConnectionGuard}=require('../lib/connection-guard.cjs');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=10000){const end=Date.now()+timeout;while(!fn()){if(Date.now()>end)throw Error('timed out');await wait(30);}}
test('main IPC connects the exact selected config via real Xray, not Lantern or Psiphon',{skip:!process.env.LML_XRAY_TEST_BIN},async t=>{
 const bin=process.env.LML_XRAY_TEST_BIN,dir=await fs.mkdtemp(path.join(os.tmpdir(),'lml-selected-e2e-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const target=http.createServer((_req,res)=>res.end('selected Xray path'));await new Promise(r=>target.listen(0,'127.0.0.1',r));t.after(()=>target.close());
 const id='11111111-1111-4111-8111-111111111111',ports=[await freePort(),await freePort()],children=[];
 for(let i=0;i<2;i++){
  const serverCfg={log:{loglevel:'warning'},inbounds:[{listen:'127.0.0.1',port:ports[i],protocol:'vless',settings:{clients:[{id}],decryption:'none'}}],outbounds:[{protocol:'freedom',settings:{finalRules:[{action:'allow',ip:['127.0.0.1/32']}]}}]};
  const file=path.join(dir,'server-'+i+'.json');await fs.writeFile(file,JSON.stringify(serverCfg));const child=spawn(bin,['run','-c',file],{stdio:'ignore'});children.push(child);
 }
 t.after(()=>children.forEach(c=>c.kill()));await wait(300);
 const candidates=ports.map(p=>parseLink(`vless://${id}@127.0.0.1:${p}?security=none&type=tcp`,{allowLocal:true}));
 const proxy={activate:async()=>{throw Error('system proxy should be off');},restore:async()=>{}};
 const engine=new ConfigEngine({binDir:dir,dataDir:dir,devBinary:bin,proxy,verify:async()=>true});t.after(()=>engine.stop());
 const main=fsSync.readFileSync(path.join(__dirname,'../main.cjs'),'utf8');const code=main.slice(main.indexOf('async function invoke(method,data)'),main.indexOf("\napp.setName('LML VPN')"));
 let chainStarts=0,ordinaryStarts=0;const autoProbe={pause:async()=>{},resume:()=>{},schedule:()=>{}};
 const ctx={connectionGuard:new ConnectionGuard(),autoProbe,anyConfigActive:()=>engine.active(),psiphonProcess:null,lanternConnectJob:null,lanternStopping:false,
  refreshLantern:async()=>({state:'disconnected'}),configSources:{getUsable:id=>candidates.find(c=>c.id===id)||null},
  MODES:new Set(['psiphon-via-xray','xray-via-psiphon']),settings:{systemProxy:false,routingPreset:'global',routingCustom:''},buildRouting,
  configKind:'direct',configEngine:engine,chainEngine:{start:()=>{chainStarts++;throw Error('wrong path');}},notifyConfigs:()=>{},
  startShiro:()=>{ordinaryStarts++;},startLantern:()=>{ordinaryStarts++;},snapshot:async()=>({settings:{engine:'shiro'},configConnection:engine.snapshot()})};
 vm.runInNewContext(code+'\nglobalThis.invoke=invoke;',ctx);
 await ctx.invoke('configsConnect',{id:candidates[1].id,mode:'direct'});await until(()=>engine.snapshot().state==='connected'||engine.snapshot().state==='error');
 assert.equal(engine.snapshot().state,'connected');assert.equal(engine.snapshot().id,candidates[1].id);
 const session=JSON.parse(await fs.readFile(path.join(dir,'config-engine/session.json'),'utf8'));
 assert.equal(session.outbounds[0].settings.vnext[0].port,ports[1]);assert.notEqual(session.outbounds[0].settings.vnext[0].port,ports[0]);
 const body=await new Promise((resolve,reject)=>{const req=http.get({host:'127.0.0.1',port:engine.snapshot().httpPort,path:`http://127.0.0.1:${target.address().port}/`,timeout:5000},res=>{let b='';res.on('data',x=>b+=x);res.on('end',()=>resolve(b));});req.on('error',reject);req.on('timeout',()=>req.destroy(Error('timeout')));});
 assert.equal(body,'selected Xray path');assert.equal(chainStarts,0);assert.equal(ordinaryStarts,0);
 await ctx.invoke('configsDisconnect',{});assert.equal(engine.snapshot().state,'disconnected');
});
