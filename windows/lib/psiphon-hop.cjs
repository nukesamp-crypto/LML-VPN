'use strict';
// Runs the already bundled Psiphon executable as an isolated chain hop.
// It does not change the independent Shir-o-Khorshid controller or its profile.
const fs=require('node:fs/promises');
const path=require('node:path');
const readline=require('node:readline');
const {spawn}=require('node:child_process');
const {psiphonConfig}=require('./config.cjs');

class PsiphonHop {
  constructor({binDir,dataDir,devBinary=null,onEvent=()=>{}}){
    this.binDir=binDir;this.work=path.join(dataDir,'psiphon-chain');this.devBinary=devBinary;this.onEvent=onEvent;
    this.child=null;this.startJob=null;this.stopJob=null;this.generation=0;this.rejectReady=null;this.ready=false;
  }
  active(){return !!this.child||!!this.startJob;}
  start(options={}){
    if(this.active())return Promise.reject(new Error('مسیر سایفون زنجیره در حال اجراست.'));
    const generation=++this.generation;
    const job=this._start(generation,options);this.startJob=job;
    job.then(()=>{if(this.startJob===job)this.startJob=null;},()=>{if(this.startJob===job)this.startJob=null;});
    return job;
  }
  async _start(generation,{settings,upstreamHttpPort=0,timeout=100000}={}){
    const check=()=>{if(generation!==this.generation)throw new Error('اتصال زنجیره لغو شد.');};
    const exe=this.devBinary||path.join(this.binDir,'psiphon-core.exe');
    const profile=path.join(this.binDir,'psiphon-default.json'),list=path.join(this.binDir,'server_list.dat');
    let child=null;
    try{
      await Promise.all([fs.access(exe),fs.access(profile),fs.access(list)]);check();
      await fs.mkdir(this.work,{recursive:true});check();
      const base=JSON.parse(await fs.readFile(profile,'utf8'));check();
      const config=psiphonConfig(base,settings,0,0,this.work);
      if(upstreamHttpPort){
        if(!Number.isInteger(upstreamHttpPort)||upstreamHttpPort<1||upstreamHttpPort>65535)throw new Error('پورت زنجیره نامعتبر است.');
        config.UpstreamProxyURL=`http://127.0.0.1:${upstreamHttpPort}`;
      }else delete config.UpstreamProxyURL;
      const configFile=path.join(this.work,'chain-config.json');
      await fs.writeFile(configFile,JSON.stringify(config),{mode:0o600});check();
      child=spawn(exe,['-config',configFile,'-serverList',list],{windowsHide:true,stdio:['ignore','ignore','pipe']});
      this.child=child;let httpPort=0,socksPort=0,tunnels=0,settled=false;
      const result=await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>finish(new Error('برقراری تونل سایفون بیش از حد طول کشید.')),Math.min(Math.max(timeout,1000),180000));timer.unref?.();
        const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);this.rejectReady=null;if(error)reject(error);else resolve(value);};
        this.rejectReady=error=>finish(error);
        readline.createInterface({input:child.stderr}).on('line',line=>{
          if(line.length>100000||generation!==this.generation)return;
          let notice;try{notice=JSON.parse(line);}catch{return;}
          const d=notice.data||{};
          if(notice.noticeType==='ListeningHttpProxyPort'&&Number.isInteger(d.port)&&d.port>0&&d.port<65536)httpPort=d.port;
          if(notice.noticeType==='ListeningSocksProxyPort'&&Number.isInteger(d.port)&&d.port>0&&d.port<65536)socksPort=d.port;
          if(notice.noticeType==='Tunnels'){
            const prev=tunnels;tunnels=Number(d.count)||0;
            if(settled && prev>0 && tunnels===0)this.onEvent('tunnel-lost');
            if(settled && prev===0 && tunnels>0)this.onEvent('tunnel-restored');
          }
          if(!settled&&httpPort&&socksPort&&tunnels>0){this.ready=true;finish(null,{httpPort,socksPort});}
        });
        child.once('error',()=>{
          if(this.child!==child)return;this.child=null;this.ready=false;
          if(!settled)finish(new Error('اجرای سایفون زنجیره ممکن نشد.'));else this.onEvent('process-exit');
        });
        child.once('exit',()=>{
          if(this.child!==child)return;this.child=null;this.ready=false;
          if(!settled)finish(new Error('سایفون زنجیره پیش از برقراری تونل متوقف شد.'));else this.onEvent('process-exit');
        });
      });
      check();return result;
    }catch(error){
      if(this.child===child && child){this.child=null;try{child.kill();}catch{}}
      this.ready=false;await fs.rm(path.join(this.work,'chain-config.json'),{force:true}).catch(()=>{});
      throw error;
    }
  }
  stop(){
    if(this.stopJob)return this.stopJob;
    const job=this._stop();this.stopJob=job;
    job.then(()=>{if(this.stopJob===job)this.stopJob=null;},()=>{if(this.stopJob===job)this.stopJob=null;});return job;
  }
  async _stop(){
    ++this.generation;const startJob=this.startJob,child=this.child;this.child=null;this.ready=false;
    if(this.rejectReady){const reject=this.rejectReady;this.rejectReady=null;reject(new Error('اتصال زنجیره لغو شد.'));}
    if(child)await new Promise(resolve=>{
      let done=false;const finish=()=>{if(done)return;done=true;resolve();};child.once('exit',finish);child.once('error',finish);
      try{child.kill();}catch{finish();}
      const timer=setTimeout(()=>{try{child.kill('SIGKILL');}catch{}finish();},2500);timer.unref?.();
    });
    if(startJob)await startJob.catch(()=>{});
    await fs.rm(path.join(this.work,'chain-config.json'),{force:true}).catch(()=>{});
  }
}
module.exports={PsiphonHop};
