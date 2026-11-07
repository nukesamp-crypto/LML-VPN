'use strict';
// Fetch the exact unmodified Windows core pinned for this source build.
// Requires Node >=22.12. No file is installed unless its SHA-256 matches.
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path');
const {Readable}=require('node:stream'),{pipeline}=require('node:stream/promises');
const {sha256}=require('../lib/thefeed.cjs');
const {XRAY_SHA256,CRONET_SHA256}=require('../lib/config-engine.cjs');
const base='https://github.com/CluvexStudio/ZedSecure-Cores/releases/download/xray-r5/';
const dest=path.join(__dirname,'..','resources','bin');
(async()=>{
 await fsp.mkdir(dest,{recursive:true});
 for(const [name,expected] of [['xray-windows.exe',XRAY_SHA256],['libcronet.dll',CRONET_SHA256]]){
  const target=path.join(dest,name),temp=target+'.download';
  try{
   const response=await fetch(base+name,{signal:AbortSignal.timeout(240000),redirect:'follow'});
   if(!response.ok||!response.body)throw new Error(`${name}: HTTP ${response.status}`);
   if(Number(response.headers.get('content-length')||0)>150_000_000)throw new Error('Unexpected download size');
   await pipeline(Readable.fromWeb(response.body),fs.createWriteStream(temp,{flags:'w'}));
   if(await sha256(temp)!==expected)throw new Error(`${name}: SHA-256 mismatch`);
   await fsp.rename(temp,target);console.log('Installed verified',name);
  }finally{await fsp.rm(temp,{force:true}).catch(()=>{});}
 }
})().catch(e=>{console.error(e.message);process.exitCode=1});
