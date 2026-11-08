'use strict';
// Exercise the real IPC implementation with controlled, non-network engines so
// timing-sensitive start/stop and unrelated connection intents are reproducible.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {ConnectionGuard}=require('../lib/connection-guard.cjs');
const main=fs.readFileSync(path.join(__dirname,'../main.cjs'),'utf8');
const declarations=main.slice(main.indexOf('let scanStarting='),main.indexOf('\n',main.indexOf('const configView=')));
const implementation=main.slice(main.indexOf('async function invoke(method,data)'),main.indexOf("\napp.setName('LML VPN')"));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function setup({refreshLantern=async()=>({state:'disconnected'})}={}){
 const guard=new ConnectionGuard();let finishFetch;const stats={fetch:0,cancel:0,disabled:0};
 const sources={busy:null,note:'',snapshot(){return {items:[],refreshing:!!this.busy,note:this.note};},emit(){},
  refresh(){stats.fetch++;this.busy=new Promise(r=>{finishFetch=r});return this.busy;},
  async cancelRefresh(){stats.cancel++;if(finishFetch){finishFetch();finishFetch=null;}this.busy=null;this.note='stopped';}};
 const probe={job:null,snapshot:()=>({running:false,done:0,total:0})};
 const auto={enabled:false,paused:false,async pause(){this.paused=true;},resume(){this.paused=false;},enable(){this.enabled=true;},async disable(){stats.disabled++;this.enabled=false;}};
 const context={configSources:sources,configProbe:probe,autoProbe:auto,connectionGuard:guard,refreshLantern,
  anyConfigActive:()=>false,psiphonProcess:null,lanternConnectJob:null,lanternStopping:false,lanternState:{state:'disconnected'}};
 vm.runInNewContext(declarations+'\n'+implementation+'\nglobalThis.invoke=invoke;globalThis.configView=configView;',context);
 return {...context,context,guard,sources,probe,auto,stats};
}
test('stop during preflight invalidates the pending scan without ever fetching, then restart works',async()=>{
 const gate=deferred(),entered=deferred();let checks=0;
 const h=setup({refreshLantern:async()=>{checks++;if(checks===1){entered.resolve();await gate.promise;}return {state:'disconnected'};}});
 const start=h.invoke('configsRefresh');const rejected=assert.rejects(start,/لغو/);await entered.promise;
 assert.equal(h.configView().scanRunning,true);const stopping=h.invoke('configsTestStop');
 await new Promise(r=>setTimeout(r,5));assert.equal(h.stats.fetch,0);assert.equal(h.stats.cancel,1);assert.equal(h.stats.disabled,1);
 gate.resolve();await rejected;const stopped=await stopping;assert.equal(stopped.configs.scanRunning,false);assert.equal(h.guard.busy,false);
 const result=await h.invoke('configsRefresh');assert.equal(h.stats.fetch,1);assert.equal(result.scanRunning,true);assert.equal(result.refreshing,true);
 // The start reply returned while the source job is still pending, and stop
 // terminates both acquisition and verification.
 const after=await h.invoke('configsTestStop');assert.equal(h.stats.cancel,2);assert.equal(h.stats.disabled,2);assert.equal(after.configs.scanRunning,false);assert.equal(after.configs.refreshing,false);
});
test('stop cannot cancel an unrelated connection, including when starting a scan is rejected as busy',async()=>{
 const h=setup(),gate=deferred();let connected=false;
 const unrelated=h.guard.run(async check=>{await gate.promise;check();connected=true;});
 await assert.rejects(h.invoke('configsRefresh'),/اتصال دیگری/);await h.invoke('configsTestStop');
 gate.resolve();await unrelated;assert.equal(connected,true);assert.equal(h.stats.fetch,0);
});
test('stop during an active scan leaves an unrelated subsequent connection intent untouched',async()=>{
 const h=setup();await h.invoke('configsRefresh');const gate=deferred();let connected=false;
 const unrelated=h.guard.run(async check=>{await gate.promise;check();connected=true;});
 const stopped=await h.invoke('configsTestStop');assert.equal(stopped.configs.scanRunning,false);
 gate.resolve();await unrelated;assert.equal(connected,true);assert.equal(h.stats.cancel,1);
});

test('Telegram acquisition can start with an engine active; probe remains queued until disconnection',async()=>{
 const h=setup({refreshLantern:async()=>({state:'connected'})});h.context.psiphonProcess={pid:1};h.context.lanternState={state:'connected'};
 const view=await h.invoke('configsRefresh');assert.equal(h.stats.fetch,1);assert.equal(view.refreshing,true);assert.equal(h.auto.enabled,true);assert.equal(view.testsWaiting,true);
 const stopped=await h.invoke('configsTestStop');assert.equal(stopped.configs.scanRunning,false);
});
