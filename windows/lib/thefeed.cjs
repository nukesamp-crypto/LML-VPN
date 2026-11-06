'use strict';
// Independent lifecycle for the official TheFeed desktop client. It does not
// start, stop, consult or configure either VPN engine or the system proxy.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const {spawn} = require('node:child_process');
const {EventEmitter} = require('node:events');
const {ensureOfficialResolvers,validateOfficialResolvers} = require('./thefeed-resolvers.cjs');

const RELEASE = 'v0.41.0';
const WINDOWS_SHA256 = '2ab0e12b192469739bc955c6583f0498f93d4339b9730bc246065f11680911bf';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash=crypto.createHash('sha256');
    const stream=fs.createReadStream(file);
    stream.on('error',reject);
    stream.on('data',chunk=>hash.update(chunk));
    stream.on('end',()=>resolve(hash.digest('hex')));
  });
}
function tryPort(port) {
  return new Promise(resolve => {
    const s=net.createServer();
    s.unref();
    s.once('error',()=>resolve(0));
    s.listen({host:'127.0.0.1',port,exclusive:true},()=>{
      const got=s.address().port;
      s.close(()=>resolve(got));
    });
  });
}
async function choosePort(preferred) {
  // Reuse a stable localStorage origin across launches where possible.
  const candidates=[];
  if(Number.isInteger(preferred) && preferred>=19760 && preferred<=19799) candidates.push(preferred);
  for(let p=19760;p<=19799;p++) if(p!==preferred) candidates.push(p);
  for(const p of candidates) { const got=await tryPort(p); if(got) return got; }
  const ephemeral=await tryPort(0);
  if(!ephemeral) throw new Error('پورت محلی آزاد برای TheFeed پیدا نشد.');
  return ephemeral;
}
function probe(port,secret) {
  return new Promise(resolve=>{
    let settled=false;
    const finish=x=>{if(!settled){settled=true;resolve(x);}};
    const req=http.get({host:'127.0.0.1',port,path:'/api/status',timeout:800,
      headers:{Authorization:'Basic '+Buffer.from('lml:'+secret).toString('base64')}},res=>{
      let body='';res.setEncoding('utf8');
      res.on('data',chunk=>{body+=chunk;if(body.length>16384)req.destroy();});
      res.on('end',()=>{
        try { const value=JSON.parse(body); finish(res.statusCode===200 && value.hasPassword===true && typeof value.version==='string' ? value : null); }
        catch {finish(null);}
      });
    });
    req.on('timeout',()=>req.destroy());req.on('error',()=>finish(null));
  });
}

function localGet(port,secret,url,maxBytes=1024*1024) {
  return new Promise((resolve,reject)=>{
    const req=http.get({host:'127.0.0.1',port,path:url,timeout:3000,
      headers:{Authorization:'Basic '+Buffer.from('lml:'+secret).toString('base64')}},res=>{
      const chunks=[];let size=0;
      res.on('data',chunk=>{size+=chunk.length;if(size>maxBytes)req.destroy(new Error('response too large'));else chunks.push(chunk);});
      res.on('end',()=>res.statusCode===200?resolve(Buffer.concat(chunks).toString('utf8')):reject(new Error('local core response '+res.statusCode)));
      res.on('error',reject);
    });
    req.on('timeout',()=>req.destroy(new Error('local core timeout')));req.on('error',reject);
  });
}
async function inspectCore(executable,{expectedVersion,checkUI=false,onSpawn=()=>{},cancelled=()=>false,timeout=15000}={}){
  // Use a temporary, empty profile and a separate loopback-only process. This
  // asks the *actual* executable for its DNS preset without racing or changing
  // the user's real profiles, settings, scores or currently selected list.
  const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'lml-thefeed-inspect-'));
  let child=null;
  try {
    const port=await tryPort(0);if(!port || cancelled())throw new Error('core inspection cancelled');
    const secret=crypto.randomBytes(32).toString('base64url');
    child=spawn(executable,['-data-dir',dir,'-host','127.0.0.1','-port',String(port),'-password',secret,'-open=false'],{
      windowsHide:true,stdio:['ignore','ignore','pipe'],env:{...process.env,THEFEED_STORE_BUILD:'1'}
    });
    onSpawn(child);child.stderr.on('data',()=>{});
    let failed=null,exited=false;
    child.once('error',e=>{failed=e;});child.once('exit',()=>{exited=true;});
    const end=Date.now()+timeout;let status=null;
    while(Date.now()<end && !failed && !exited && !cancelled()){
      status=await probe(port,secret);if(status)break;await delay(100);
    }
    if(!status || cancelled())throw failed || new Error('official core unavailable');
    if(expectedVersion && status.version!==expectedVersion)throw new Error('unexpected core version');
    const defaults=JSON.parse(await localGet(port,secret,'/api/profiles/defaults'));
    const resolvers=validateOfficialResolvers(defaults.resolvers);
    if(!Array.isArray(defaults.profiles))throw new Error('incompatible default profiles API');
    if(checkUI){
      const html=await localGet(port,secret,'/');
      for(const tab of ['Feed','Mirror','Chat','Tel','Resolver','Settings'])
        if(!html.includes('id="navTab'+tab+'"'))throw new Error('incompatible upstream UI');
    }
    return {version:status.version,resolvers};
  } finally {
    if(child){
      await new Promise(resolve=>{
        if(child.exitCode!==null || child.signalCode!==null)return resolve();
        let done=false;const finish=()=>{if(!done){done=true;resolve();}};
        child.once('exit',finish);child.once('error',finish);
        try{child.kill();}catch{finish();}
        const timer=setTimeout(finish,2000);timer.unref();
      });
      onSpawn(null);
    }
    await fsp.rm(dir,{recursive:true,force:true}).catch(()=>{});
  }
}

