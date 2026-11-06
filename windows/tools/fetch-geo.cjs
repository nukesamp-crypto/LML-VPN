'use strict';
// Re-fetch the pinned routing data; verify bytes before use.
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path');
const {Readable}=require('node:stream'),{pipeline}=require('node:stream/promises');
const {sha256}=require('../lib/thefeed.cjs');
const {GEOIP_SHA256,GEOSITE_SHA256}=require('../lib/config-engine.cjs');
const files=[
 ['geoip.dat','https://github.com/v2fly/geoip/releases/download/202610050438/geoip.dat',GEOIP_SHA256],
 ['geosite.dat','https://github.com/v2fly/domain-list-community/releases/download/20261102130044/dlc.dat',GEOSITE_SHA256]
];
(async()=>{
 const directory=path.join(__dirname,'..','resources','bin');await fsp.mkdir(directory,{recursive:true});
 for(const [name,url,expected] of files){
  const target=path.join(directory,name),temp=target+'.download';
  try{const r=await fetch(url,{signal:AbortSignal.timeout(120000),redirect:'follow'});if(!r.ok||!r.body)throw new Error(`${name}: HTTP ${r.status}`);
   if(Number(r.headers.get('content-length')||0)>40_000_000)throw new Error(`${name}: unexpected size`);
   await pipeline(Readable.fromWeb(r.body),fs.createWriteStream(temp));if(await sha256(temp)!==expected)throw new Error(`${name}: SHA-256 mismatch`);
   await fsp.rename(temp,target);console.log('Installed verified',name);
  }finally{await fsp.rm(temp,{force:true}).catch(()=>{});}
 }
})().catch(e=>{console.error(e.message);process.exitCode=1});
