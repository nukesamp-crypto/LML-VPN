'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const net=require('node:net');
const {ThefeedController,choosePort,probe,sha256,WINDOWS_SHA256,RELEASE}=require('../lib/thefeed.cjs');

function request(port,url,secret,method='GET',body=null){
 return new Promise((resolve,reject)=>{
  const headers={};if(secret)headers.Authorization='Basic '+Buffer.from('lml:'+secret).toString('base64');
  const payload=body?JSON.stringify(body):undefined;
  if(payload){headers['Content-Type']='application/json';headers['Content-Length']=Buffer.byteLength(payload);}
  const r=http.request({host:'127.0.0.1',port,path:url,method,headers,timeout:3000},res=>{
   let data='';res.setEncoding('utf8');res.on('data',c=>data+=c);res.on('end',()=>resolve({status:res.statusCode,body:data}));
  });r.on('error',reject);r.on('timeout',()=>r.destroy(new Error('timeout')));r.end(payload);
 });
}

test('bundled TheFeed Windows binary is pinned to the official release',async()=>{
 const exe=path.join(__dirname,'../resources/bin/thefeed-client.exe');
 assert.equal(await sha256(exe),WINDOWS_SHA256);
});
test('port selection skips a busy port without contacting any VPN engine',async()=>{
 const s=net.createServer();await new Promise(r=>s.listen(19765,'127.0.0.1',r));
 try{const p=await choosePort(19765);assert.notEqual(p,19765);assert.ok(p>0);}finally{await new Promise(r=>s.close(r));}
});
test('a tampered binary is rejected before it can run',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lml-feed-tamper-'));
 const f=path.join(dir,'fake');await fs.writeFile(f,'not the official client');
 const c=new ThefeedController({executable:f,dataDir:path.join(dir,'data'),expectedHash:WINDOWS_SHA256});
 try{await assert.rejects(c.start(),/تغییر کرده|آسیب دیده/);assert.equal(c.child,null);}finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('missing binary gives a useful error',async()=>{
 const c=new ThefeedController({executable:path.join(os.tmpdir(),'no-such-lml-thefeed-binary'),dataDir:os.tmpdir()});
 await assert.rejects(c.start(),/پیدا نشد/);
});

test('real upstream core: authenticated startup, profiles, restart and isolation',{skip:!process.env.LML_FEED_TEST_BIN},async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lml-feed-real-'));
 const c=new ThefeedController({executable:process.env.LML_FEED_TEST_BIN,dataDir:dir,expectedHash:null,timeout:15000});
 try{
  const [a,b]=await Promise.all([c.start(),c.start()]);assert.equal(a.port,b.port);assert.equal(a.version,RELEASE);
  assert.equal((await request(a.port,'/api/status')).status,401);
  assert.equal((await request(a.port,'/api/status','wrong')).status,401);
  assert.equal((await request(a.port,'/api/status',a.secret)).status,200);
  const defaults=JSON.parse((await request(a.port,'/api/profiles/defaults',a.secret)).body);
  assert.equal(defaults.profiles.length,4);assert.equal(defaults.resolvers.length,217);
  const profiles=JSON.parse((await request(a.port,'/api/profiles',a.secret)).body);
  assert.deepEqual(profiles.resolverBank,defaults.resolvers); // exact official set and order
  const bank=JSON.parse((await request(a.port,'/api/resolvers/bank',a.secret)).body);
  assert.equal(bank.count,217);assert(bank.bank.every(r=>r.active===false));
  const active=JSON.parse((await request(a.port,'/api/resolvers/active',a.secret)).body);
  assert.deepEqual(active.resolvers,[]); // candidates are not asserted to be healthy/active
  assert.equal((await request(a.port,'/api/update/download?version=v9.9.9',a.secret)).status,403);
  assert.equal((await request(a.port,'/api/settings',a.secret,'POST',{lang:'fa'})).status,200);
  const saved=JSON.parse((await request(a.port,'/api/settings',a.secret)).body);assert.equal(saved.lang,'fa');
  await c.stop();const next=await c.start();assert.equal(next.port,a.port);assert.notEqual(next.secret,a.secret);
  assert.equal((await request(next.port,'/api/status',a.secret)).status,401);
  assert.equal((await request(next.port,'/api/status',next.secret)).status,200);
  assert.equal((await probe(next.port,next.secret)).version,RELEASE);
  assert.deepEqual(JSON.parse((await request(next.port,'/api/profiles',next.secret)).body).resolverBank,defaults.resolvers);
  // Real UI operation: remove a candidate through upstream's API, then restart.
  assert.equal((await request(next.port,'/api/resolvers/bank',next.secret,'DELETE',{addrs:[defaults.resolvers[0]]})).status,200);
  await c.stop();const afterDelete=await c.start();
  assert.deepEqual(JSON.parse((await request(afterDelete.port,'/api/profiles',afterDelete.secret)).body).resolverBank,defaults.resolvers.slice(1));
  assert.equal((await request(afterDelete.port,'/api/resolvers/bank',afterDelete.secret,'DELETE',{addrs:defaults.resolvers.slice(1)})).status,200);
  await c.stop();const afterClear=await c.start();
  const empty=JSON.parse((await request(afterClear.port,'/api/resolvers/bank',afterClear.secret)).body);
  assert.equal(empty.count,0);
 }finally{await c.stop();await fs.rm(dir,{recursive:true,force:true});}
});

