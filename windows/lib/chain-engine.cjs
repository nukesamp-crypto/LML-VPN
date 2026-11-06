'use strict';
// Two explicit local process chains using the application's existing cores.
// The last local HTTP listener owns system proxy; no remote peer sees it.
const {verifyThroughProxy}=require('./config-engine.cjs');
const {performance}=require('node:perf_hooks');
const MODES=new Set(['psiphon-via-xray','xray-via-psiphon']);
class ChainEngine {
  constructor({xray,hop,proxy,onChange=()=>{},verify=verifyThroughProxy}){
    this.xray=xray;this.hop=hop;this.proxy=proxy;this.onChange=onChange;this.verify=verify;
    this.startJob=null;this.stopJob=null;this.generation=0;this.proxyOn=false;this.stopping=false;
    this.state={state:'disconnected',detail:'آمادهٔ انتخاب حالت اتصال',httpPort:0,socksPort:0,tested:null,mode:'',name:'',id:'',pingMs:null,connectedAt:null};
    this.hop.onEvent=event=>this.onHopEvent(event);
  }
  snapshot(){return {...this.state};}
  set(state,detail,extra={}){const connectedAt=state==='connected'?(this.state.state==='connected'?this.state.connectedAt:Date.now()):null;this.state={...this.state,state,detail,connectedAt,...extra};this.onChange(this.snapshot());}
  active(){return !!this.startJob||!!this.stopJob||this.hop.active()||['connecting','connected','disconnecting'].includes(this.state.state);}
  start(config,{mode,settings,systemProxy=true,routing=null}={}){
    if(this.active()||this.xray.active())throw new Error('ابتدا اتصال فعلی را قطع کن.');
    if(!MODES.has(mode))throw new Error('حالت زنجیره معتبر نیست.');
    const generation=++this.generation;
    this.set('connecting','در حال آماده‌سازی دو مسیر اتصال…',{mode,name:config?.remark||config?.scheme?.toUpperCase()||'',id:config?.id||'',tested:null,pingMs:null,httpPort:0,socksPort:0});
    // Return immediately: UI can cancel a slow Psiphon handshake.
    const job=this._start(generation,config,{mode,settings,systemProxy,routing});this.startJob=job;
    job.then(()=>{if(this.startJob===job)this.startJob=null;},()=>{if(this.startJob===job)this.startJob=null;});
    return this.snapshot();
  }
  async _start(generation,config,{mode,settings,systemProxy,routing}){
    const check=()=>{if(generation!==this.generation)throw new Error('اتصال زنجیره لغو شد.');};
    try{
      let finalPort,finalSocks;
      if(mode==='psiphon-via-xray'){
        this.set('connecting','در حال آماده‌سازی مسیر کانفیگ…');
        const first=await this.xray.start(config,{systemProxy:false});check();
        this.set('connecting','در حال اتصال سایفون از مسیر کانفیگ…');
        const second=await this.hop.start({settings,upstreamHttpPort:first.httpPort});check();
        finalPort=second.httpPort;finalSocks=second.socksPort;
      }else{
        this.set('connecting','در حال آماده‌سازی مسیر سایفون…');
        const first=await this.hop.start({settings});check();
        this.set('connecting','در حال اتصال کانفیگ از مسیر سایفون…');
        const second=await this.xray.start(config,{systemProxy:false,upstreamSocksPort:first.socksPort,routing});check();
        finalPort=second.httpPort;finalSocks=second.socksPort;
      }
      if(systemProxy){
        await this.proxy.activate(finalPort);this.proxyOn=true;
        if(generation!==this.generation){await this.proxy.restore();this.proxyOn=false;check();}
      }
      check();this.set('connected',systemProxy?'زنجیره آماده است؛ در حال بررسی مسیر HTTPS…':`HTTP محلی: 127.0.0.1:${finalPort}؛ در حال بررسی مسیر…`,{httpPort:finalPort,socksPort:finalSocks,tested:null});
      this.checkRoute(generation,finalPort,systemProxy);
    }catch(error){
      if(generation!==this.generation)return;
      // Clean up both hops before exposing failure. Do not leave an orphaned
      // local proxy or another process listening after a failed handshake.
      this.stopping=true;
      await Promise.allSettled([this.hop.stop(),this.xray.stop()]);
      if(this.proxyOn){try{await this.proxy.restore();}catch{}this.proxyOn=false;}
      this.stopping=false;
      if(generation===this.generation)this.set('error',error?.message||'برقراری زنجیره ممکن نشد.',{httpPort:0,socksPort:0,tested:false});
    }
  }
  checkRoute(generation,port,systemProxy){
    const started=performance.now();
    void this.verify(port).then(ok=>{
      if(generation!==this.generation||this.state.state!=='connected')return;
      const label=systemProxy?'پراکسی ویندوز':`HTTP محلی 127.0.0.1:${port}`;
      this.set('connected',ok?`${label} فعال است و آزمون HTTPS زنجیره موفق بود.`:`${label} فعال است، اما آزمون HTTPS موفق نشد؛ مسیر یا کانفیگ دیگری را امتحان کن.`,{tested:ok,pingMs:ok?Math.max(1,Math.round(performance.now()-started)):-1});
    }).catch(()=>{
      if(generation===this.generation&&this.state.state==='connected')this.set('connected','آزمون HTTPS زنجیره موفق نشد.',{tested:false,pingMs:-1});
    });
  }
  onHopEvent(event){
    if(this.stopping||!['connected','connecting'].includes(this.state.state))return;
    if(event==='process-exit'){this.fail('موتور سایفون زنجیره متوقف شد.');return;}
    if(event==='tunnel-lost'&&this.state.state==='connected')this.set('connecting','تونل سایفون قطع شد؛ در حال تلاش دوباره…',{tested:null});
    if(event==='tunnel-restored'&&this.state.state==='connecting'&&this.state.httpPort){
      this.set('connected','تونل دوباره برقرار شد؛ در حال بررسی مسیر…',{tested:null});this.checkRoute(this.generation,this.state.httpPort,this.proxyOn);
    }
  }
  onXrayState(state){
    if(!this.stopping && state?.state==='error' && this.state.state==='connected')this.fail('موتور کانفیگ زنجیره متوقف شد.');
  }
  fail(detail){
    if(this.stopping||this.stopJob)return;const before=this.generation;
    void this.stop().then(()=>{if(this.generation===before+1)this.set('error',detail,{tested:false,httpPort:0,socksPort:0});}).catch(()=>{});
  }
  stop(){
    if(this.stopJob)return this.stopJob;
    const job=this._stop();this.stopJob=job;
    job.then(()=>{if(this.stopJob===job)this.stopJob=null;},()=>{if(this.stopJob===job)this.stopJob=null;});return job;
  }
  async _stop(){
    ++this.generation;this.stopping=true;const startJob=this.startJob;
    this.set('disconnecting','در حال قطع هر دو مسیر زنجیره…');
    await Promise.allSettled([this.hop.stop(),this.xray.stop()]);
    if(startJob)await startJob.catch(()=>{});
    if(this.proxyOn){
      try{await this.proxy.restore();}catch{this.stopping=false;this.set('error','بازگرداندن پراکسی ویندوز ممکن نشد؛ تنظیمات ویندوز را بررسی کن.');throw new Error('بازگرداندن پراکسی ویندوز ممکن نشد.');}
      this.proxyOn=false;
    }
    this.stopping=false;this.set('disconnected','اتصال زنجیره قطع شد.',{httpPort:0,socksPort:0,tested:null,mode:'',name:'',id:'',pingMs:null});return this.snapshot();
  }
}
module.exports={ChainEngine,MODES};
