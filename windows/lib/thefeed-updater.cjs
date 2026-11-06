'use strict';
// Optional, best-effort auto-update of the *TheFeed core only*. The enclosing
// LML app and VPN engines are not updated here. Assets must be published by
// the official GitHub repo and match GitHub's SHA-256; an isolated process
// additionally checks the expected version, APIs and UI before activation.
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');

const RELEASES='https://api.github.com/repos/sartoopjj/thefeed/releases?per_page=20';
const META_HOSTS=new Set(['api.github.com']);
const ASSET_HOSTS=new Set(['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com']);
const MAX_ASSET=150*1024*1024;
const TAG=/^v(\d+)\.(\d+)\.(\d+)(?:-([A-Za-z0-9.-]+))?$/;

function versionParts(tag){
 const m=typeof tag==='string' && tag.match(TAG);if(!m)return null;
 const n=m.slice(1,4).map(Number);if(n.some(x=>!Number.isSafeInteger(x)))return null;
 return {n,pre:m[4]||''};
}
function compareVersions(a,b){
 const x=versionParts(a),y=versionParts(b);if(!x||!y)throw new Error('invalid release version');
 for(let i=0;i<3;i++)if(x.n[i]!==y.n[i])return x.n[i]<y.n[i]?-1:1;
 if(!x.pre || !y.pre)return x.pre===y.pre?0:x.pre?-1:1;
 const ax=x.pre.match(/(\d+|\D+)/g)||[],ay=y.pre.match(/(\d+|\D+)/g)||[];
 for(let i=0;i<Math.max(ax.length,ay.length);i++){
  if(ax[i]===undefined)return -1;if(ay[i]===undefined)return 1;
  if(ax[i]===ay[i])continue;
  if(/^\d+$/.test(ax[i])&&/^\d+$/.test(ay[i])){
   const a=Number(ax[i]),b=Number(ay[i]);if(a!==b)return a<b?-1:1;
  }else return ax[i]<ay[i]?-1:1;
 }
 return 0;
}
function assetFor(release){
 if(!release || release.draft || !versionParts(release.tag_name) || !Array.isArray(release.assets))return null;
 const version=release.tag_name,name=`thefeed-client-${version}-windows-amd64.exe`;
 const asset=release.assets.find(a=>a && a.name===name);if(!asset)return null;
 const digest=typeof asset.digest==='string' && asset.digest.match(/^sha256:([a-f0-9]{64})$/);
 if(!digest || !Number.isSafeInteger(asset.size) || asset.size<=0 || asset.size>MAX_ASSET)return null;
 const expected=`https://github.com/sartoopjj/thefeed/releases/download/${version}/${name}`;
 if(asset.browser_download_url!==expected)return null;
 return {version,sha256:digest[1],size:asset.size,url:expected};
}
function selectRelease(releases,current){
 if(!versionParts(current)||!Array.isArray(releases))throw new Error('invalid update metadata');
 let best=null;
 for(const release of releases){
  const candidate=assetFor(release);if(!candidate || compareVersions(candidate.version,current)<=0)continue;
  if(!best || compareVersions(candidate.version,best.version)>0)best=candidate;
 }
 return best;
}
function allowURL(url,hosts){
 const u=new URL(url);
 if(u.protocol!=='https:' || u.username || u.password || (u.port && u.port!=='443') || !hosts.has(u.hostname))throw new Error('untrusted update host');
 return u;
}
async function limitedFetch(fetcher,url,hosts,signal){
 for(let i=0;i<5;i++){
  allowURL(url,hosts);
  const response=await fetcher(url,{redirect:'manual',signal,headers:{'User-Agent':'LML-TheFeed-Updater/1.0','Accept':'application/vnd.github+json'}});
  if(response.status>=300 && response.status<400){
   const location=response.headers.get('location');if(!location)throw new Error('invalid update redirect');
   url=new URL(location,url).href;continue;
  }
  if(!response.ok)throw new Error('update server returned '+response.status);
  return response;
 }
 throw new Error('too many update redirects');
}
async function readLimited(response,limit){
 const chunks=[];let size=0;
 if(!response.body)throw new Error('empty update response');
 for await(const chunk of response.body){size+=chunk.length;if(size>limit)throw new Error('update response too large');chunks.push(Buffer.from(chunk));}
 return Buffer.concat(chunks);
}
async function hashFile(file){
 return new Promise((resolve,reject)=>{
  const h=crypto.createHash('sha256'),s=fs.createReadStream(file);
  s.on('error',reject);s.on('data',b=>h.update(b));s.on('end',()=>resolve(h.digest('hex')));
 });
}
async function atomicWrite(file,text){
 const tmp=file+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';
 try{await fsp.writeFile(tmp,text,{flag:'wx',mode:0o600});await fsp.rename(tmp,file);}catch(e){await fsp.rm(tmp,{force:true}).catch(()=>{});throw e;}
}
class ThefeedUpdater{
 constructor({directory,bundledVersion,validateBinary,fetcher=globalThis.fetch,networkTimeout=120000}){
  this.directory=directory;this.bundledVersion=bundledVersion;this.validateBinary=validateBinary;this.fetcher=fetcher;this.networkTimeout=networkTimeout;
  this.running=null;this.abort=null;
 }
 async cached(){
  try{
   const m=JSON.parse(await fsp.readFile(path.join(this.directory,'current.json'),'utf8'));
   if(!versionParts(m.version) || compareVersions(m.version,this.bundledVersion)<=0 || !/^[a-f0-9]{64}$/.test(m.sha256) || !Number.isSafeInteger(m.size) || m.size<=0 || m.size>MAX_ASSET)return null;
   const file=path.join(this.directory,`${m.version}-${m.sha256}.exe`),stat=await fsp.stat(file);
   if(!stat.isFile() || stat.size!==m.size || await hashFile(file)!==m.sha256)return null;
   return {version:m.version,path:file,sha256:m.sha256};
  }catch{return null;}
 }
 async invalidate(candidate){
  try{
   const file=path.join(this.directory,'current.json'),m=JSON.parse(await fsp.readFile(file,'utf8'));
   if(candidate && m.version===candidate.version && m.sha256===candidate.sha256)await fsp.rm(file,{force:true});
  }catch{}
 }
 check(currentVersion){
  if(this.running)return this.running;
  this.abort=new AbortController();const signal=this.abort.signal;
  this.running=this._check(currentVersion,signal).finally(()=>{this.running=null;this.abort=null;});
  return this.running;
 }
 cancel(){if(this.abort)this.abort.abort();}
 async _check(currentVersion,signal){
  const timer=setTimeout(()=>this.abort?.abort(),this.networkTimeout);timer.unref();
  let tmp=null;
  try{
   const meta=await limitedFetch(this.fetcher,RELEASES,META_HOSTS,signal);
   const releases=JSON.parse((await readLimited(meta,2*1024*1024)).toString('utf8'));
   const cached=await this.cached();let base=currentVersion;
   if(cached && compareVersions(cached.version,base)>0)base=cached.version;
   const candidate=selectRelease(releases,base);if(!candidate)return {state:'current'};
   await fsp.mkdir(this.directory,{recursive:true});
   const response=await limitedFetch(this.fetcher,candidate.url,ASSET_HOSTS,signal);
   if(!response.body)throw new Error('empty update asset');
   tmp=path.join(this.directory,`.download-${crypto.randomBytes(10).toString('hex')}.exe`);
   const handle=await fsp.open(tmp,'wx',0o700),h=crypto.createHash('sha256');let size=0;
   try{
    for await(const chunk of response.body){
     size+=chunk.length;if(size>candidate.size || size>MAX_ASSET)throw new Error('update asset too large');
     h.update(chunk);await handle.writeFile(chunk);
    }
   }finally{await handle.close();}
   if(size!==candidate.size || h.digest('hex')!==candidate.sha256)throw new Error('update hash mismatch');
   if(signal.aborted)throw new Error('cancelled');
   await this.validateBinary(tmp,candidate.version,signal);
   if(signal.aborted)throw new Error('cancelled');
   const final=path.join(this.directory,`${candidate.version}-${candidate.sha256}.exe`);
   await fsp.rename(tmp,final);tmp=null;
   await atomicWrite(path.join(this.directory,'current.json'),JSON.stringify({version:candidate.version,sha256:candidate.sha256,size:candidate.size})+'\n');
   // Keep the currently running old executable if Windows locks it; remove
   // obsolete, updater-owned files only. No other user data is affected.
   for(const name of await fsp.readdir(this.directory)){
    if(name!==path.basename(final) && /^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?-[a-f0-9]{64}\.exe$/.test(name))
     await fsp.rm(path.join(this.directory,name),{force:true}).catch(()=>{});
   }
   return {state:'downloaded',version:candidate.version};
  }finally{clearTimeout(timer);if(tmp)await fsp.rm(tmp,{force:true}).catch(()=>{});}
 }
}
module.exports={ThefeedUpdater,compareVersions,selectRelease,assetFor,allowURL,RELEASES};
