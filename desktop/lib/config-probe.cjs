'use strict';
// Probe candidates with a real HTTPS request through an isolated Xray core.
// An untested or failing candidate must never be exposed to the renderer.
const path=require('node:path');
const net=require('node:net');
const dns=require('node:dns/promises');
const {performance}=require('node:perf_hooks');
const {ConfigEngine,verifyThroughProxy}=require('./config-engine.cjs');
const MAX_CONFIGS=6000, CONCURRENCY=6;

// Public Telegram text is untrusted. Resolve the configured server before
// starting Xray, reject local/reserved destinations and pin the tested address
// for both the probe and subsequent connection. This prevents ordinary DNS
// rebinding from turning an automatic scan into a request to a local service.
const blocked4=new net.BlockList(),blocked6=new net.BlockList();
for(const [address,prefix] of [
 ['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],
 ['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],
 ['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]
])blocked4.addSubnet(address,prefix,'ipv4');
// Only global IPv6 unicast, excluding transition/tunnel and documentation
// ranges. A translated or embedded private IPv4 must not bypass this check.
for(const [address,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]])blocked6.addSubnet(address,prefix,'ipv6');
const global6=new net.BlockList();global6.addSubnet('2000::',3,'ipv6');
function isPublicIP(address){const family=net.isIP(address);return family===4?!blocked4.check(address,'ipv4'):family===6&&global6.check(address,'ipv6')&&!blocked6.check(address,'ipv6');}
function pinCandidate(c,address){
 if(!isPublicIP(address))throw new Error('آدرس عمومی برای آزمون پیدا نشد.');
 const original=String(c.address||'').replace(/^\[|\]$/g,'');
 const transport={...c.transport};
 if(!net.isIP(original)&&!transport.host&&['ws','httpupgrade','xhttp'].includes(transport.network))transport.host=original;
 if(!net.isIP(original)&&transport.network==='grpc'&&!transport.authority&&!transport.host)transport.authority=original;
 return {...c,address,transport};
}
function abortable(promise,signal,timeout=4000){
 return new Promise((resolve,reject)=>{
  let done=false,timer;const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
  const abort=()=>finish(new Error('آزمون لغو شد.'));
  timer=setTimeout(()=>finish(new Error('پیدا کردن آدرس سرور زمان‌بر شد.')),timeout);timer.unref?.();
  if(signal?.aborted)return abort();signal?.addEventListener('abort',abort,{once:true});
  promise.then(value=>finish(null,value),finish);
 });
}
class PublicResolver {
 constructor(lookup=dns.lookup){this.lookup=lookup;this.cache=new Map();}
 async address(host,signal){
  host=String(host||'').replace(/^\[|\]$/g,'');
  if(net.isIP(host)){if(isPublicIP(host))return host;throw new Error('آدرس محلی مجاز نیست.');}
  const now=Date.now();let entry=this.cache.get(host);
  if(!entry||entry.expires<now){
   const promise=Promise.resolve().then(()=>this.lookup(host,{all:true,verbatim:false}));
   entry={expires:now+120000,promise};this.cache.set(host,entry);
   promise.catch(()=>{if(this.cache.get(host)===entry)this.cache.delete(host);});
   if(this.cache.size>1500)this.cache.delete(this.cache.keys().next().value);
  }
  const records=await abortable(entry.promise,signal);
  const values=(Array.isArray(records)?records:[]).map(x=>typeof x==='string'?x:x?.address).filter(isPublicIP);
  if(!values.length)throw new Error('آدرس عمومی برای آزمون پیدا نشد.');
  return values.find(x=>net.isIP(x)===4)||values[0];
 }
}
class ConfigProbe {
 constructor({binDir,dataDir,sources,devBinary=null,onChange=()=>{},verify=verifyThroughProxy,resolver=new PublicResolver()}){
  this.binDir=binDir;this.dataDir=dataDir;this.sources=sources;this.devBinary=devBinary;this.onChange=onChange;this.verify=verify;this.resolver=resolver;
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
    let e=null,ms=-1,prepared=null;
    try{
     const address=await this.resolver.address(c.address,signal);if(gen!==this.generation)break;
     prepared=pinCandidate(c,address);
     // Each worker has its own session file; no registry/system proxy changes.
     e=new ConfigEngine({binDir:this.binDir,dataDir:path.join(this.dataDir,`probe-${slot}`),devBinary:this.devBinary,proxy:{activate:async()=>{},restore:async()=>{}}});this.engines.add(e);
     const st=await e.start(prepared,{systemProxy:false,probe:false,fastProbe:true});if(gen!==this.generation)break;
     const now=performance.now(),ok=await this.verify(st.httpPort,{timeout:8000,signal});if(ok)ms=performance.now()-now;
    }catch{}finally{if(e){await e.stop().catch(()=>{});this.engines.delete(e);}}
    if(gen!==this.generation)break;this.sources.setLatency(id,ms,ms>=0?prepared:null);this.set({done:++done});
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
module.exports={ConfigProbe,PublicResolver,isPublicIP,pinCandidate,MAX_CONFIGS,CONCURRENCY};
