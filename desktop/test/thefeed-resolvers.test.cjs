'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {ensureOfficialResolvers,validateOfficialResolvers,SYNC_STATE}=require('../lib/thefeed-resolvers.cjs');
const original=['1.1.1.1:53','8.8.8.8:53','9.9.9.9:53'];
const updated=['8.8.8.8:53','9.9.9.9:53','4.4.4.4:53'];
async function temp(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lml-feed-resolvers-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
async function json(file){return JSON.parse(await fs.readFile(file,'utf8'));}
async function absent(file){try{await fs.access(file);return false;}catch(e){if(e.code==='ENOENT')return true;throw e;}}

test('first start uses the list supplied by the core, not an active list',async t=>{
 const dir=await temp(t),result=await ensureOfficialResolvers(dir,original,'v1.0.0');
 assert.deepEqual(result,{state:'provisioned',officialCount:3,bankCount:3});
 const p=await json(path.join(dir,'profiles.json'));
 assert.deepEqual(p.resolverBank,original);assert.equal(p.active,'');assert.deepEqual(p.profiles,[]);
 assert.equal(p.activeLists,undefined);assert.equal(p.selectedList,undefined);
 const state=await json(path.join(dir,SYNC_STATE));assert.deepEqual(state.official,original);assert.deepEqual(state.owned,original);
});

test('upstream changes synchronize while custom entries and user deletions are preserved',async t=>{
 const dir=await temp(t),file=path.join(dir,'profiles.json');
 const raw='{"active":"x","profiles":[],"resolverBank":["127.0.0.1:5353"],"selectedList":"Home","unknown":{"int64":9007199254740993}}';
 await fs.writeFile(file,raw);await ensureOfficialResolvers(dir,original,'v1.0.0');
 let p=await json(file);assert.deepEqual(p.resolverBank,['127.0.0.1:5353',...original]);
 // User deliberately removes one upstream DNS; it must not reappear on sync.
 p.resolverBank=p.resolverBank.filter(x=>x!=='8.8.8.8:53');
 await fs.writeFile(file,JSON.stringify(p).replace('9007199254740992','9007199254740993'));
 const result=await ensureOfficialResolvers(dir,updated,'v1.1.0');
 assert.equal(result.state,'synced');p=await json(file);
 assert.deepEqual(p.resolverBank,['127.0.0.1:5353','9.9.9.9:53','4.4.4.4:53']);
 assert.equal(p.selectedList,'Home');assert((await fs.readFile(file,'utf8')).includes('9007199254740993'));
 await ensureOfficialResolvers(dir,updated,'v1.1.0');assert.deepEqual((await json(file)).resolverBank,p.resolverBank);
});

test('DNS in an existing selected or named list is never removed by upstream sync',async t=>{
 const dir=await temp(t),file=path.join(dir,'profiles.json');
 const raw={active:'x',profiles:[],activeLists:[{name:'Home',resolvers:['1.1.1.1:53']}],selectedList:'Home'};
 await fs.writeFile(file,JSON.stringify(raw));await ensureOfficialResolvers(dir,original,'v1.0.0');
 await ensureOfficialResolvers(dir,updated,'v1.1.0');
 const p=await json(file);assert(p.resolverBank.includes('1.1.1.1:53'));
 assert.deepEqual(p.activeLists,raw.activeLists);assert.equal(p.selectedList,'Home');
});

test('empty bank after user deletion stays empty if upstream did not change',async t=>{
 const dir=await temp(t),file=path.join(dir,'profiles.json');await ensureOfficialResolvers(dir,original,'v1.0.0');
 const p=await json(file);p.resolverBank=[];await fs.writeFile(file,JSON.stringify(p));
 await ensureOfficialResolvers(dir,original,'v1.0.0');assert.deepEqual((await json(file)).resolverBank,[]);
});

test('legacy config and its resolvers survive migration',async t=>{
 const dir=await temp(t),config=path.join(dir,'config.json');
 const raw='{"domain":"legacy.invalid","key":"do-not-lose","resolvers":["10.8.0.1","127.0.0.1:5454"],"futureInt":9007199254740993}';
 await fs.writeFile(config,raw);await ensureOfficialResolvers(dir,original,'v1.0.0');
 assert.equal(await fs.readFile(config,'utf8'),raw);
 const saved=await fs.readFile(path.join(dir,'profiles.json'),'utf8'),p=JSON.parse(saved);
 assert.equal(p.profiles.length,1);assert.equal(p.active,p.profiles[0].id);assert.equal(p.profiles[0].config.key,'do-not-lose');
 assert(saved.includes('"futureInt":9007199254740993'));
 assert.deepEqual(p.resolverBank,['10.8.0.1:53','127.0.0.1:5454',...original]);
});

test('existing profiles, custom DNS, lists, settings and unknown fields are preserved',async t=>{
 const dir=await temp(t),file=path.join(dir,'profiles.json');
 const raw=`{"active":"p","profiles":[{"id":"p","config":{"domain":"old.invalid","key":"secret","resolvers":["10.0.0.4"]}}],"resolverBank":["127.0.0.1:5353","1.1.1.1:53"],"activeLists":[{"name":"Home","resolvers":["127.0.0.1:5353"]}],"selectedList":"Home","telAuthorized":true,"unknown":{"int64":9007199254740993}}`;
 await fs.writeFile(file,raw);await ensureOfficialResolvers(dir,original,'v1.0.0');
 const saved=await fs.readFile(file,'utf8'),p=JSON.parse(saved),before=JSON.parse(raw);
 assert.deepEqual(p.resolverBank,['127.0.0.1:5353',...original]);delete p.resolverBank;delete before.resolverBank;
 assert.deepEqual(p,before);assert(saved.includes('9007199254740993'));
});

test('malformed profiles or bad upstream list never overwrite user data; retry works',async t=>{
 const dir=await temp(t),file=path.join(dir,'profiles.json');
 const malformed=['{"active":','{"profiles":{},"resolverBank":[]}', '{"profiles":[],"lang":42}',
 '{"profiles":[],"resolverBank":{"oops":1}}','{"profiles":[],"resolverBank":[],"RESOLVERBANK":[]}'];
 for(const raw of malformed){await fs.writeFile(file,raw);await assert.rejects(ensureOfficialResolvers(dir,original,'v1.0.0'));assert.equal(await fs.readFile(file,'utf8'),raw);assert(await absent(path.join(dir,SYNC_STATE)));}
 await fs.writeFile(file,'{"active":"","profiles":[]}');
 await assert.rejects(ensureOfficialResolvers(dir,[],'v1.0.0'));assert(await absent(path.join(dir,SYNC_STATE)));
 await ensureOfficialResolvers(dir,original,'v1.0.0');assert.deepEqual((await json(file)).resolverBank,original);
 assert.throws(()=>validateOfficialResolvers(['bad\naddress']));
});