class ThefeedController extends EventEmitter {
  constructor({executable,dataDir,expectedHash=WINDOWS_SHA256,timeout=20000,env={},updater=null}) {
    super();
    this.executable=executable;this.dataDir=dataDir;this.expectedHash=expectedHash;this.timeout=timeout;this.extraEnv=env;this.updater=updater;
    this.child=null;this.inspectionChild=null;this.endpoint=null;this.starting=null;this.stopping=false;this.generation=0;
  }
  async start() {
    if(this.endpoint && this.child && !this.child.killed) return this.endpoint;
    if(this.starting) return this.starting;
    const generation=++this.generation;
    this.starting=this._start(generation).finally(()=>{this.starting=null;});
    return this.starting;
  }
  async _start(generation) {
    try {
      if(this.expectedHash && await sha256(this.executable)!==this.expectedHash) throw new Error('فایل رسمی TheFeed آسیب دیده یا تغییر کرده است؛ نصب را دوباره انجام بده.');
    } catch(e) {
      if(e && e.code==='ENOENT') throw new Error('فایل TheFeed پیدا نشد؛ نصب برنامه را بررسی کن.');
      throw e;
    }
    await fsp.mkdir(this.dataDir,{recursive:true});
    if(generation!==this.generation)throw new Error('راه‌اندازی TheFeed لغو شد.');
    // A previously downloaded release is hash-verified before use. A failed
    // or absent update falls back to the bundled official core.
    const cached=this.updater?await this.updater.cached().catch(()=>null):null;
    let executable=cached?.path || this.executable;
    let defaults;
    const inspect=(file,version)=>inspectCore(file,{expectedVersion:version,
      onSpawn:child=>{this.inspectionChild=child;},cancelled:()=>generation!==this.generation,timeout:this.timeout});
    try {
      try { defaults=await inspect(executable,cached?.version); }
      catch(err){
        if(!cached || generation!==this.generation)throw err;
        // Antivirus, permissions or a later incompatibility must not prevent
        // opening the bundled, pinned core when a cached update fails.
        await this.updater.invalidate(cached).catch(()=>{});
        executable=this.executable;defaults=await inspect(executable);
      }
      if(generation!==this.generation)throw new Error('cancelled');
      await ensureOfficialResolvers(this.dataDir,defaults.resolvers,defaults.version);
    } catch {
      if(generation!==this.generation)throw new Error('راه‌اندازی TheFeed لغو شد.');
      throw new Error('خواندن DNS از هستهٔ TheFeed ممکن نشد. اطلاعات قبلی حفظ شده‌اند؛ دوباره تلاش کن.');
    }
    if(generation!==this.generation)throw new Error('راه‌اندازی TheFeed لغو شد.');
    let preferred=0;
    try { preferred=Number(await fsp.readFile(path.join(this.dataDir,'local-port.txt'),'utf8')); } catch {}
    const port=await choosePort(preferred);
    if(generation!==this.generation)throw new Error('راه‌اندازی TheFeed لغو شد.');
    const secret=crypto.randomBytes(32).toString('base64url');
    // The official CLI accepts the loopback password as a command-line flag.
    // Do not pass it to a renderer, expose it over IPC or put it in a URL/log.
    const args=['-data-dir',this.dataDir,'-host','127.0.0.1','-port',String(port),'-password',secret,'-open=false'];
    const child=spawn(executable,args,{
      windowsHide:true,stdio:['ignore','ignore','pipe'],
      env:{...process.env,...this.extraEnv,THEFEED_STORE_BUILD:'1'}
    });
    this.child=child;this.stopping=false;
    let failure=null;
    child.stderr.on('data',()=>{}); // drain without recording network or private profile data
    child.once('error',err=>{failure=err;});
    child.once('exit',(code,signal)=>{
      if(this.child!==child)return;
      this.child=null;this.endpoint=null;
      if(!this.stopping) this.emit('unexpected-exit',{code,signal});
    });
    const end=Date.now()+this.timeout;
    while(Date.now()<end) {
      if(failure || this.child!==child || generation!==this.generation) break;
      const status=await probe(port,secret);
      if(status) {
        if(this.child!==child || generation!==this.generation)break;
        // Only the Electron main process holds the HTTP Basic password.
        this.endpoint={origin:`http://127.0.0.1:${port}`,secret,version:status.version,port};
        await fsp.writeFile(path.join(this.dataDir,'local-port.txt'),String(port),{mode:0o600}).catch(()=>{});
        return this.endpoint;
      }
      await delay(150);
    }
    if(this.child===child) {this.stopping=true;try{child.kill();}catch{}this.child=null;this.stopping=false;}
    if(failure && failure.code==='ENOENT') throw new Error('اجرای فایل TheFeed ممکن نشد؛ نصب را بررسی کن.');
    throw new Error('TheFeed راه‌اندازی نشد. دوباره تلاش کن یا نصب برنامه را بررسی کن.');
  }
  async stop() {
    ++this.generation; // cancel a start even if the executable has not spawned yet
    if(this.updater)this.updater.cancel();
    if(this.inspectionChild){try{this.inspectionChild.kill();}catch{}}
    const child=this.child;
    if(!child)return;
    this.stopping=true;this.child=null;this.endpoint=null;
    await new Promise(resolve=>{
      let done=false;const end=()=>{if(!done){done=true;resolve();}};
      child.once('exit',end);child.once('error',end);
      try{child.kill();}catch{end();}
      const t=setTimeout(end,2000);t.unref();
    });
    this.stopping=false;
  }
}
module.exports={ThefeedController,RELEASE,WINDOWS_SHA256,choosePort,probe,sha256,inspectCore};
