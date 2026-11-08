'use strict';
// This measures an authenticated HTTPS response over Windows' current route;
// with Lantern connected that route normally enters its TUN, but Lantern's
// split-routing rules can send a destination directly. This is not ICMP.
const https=require('node:https');
const {performance}=require('node:perf_hooks');
function systemHttpsPing({host='www.cloudflare.com',port=443,path='/cdn-cgi/trace',timeout=10000,signal=null,request=https.request}={}){
 return new Promise(resolve=>{
  const started=performance.now();let req,done=false;
  const finish=(ok)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);try{req?.destroy();}catch{}resolve(ok?Math.max(1,Math.round(performance.now()-started)):-1);};
  const abort=()=>finish(false),timer=setTimeout(()=>finish(false),timeout);timer.unref?.();
  if(signal?.aborted)return abort();signal?.addEventListener('abort',abort,{once:true});
  try{req=request({host,port,path,method:'HEAD',agent:false,servername:host,rejectUnauthorized:true},res=>{
    res.resume();finish(Number.isInteger(res.statusCode)&&res.statusCode>=100&&res.statusCode<=599);
   });req.once('error',()=>finish(false));req.end();}catch{finish(false);}
 });
}
class LanternPing {
 constructor({selected,system=systemHttpsPing,onChange=()=>{},interval=30000,clock=()=>Date.now()}){
  this.selected=selected;this.system=system;this.onChange=onChange;this.interval=interval;this.clock=clock;this.generation=0;this.job=null;this.aborter=null;this.last=0;this.state={pingMs:null,pingSource:null};this.connected=false;
 }
 update(connected){
  if(!connected){if(this.connected||this.job){++this.generation;this.aborter?.abort();this.job=null;this.aborter=null;}this.connected=false;this.last=0;this.state={pingMs:null,pingSource:null};return this.state;}
  if(!this.connected){this.connected=true;this.last=0;}
  if(!this.job&&(!this.last||this.clock()-this.last>=this.interval))this.start();
  return {...this.state};
 }
 start(){
  const gen=this.generation,controller=new AbortController();this.aborter=controller;this.last=this.clock();
  const job=(async()=>{
   let ms=null,source='lantern';
   try{ms=await this.selected({timeout:3000,signal:controller.signal});}catch{}
   if(controller.signal.aborted)return;
   if(!Number.isFinite(ms)||ms<=0){source='system';try{ms=await this.system({signal:controller.signal});}catch{ms=-1;}}
   if(gen!==this.generation||!this.connected||controller.signal.aborted)return;
   this.state={pingMs:Number.isFinite(ms)&&ms>0?Math.round(ms):-1,pingSource:source};this.onChange({...this.state});
  })();this.job=job;
  job.finally(()=>{if(this.job===job){this.job=null;this.aborter=null;}}).catch(()=>{});
 }
}
module.exports={systemHttpsPing,LanternPing};
