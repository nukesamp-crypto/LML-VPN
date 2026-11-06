'use strict';
// Measure an actual HTTPS request via each selected config from this device.
// This does not pretend that TheFeed's DNS reader is a general TCP proxy.
const path=require('node:path');
const {performance}=require('node:perf_hooks');
const {ConfigEngine,verifyThroughProxy}=require('./config-engine.cjs');
const MAX_CONFIGS=500, CONCURRENCY=3;
class ConfigProbe {
 constructor({binDir,dataDir,sources,devBinary=null,onChange=()=>{},verify=verifyThroughProxy}){
  this.binDir=binDir;this.dataDir=dataDir;this.sources=sources;this.devBinary=devBinary;this.onChange=onChange;this.verify=verify;
  this.job=null;this.engines=new Set();this.generation=0;this.aborter=null;this.state={running:false,done:0,total:0};
 }
 snapshot(){return {...this.state};}
 set(value){this.state={...this.state,...value};this.onChange(this.snapshot());}
 start(ids){
  if(this.job)throw new Error('آزمون دیگری در حال انجام است.');
  const list=[...new Set(Array.isArray(ids)?ids:[])].filter(id=>typeof id==='string'&&this.sources.get(id)).slice(0,MAX_CONFIGS);
  if(!list.length)throw new Error('کانفیگی برای آزمایش انتخاب نشده است.');
  const gen=++this.generation;this.aborter=new AbortController();this.set({running:true,done:0,total:list.length});
  const job=this._run(gen,list,this.aborter.signal);this.job=job;
  job.then(()=>{if(this.job===job)this.job=null;},()=>{if(this.job===job)this.job=null;});return this.snapshot();
 }
 async _run(gen,list,signal){
  let next=0,done=0;
  const worker=async slot=>{
   while(gen===this.generation){
    const index=next++;if(index>=list.length)break;const id=list[index],c=this.sources.get(id);
    if(!c){if(gen===this.generation)this.set({done:++done});continue;}
    // Every worker has its own session file; no registry or system proxy changes.
    const e=new ConfigEngine({binDir:this.binDir,dataDir:path.join(this.dataDir,`probe-${slot}`),devBinary:this.devBinary,proxy:{activate:async()=>{},restore:async()=>{}}});this.engines.add(e);
    let ms=-1;
    try{
     const st=await e.start(c,{systemProxy:false,probe:false});if(gen!==this.generation)break;
     const now=performance.now(),ok=await this.verify(st.httpPort,{timeout:8000,signal});if(ok)ms=performance.now()-now;
    }catch{}finally{await e.stop().catch(()=>{});this.engines.delete(e);}
    if(gen!==this.generation)break;this.sources.setLatency(id,ms);this.set({done:++done});
   }
  };
  try{await Promise.all(Array.from({length:Math.min(CONCURRENCY,list.length)},(_,i)=>worker(i)));}
  finally{if(gen===this.generation)this.set({running:false});}
 }
 async stop(){
  ++this.generation;this.aborter?.abort();const job=this.job;
  await Promise.all([...this.engines].map(e=>e.stop().catch(()=>{})));
  if(job)await job.catch(()=>{});this.set({running:false});
 }
}
module.exports={ConfigProbe,MAX_CONFIGS,CONCURRENCY};
