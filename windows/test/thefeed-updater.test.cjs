'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {ThefeedUpdater,compareVersions,selectRelease,assetFor,allowURL}=require('../lib/thefeed-updater.cjs');
const {inspectCore,ThefeedController,sha256,RELEASE}=require('../lib/thefeed.cjs');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
async function temp(t){const d=await fs.mkdtemp(path.join(os.tmpdir(),'lml-updater-'));t.after(()=>fs.rm(d,{recursive:true,force:true}));return d;}
function release(version,payload,digest=hash(payload)){
 const name=`thefeed-client-${version}-windows-amd64.exe`;
 return {tag_name:version,draft:false,prerelease:version.includes('-'),assets:[{name,size:payload.length,digest:'sha256:'+digest,browser_download_url:`https://github.com/sartoopjj/thefeed/releases/download/${version}/${name}`}]};
}
function fetchMock(releases,payload,urls=[]){
 return async url=>{
  urls.push(url);
  if(url.startsWith('https://api.github.com/'))return new Response(JSON.stringify(releases),{status:200});
  if(url.startsWith('https://github.com/'))return new Response(null,{status:302,headers:{location:'https://release-assets.githubusercontent.com/test-download'}});
  if(url.startsWith('https://release-assets.githubusercontent.com/'))return new Response(payload,{status:200});
  throw new Error('unexpected host');
 };
}
test('selects the newest proper official Windows release without downgrade',()=>{
 const data=Buffer.from('test'),r=[release('v0.40.10-rc2',data),release('v0.40.10-rc10',data),release('v0.40.9',data)];
 assert(compareVersions('v0.40.10-rc10','v0.40.10-rc2')>0);
 assert(compareVersions('v0.40.10','v0.40.10-rc10')>0);
 assert.equal(selectRelease(r,'v0.40.9-rc2').version,'v0.40.10-rc10');
 assert.equal(selectRelease(r,'v0.41.0'),null);
 assert.equal(assetFor({...r[0],draft:true}),null);
 const bad=release('v0.50.0',data);bad.assets[0].browser_download_url='https://evil.example/installer.exe';assert.equal(assetFor(bad),null);
 assert.throws(()=>allowURL('https://github.com.evil.example/x',new Set(['github.com'])),/untrusted/);
});

test('downloads only official-host, hash-verified and compatibility-checked updates',async t=>{
 const dir=await temp(t),payload=Buffer.from('example-release-binary'),urls=[],validated=[];
 const up=new ThefeedUpdater({directory:dir,bundledVersion:'v0.40.9-rc2',fetcher:fetchMock([release('v0.41.0-rc1',payload)],payload,urls),
  validateBinary:async(file,version)=>{assert.deepEqual(await fs.readFile(file),payload);validated.push(version);}});
 const a=up.check('v0.40.9-rc2'),b=up.check('v0.40.9-rc2');assert.equal(a,b);
 assert.deepEqual(await a,{state:'downloaded',version:'v0.41.0-rc1'});
 assert.deepEqual(validated,['v0.41.0-rc1']);assert(urls.some(x=>x.startsWith('https://release-assets.githubusercontent.com/')));
 const cache=await up.cached();assert.equal(cache.version,'v0.41.0-rc1');assert.equal(await sha256(cache.path),hash(payload));
 assert.deepEqual(await up.check('v0.40.9-rc2'),{state:'current'});
 await fs.writeFile(cache.path,Buffer.alloc(payload.length));assert.equal(await up.cached(),null);
});

test('hash mismatch, failed compatibility and network errors leave previous cache intact',async t=>{
 const dir=await temp(t),old=Buffer.from('old-release'),next=Buffer.from('new-release');
 const up=new ThefeedUpdater({directory:dir,bundledVersion:'v0.40.9-rc2',fetcher:fetchMock([release('v0.41.0',old)],old),validateBinary:async()=>{}});
 await up.check('v0.40.9-rc2');const oldCache=await up.cached();assert(oldCache);
 up.fetcher=fetchMock([release('v0.42.0',next,hash(Buffer.from('wrong')))],next);
 await assert.rejects(up.check('v0.40.9-rc2'),/hash mismatch/);assert.equal((await up.cached()).version,'v0.41.0');
 up.fetcher=fetchMock([release('v0.42.0',next)],next);up.validateBinary=async()=>{throw Error('incompatible');};
 await assert.rejects(up.check('v0.40.9-rc2'),/incompatible/);assert.equal((await up.cached()).version,'v0.41.0');
 up.fetcher=async()=>{throw Error('offline');};await assert.rejects(up.check('v0.40.9-rc2'),/offline/);
 assert.equal((await up.cached()).path,oldCache.path);
 assert(!(await fs.readdir(dir)).some(x=>x.startsWith('.download-')));
});

test('untrusted redirect is rejected before download',async t=>{
 const dir=await temp(t),data=Buffer.from('release'),urls=[];
 const up=new ThefeedUpdater({directory:dir,bundledVersion:'v0.40.9-rc2',validateBinary:async()=>{},fetcher:async url=>{
  urls.push(url);if(url.startsWith('https://api.github.com/'))return new Response(JSON.stringify([release('v0.41.0',data)]));
  return new Response(null,{status:302,headers:{location:'https://evil.example/file.exe'}});
 }});
 await assert.rejects(up.check('v0.40.9-rc2'),/untrusted/);assert(!urls.some(x=>x.includes('evil.example')));assert.equal(await up.cached(),null);
});

test('quitting cancels the in-flight update check',async t=>{
 const dir=await temp(t);let started;
 const ready=new Promise(r=>{started=r;});
 const up=new ThefeedUpdater({directory:dir,bundledVersion:'v0.40.9-rc2',validateBinary:async()=>{},fetcher:(_url,{signal})=>new Promise((_r,reject)=>{
  signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});started();
 })});
 const pending=up.check('v0.40.9-rc2');await ready;up.cancel();await assert.rejects(pending,/aborted/);
 assert.equal(await up.cached(),null);
});

test('staged genuine core is inspected, cached and used on the next start',{skip:!process.env.LML_FEED_TEST_BIN},async t=>{
 const dir=await temp(t),payload=await fs.readFile(process.env.LML_FEED_TEST_BIN),tag=RELEASE;
 const up=new ThefeedUpdater({directory:path.join(dir,'updates'),bundledVersion:'v0.40.0',fetcher:fetchMock([release(tag,payload)],payload),
  validateBinary:(file,version,signal)=>inspectCore(file,{expectedVersion:version,checkUI:true,cancelled:()=>signal.aborted})});
 assert.deepEqual(await up.check('v0.40.0'),{state:'downloaded',version:tag});
 const cache=await up.cached();assert(cache);
 const c=new ThefeedController({executable:process.env.LML_FEED_TEST_BIN,dataDir:path.join(dir,'feed'),expectedHash:null,updater:up});
 try{
  const endpoint=await c.start();assert.equal(endpoint.version,tag);
  const profiles=JSON.parse(await fs.readFile(path.join(dir,'feed','profiles.json'),'utf8'));
  const actual=await inspectCore(cache.path,{expectedVersion:tag});
  assert.deepEqual(profiles.resolverBank,actual.resolvers);assert.equal(actual.resolvers.length,217);
 }finally{await c.stop();}
});
