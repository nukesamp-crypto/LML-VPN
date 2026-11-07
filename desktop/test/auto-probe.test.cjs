'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AutoProbe}=require('../lib/auto-probe.cjs'),{ConnectionGuard}=require('../lib/connection-guard.cjs');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fakeProbe(){
 let running=false,finish;const p={job:null,starts:[],stops:0,snapshot:()=>({running}),start(ids){
  if(this.job)throw Error('busy');this.starts.push(ids);running=true;this.job=new Promise(r=>finish=r);
 },async stop(){this.stops++;if(p.beforeStop)await p.beforeStop;running=false;finish?.();await p.job;p.job=null;},finish(){running=false;finish?.();p.job=null;}};return p;
}
test('automatic verification is bounded to pending ids and runs again when more arrive',async t=>{
 const probe=fakeProbe();let ids=['one','two'];const auto=new AutoProbe({sources:{pendingIds:()=>ids},probe,delay:5});t.after(()=>auto.stop());
 auto.enable();await wait(20);assert.deepEqual(probe.starts,[['one','two']]);
 ids=['three'];auto.schedule();await wait(20);assert.equal(probe.starts.length,1,'no overlapping batch');
 probe.finish();auto.schedule();await wait(20);assert.deepEqual(probe.starts[1],['three']);
});
test('pause waits for a finishing job even when its public snapshot already says stopped',async t=>{
 const probe=fakeProbe(),end=defer();probe.job=Promise.resolve();probe.beforeStop=end.promise;
 const auto=new AutoProbe({sources:{pendingIds:()=>['one']},probe,delay:5});t.after(()=>auto.stop());auto.enable();
 let settled=false;const pause=auto.pause().then(()=>{settled=true;});await wait(15);assert.equal(settled,false);assert.equal(probe.starts.length,0);
 end.resolve();await pause;assert.equal(probe.stops,1);auto.resume();await wait(20);assert.equal(probe.starts.length,1);
 await auto.disable();auto.schedule();await wait(15);assert.equal(probe.starts.length,1,'explicit stop persists');
});
test('a connection intent pauses and cleans up probes; they resume only after disconnect',async t=>{
 const probe=fakeProbe(),guard=new ConnectionGuard(),stopGate=defer();let active=false;
 const auto=new AutoProbe({sources:{pendingIds:()=>['one']},probe,delay:5,canRun:()=>!guard.busy&&!active});t.after(()=>auto.stop());auto.enable();await wait(20);assert.equal(probe.starts.length,1);
 probe.beforeStop=stopGate.promise;let connected=false;
 const intent=guard.run(async check=>{try{await auto.pause();check();active=true;connected=true;}finally{auto.resume();}});
 await wait(15);assert.equal(connected,false,'do not connect while a probe is shutting down');stopGate.resolve();await intent;
 await wait(20);assert.equal(probe.starts.length,1,'no scan during active connection');
 active=false;probe.beforeStop=null;auto.schedule();await wait(20);assert.equal(probe.starts.length,2);
});
test('disconnect cancels an intent waiting on probe teardown without starting a connection',async t=>{
 const probe=fakeProbe(),guard=new ConnectionGuard(),stopGate=defer();let connected=false;
 const auto=new AutoProbe({sources:{pendingIds:()=>['one']},probe,delay:5,canRun:()=>!guard.busy});t.after(()=>auto.stop());auto.enable();await wait(15);
 probe.beforeStop=stopGate.promise;const intent=guard.run(async check=>{try{await auto.pause();check();connected=true;}finally{auto.resume();}});
 guard.cancel();stopGate.resolve();await assert.rejects(intent,/لغو/);assert.equal(connected,false);probe.beforeStop=null;
 await wait(20);assert.equal(probe.starts.length,2,'pending work resumes after cancellation');
});
