'use strict';
// Bridge a streaming candidate list to a bounded, cancellable probe. It does
// not start while any user connection is active. IDs added mid-batch are picked
// up on the next batch; a user stop persists until they explicitly refresh.
class AutoProbe {
 constructor({sources,probe,canRun=()=>true,canFinish=()=>false,onState=()=>{},delay=120}){
  this.sources=sources;this.probe=probe;this.canRun=canRun;this.canFinish=canFinish;this.onState=onState;this.delay=delay;
  this.enabled=false;this.paused=false;this.closed=false;this.timer=null;
 }
 schedule(){
  if(this.closed||!this.enabled||this.paused||this.timer)return;
  this.timer=setTimeout(()=>{
   this.timer=null;
   if(this.closed||!this.enabled||this.paused||!this.canRun()||this.probe.snapshot().running||this.probe.job)return;
   const ids=this.sources.pendingIds();
   if(!ids.length){if(this.canFinish()){this.enabled=false;this.onState(false);}return;}
   try{this.probe.start(ids);}catch{/* A concurrent stop/start can be retried on the next event. */}
  },this.delay);this.timer.unref?.();
 }
 enable(){if(!this.enabled){this.enabled=true;this.onState(true);}this.schedule();}
 async pause(){
  this.paused=true;if(this.timer){clearTimeout(this.timer);this.timer=null;}
  // A finishing job may have published running=false but still be settling.
  // Await it too before a user connection gets the network and local ports.
  if(this.probe.job||this.probe.snapshot().running)await this.probe.stop();
 }
 resume(){this.paused=false;this.schedule();}
 async disable(){if(this.enabled){this.enabled=false;this.onState(false);}await this.pause();this.paused=false;}
 async stop(){this.closed=true;await this.pause();}
}
module.exports={AutoProbe};