test('startup preserves a corrupt profile and succeeds after repair',{skip:!process.env.LML_FEED_TEST_BIN},async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lml-feed-repair-'));
 const file=path.join(dir,'profiles.json'),raw='{"broken":';await fs.writeFile(file,raw);
 const c=new ThefeedController({executable:process.env.LML_FEED_TEST_BIN,dataDir:dir,expectedHash:null,timeout:15000});
 try{
  await assert.rejects(c.start(),/DNS از هسته/);assert.equal(c.child,null);
  assert.equal(await fs.readFile(file,'utf8'),raw);
  await fs.writeFile(file,'{"active":"","profiles":[]}');
  const endpoint=await c.start();
  const bank=JSON.parse((await request(endpoint.port,'/api/resolvers/bank',endpoint.secret)).body);
  assert.equal(bank.count,217);
 }finally{await c.stop();await fs.rm(dir,{recursive:true,force:true});}
});

test('an unusable cached update falls back to the pinned core',{skip:!process.env.LML_FEED_TEST_BIN},async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lml-feed-fallback-'));
 const bad=path.join(dir,'unusable.exe');await fs.writeFile(bad,'not executable');let invalidated=false;
 const updater={cached:async()=>({path:bad,version:'v99.0.0',sha256:'x'}),invalidate:async()=>{invalidated=true;},cancel:()=>{}};
 const c=new ThefeedController({executable:process.env.LML_FEED_TEST_BIN,dataDir:path.join(dir,'feed'),expectedHash:null,updater});
 try{const endpoint=await c.start();assert.equal(endpoint.version,RELEASE);assert(invalidated);}
 finally{await c.stop();await fs.rm(dir,{recursive:true,force:true});}
});

test('quitting during the temporary core inspection kills that process',{skip:!process.env.LML_FEED_TEST_BIN},async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lml-feed-inspect-cancel-'));
 const c=new ThefeedController({executable:process.env.LML_FEED_TEST_BIN,dataDir:dir,expectedHash:null,timeout:15000});
 try{
  const start=c.start();start.catch(()=>{});
  for(let i=0;i<300 && !c.inspectionChild;i++)await new Promise(r=>setTimeout(r,10));
  assert(c.inspectionChild,'inspection did not start');const inspected=c.inspectionChild;
  await c.stop();await assert.rejects(start,/لغو شد|راه‌اندازی نشد/);
  assert.equal(c.child,null);assert.equal(c.endpoint,null);
  assert(inspected.exitCode!==null || inspected.signalCode!==null);
 }finally{await c.stop();await fs.rm(dir,{recursive:true,force:true});}
});

test('quitting while TheFeed is starting cancels the pending launch',{skip:!process.env.LML_FEED_TEST_BIN},async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lml-feed-cancel-'));
 const c=new ThefeedController({executable:process.env.LML_FEED_TEST_BIN,dataDir:dir,expectedHash:null,timeout:15000});
 try{
  const start=c.start();
  await c.stop();
  await assert.rejects(start,/لغو شد|راه‌اندازی نشد/);
  assert.equal(c.child,null);
  assert.equal(c.endpoint,null);
 }finally{await c.stop();await fs.rm(dir,{recursive:true,force:true});}
});
