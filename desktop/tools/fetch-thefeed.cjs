'use strict';
// Fetch the unchanged official Windows x64 TheFeed client for a source build.
// Requires Node >=22.12. The runtime checks the same pinned SHA-256 at launch.
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const {Readable}=require('node:stream');
const {pipeline}=require('node:stream/promises');
const {sha256,WINDOWS_SHA256,RELEASE}=require('../lib/thefeed.cjs');
const url=`https://github.com/sartoopjj/thefeed/releases/download/${RELEASE}/thefeed-client-${RELEASE}-windows-amd64.exe`;
const target=path.join(__dirname,'..','resources','bin','thefeed-client.exe');
(async()=>{
 await fsp.mkdir(path.dirname(target),{recursive:true});
 const temp=target+'.download';
 try {
  const response=await fetch(url,{signal:AbortSignal.timeout(180000),redirect:'follow'});
  if(!response.ok || !response.body)throw new Error(`Download failed: HTTP ${response.status}`);
  const length=Number(response.headers.get('content-length')||0);
  if(length>100_000_000)throw new Error('Unexpected download size');
  await pipeline(Readable.fromWeb(response.body),fs.createWriteStream(temp,{flags:'w'}));
  if(await sha256(temp)!==WINDOWS_SHA256)throw new Error('SHA-256 mismatch; file not installed');
  await fsp.rename(temp,target);
  console.log(`Installed official TheFeed ${RELEASE} at ${target}`);
 } finally {await fsp.rm(temp,{force:true}).catch(()=>{});}
})().catch(e=>{console.error(e.message);process.exitCode=1});
