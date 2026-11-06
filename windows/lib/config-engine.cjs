'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const net=require('node:net');
const http=require('node:http');
const tls=require('node:tls');
const {spawn,execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {performance}=require('node:perf_hooks');
const {sha256}=require('./thefeed.cjs');
const {buildXray}=require('./config-links.cjs');
const exec=promisify(execFile);
const XRAY_SHA256='3cd61d792040a553614f6995ed74c5a0a2c98e3caf0edbe6e72e58694f490f39';
const CRONET_SHA256='3217c6260fbca5f16072e0b79735742f40109a63bb0ff88fd6b96dd6b54a2928';
const GEOIP_SHA256='4ff4b2ec242a9e87b296ba27ddb85f8311e8d3e071eaebac5be9231c60e408dd';
const GEOSITE_SHA256='78188a409b130ea5537a56941cca0d2f88d33f4a5e3a1bc0a7c2db5681ff4c0b';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});}
function accepts(port){return new Promise(resolve=>{const s=net.connect({host:'127.0.0.1',port});const end=x=>{s.destroy();resolve(x);};s.setTimeout(250);s.once('connect',()=>end(true));s.once('error',()=>end(false));s.once('timeout',()=>end(false));});}
function verifyThroughProxy(port,{host='www.cloudflare.com',timeout=12000,signal=null}={}){
  // No secrets are sent to the test endpoint. The request is tunnelled all the
  // way through the chosen server and authenticated HTTPS, not just to Xray's
  // local listening socket. A failure is not proof that all destinations fail.
  return new Promise(resolve=>{
    let done=false,secure=null,socket=null;
    let req=null;const abort=()=>finish(false);
    const finish=ok=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);try{req?.destroy();}catch{}try{secure?.destroy();}catch{}try{socket?.destroy();}catch{}resolve(ok);};
    const timer=setTimeout(()=>finish(false),timeout);timer.unref?.();
    if(signal?.aborted)return finish(false);signal?.addEventListener('abort',abort,{once:true});
    req=http.request({host:'127.0.0.1',port,method:'CONNECT',path:host+':443',headers:{Host:host+':443'},timeout},res=>{res.resume();finish(false);});
    req.once('error',()=>finish(false));req.once('timeout',()=>{req.destroy();finish(false);});
    req.once('connect',(res,s,head)=>{
      socket=s;if(res.statusCode!==200)return finish(false);if(head?.length)s.unshift(head);
      secure=tls.connect({socket:s,servername:host,rejectUnauthorized:true},()=>secure.write(`HEAD /cdn-cgi/trace HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
      let data='';secure.setEncoding('utf8');secure.on('data',chunk=>{data+=chunk;if(data.includes('\r\n'))finish(/^HTTP\/1\.[01] [1-5]\d\d/.test(data));});
      secure.once('error',()=>finish(false));secure.once('end',()=>finish(false));
    });req.end();
  });
}
class ConfigEngine {
  constructor({binDir,dataDir,proxy,onChange=()=>{},platform=process.platform,devBinary=null,verify=verifyThroughProxy}){
    this.binDir=binDir;this.work=path.join(dataDir,'config-engine');this.file=path.join(this.work,'session.json');
    this.proxy=proxy;this.onChange=onChange;this.platform=platform;this.devBinary=devBinary;this.verify=verify;
    this.proc=null;this.startJob=null;this.stopJob=null;this.generation=0;this.proxyOn=false;this.busy=false;
    this.state={state:'disconnected',detail:'آمادهٔ انتخاب کانفیگ',httpPort:0,socksPort:0,tested:null,name:'',id:'',pingMs:null,connectedAt:null};
  }
  set(state,detail,extra={}){
    const connectedAt=state==='connected'?(this.state.state==='connected'?this.state.connectedAt:Date.now()):null;
    this.state={...this.state,state,detail,connectedAt,...extra};this.onChange({...this.state});
  }
  snapshot(){return {...this.state};}
  active(){return this.busy||!!this.proc||['connecting','connected','disconnecting'].includes(this.state.state);}
  async cleanup(){await fs.rm(this.file,{force:true}).catch(()=>{});}
  start(c,options={}){
    if(this.startJob)return Promise.reject(new Error('ابتدا اتصال کانفیگ فعلی را قطع کن.'));
    const job=this._start(c,options);this.startJob=job;
    job.then(()=>{if(this.startJob===job)this.startJob=null;},()=>{if(this.startJob===job)this.startJob=null;});
    return job;
  }
  async _start(c,{systemProxy=true,upstreamSocksPort=0,routing=null,probe=true}={}){
    if(this.active())throw new Error('ابتدا اتصال کانفیگ فعلی را قطع کن.');
    if(!c)throw new Error('یک کانفیگ را انتخاب کن.');
    if(this.platform!=='win32'&&!this.devBinary)throw new Error('اتصال کانفیگ در این نسخه فقط برای ویندوز است.');
    const generation=++this.generation;this.busy=true;this.set('connecting','در حال آماده‌سازی هستهٔ اتصال…',{httpPort:0,socksPort:0,tested:null,name:c.remark||c.scheme.toUpperCase(),id:c.id||'',pingMs:null});
    const exe=this.devBinary||path.join(this.binDir,'xray-windows.exe');
    const check=()=>{if(generation!==this.generation)throw new Error('اتصال لغو شد.');};
    try{
      if(!this.devBinary){
        if(await sha256(exe)!==XRAY_SHA256||await sha256(path.join(this.binDir,'libcronet.dll'))!==CRONET_SHA256)throw new Error('هستهٔ اتصال آسیب دیده یا تغییر کرده است؛ نصب را بررسی کن.');
      }
      if(routing){
        const serialized=JSON.stringify(routing);
        if(serialized.includes('geoip:') && await sha256(path.join(this.binDir,'geoip.dat'))!==GEOIP_SHA256)throw new Error('فهرست IP مسیریابی آسیب دیده است.');
        if(serialized.includes('geosite:') && await sha256(path.join(this.binDir,'geosite.dat'))!==GEOSITE_SHA256)throw new Error('فهرست دامنهٔ مسیریابی آسیب دیده است.');
      }
      check();await fs.mkdir(this.work,{recursive:true});await this.cleanup();
      const httpPort=await freePort();let socksPort=await freePort();while(socksPort===httpPort)socksPort=await freePort();check();
      const conf=buildXray(c,httpPort,socksPort,{upstreamSocksPort,routing});await fs.writeFile(this.file,JSON.stringify(conf),{mode:0o600});check();
      const env={...process.env,XRAY_LOCATION_ASSET:this.binDir};
      try{await exec(exe,['run','-test','-c',this.file],{windowsHide:true,timeout:15000,maxBuffer:256*1024,env});}
      catch{throw new Error('این ترکیب پروتکل یا تنظیمات توسط هسته پذیرفته نشد.');}
      check();
      const child=spawn(exe,['run','-c',this.file],{windowsHide:true,stdio:['ignore','ignore','pipe'],cwd:this.work,env});this.proc=child;
      child.stderr.on('data',()=>{});child.once('error',()=>{if(this.proc===child){this.proc=null;void this.cleanup();this.set('error','اجرای هستهٔ اتصال ممکن نشد.');}});
      child.once('exit',()=>{
        if(this.proc!==child)return;this.proc=null;void this.cleanup();
        const wasProxy=this.proxyOn;this.proxyOn=false;
        void (async()=>{if(wasProxy){try{await this.proxy.restore();}catch{this.set('error','موتور متوقف شد؛ پراکسی ویندوز را بررسی کن.');return;}}
          if(generation===this.generation)this.set('error','هستهٔ اتصال متوقف شد.',{httpPort:0,socksPort:0,tested:false});})();
      });
      const end=Date.now()+12000;let ready=false;
      while(Date.now()<end && this.proc===child && generation===this.generation){if(await accepts(httpPort)){ready=true;break;}await pause(120);}
      check();if(!ready||this.proc!==child)throw new Error('پراکسی محلی راه‌اندازی نشد.');
      if(systemProxy){
        await this.proxy.activate(httpPort);this.proxyOn=true;
        // Cancellation or a core crash may happen while Windows registry I/O
        // is in flight. Never leave the newly installed proxy behind.
        if(generation!==this.generation || this.proc!==child){
          try{await this.proxy.restore();}finally{this.proxyOn=false;}
          throw new Error('اتصال لغو شد یا هسته متوقف شد.');
        }
      }
      check();if(this.proc!==child)throw new Error('هستهٔ اتصال متوقف شد.');
      this.set('connected',systemProxy?'پراکسی ویندوز فعال است؛ در حال آزمایش مسیر…':`پراکسی محلی HTTP: 127.0.0.1:${httpPort}؛ در حال آزمایش مسیر…`,{httpPort,socksPort,tested:null});
      // Do not block the UI on a slow or dead public endpoint.
      const probeStarted=performance.now();
      if(probe) void this.verify(httpPort).then(ok=>{
        if(this.proc!==child||generation!==this.generation)return;
        const prefix=systemProxy?'پراکسی ویندوز':`HTTP 127.0.0.1:${httpPort}`;
        this.set('connected',ok?`${prefix} فعال است و آزمون HTTPS موفق بود.`:`${prefix} فعال است، اما آزمون HTTPS موفق نشد؛ کانفیگ دیگری را امتحان کن.`,{tested:ok,pingMs:ok?Math.max(1,Math.round(performance.now()-probeStarted)):-1});
      });
      return this.snapshot();
    }catch(e){
      if(generation===this.generation){
        const child=this.proc;this.proc=null;if(child)try{child.kill();}catch{}
        if(this.proxyOn){this.proxyOn=false;try{await this.proxy.restore();}catch{}}
        await this.cleanup();this.set('error',e?.message||'اتصال انجام نشد.',{httpPort:0,socksPort:0,tested:false});
      }
      throw e;
    }finally{if(generation===this.generation)this.busy=false;}
  }
  stop(){
    if(this.stopJob)return this.stopJob;
    const job=this._stop();this.stopJob=job;
    job.then(()=>{if(this.stopJob===job)this.stopJob=null;},()=>{if(this.stopJob===job)this.stopJob=null;});
    return job;
  }
  async _stop(){
    ++this.generation;this.busy=false;const child=this.proc,startJob=this.startJob;this.proc=null;
    this.set('disconnecting','در حال قطع اتصال…');
    if(child){await new Promise(resolve=>{let done=false;const end=()=>{if(done)return;done=true;resolve();};child.once('exit',end);try{child.kill();}catch{end();}const t=setTimeout(()=>{try{child.kill('SIGKILL');}catch{}end();},2500);t.unref?.();});}
    // Wait for a pending start, especially a registry activation already in
    // flight, before claiming shutdown is complete or quitting the app.
    if(startJob)await startJob.catch(()=>{});
    if(this.proxyOn){this.proxyOn=false;try{await this.proxy.restore();}catch{this.set('error','بازگرداندن پراکسی قبلی ممکن نشد؛ تنظیمات ویندوز را بررسی کن.');throw new Error('بازگرداندن پراکسی قبلی ممکن نشد.');}}
    await this.cleanup();this.set('disconnected','اتصال کانفیگ قطع است.',{httpPort:0,socksPort:0,tested:null,name:'',id:'',pingMs:null});return this.snapshot();
  }
}
module.exports={ConfigEngine,XRAY_SHA256,CRONET_SHA256,GEOIP_SHA256,GEOSITE_SHA256,freePort,verifyThroughProxy};
