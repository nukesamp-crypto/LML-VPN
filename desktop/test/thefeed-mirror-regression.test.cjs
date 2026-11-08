'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {TeleMirrorSource,ConfigSources,CHANNELS}=require('../lib/config-source.cjs');
const {parseLink}=require('../lib/config-links.cjs');
const link='vless://11111111-1111-4111-8111-111111111111@example.com:443?security=tls&foo=bar';
const data={channel:{username:CHANNELS[0],title:'Test'},posts:[{text:`<code>${link.replace('&','&amp;')}</code>`},{text:`<a href="${link.replace('&','&amp;')}">connect</a>`}]};
async function fixture(t,handler){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lml-telemirror-test-'));let requests=[];
 const server=http.createServer((req,res)=>{requests.push({method:req.method,path:req.url,auth:req.headers.authorization});handler(req,res);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const endpoint={port:server.address().port,secret:'secret'};let starts=0,stops=0;
 const controller={start:async()=>{starts++;return endpoint;},stop:async()=>{stops++;}};
 const mirror=new TeleMirrorSource({controller,dataDir:dir});
 t.after(async()=>{await mirror.stop();await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});});
 return {dir,mirror,requests,endpoint,controller,counts:()=>({starts,stops})};
}
const respond=(res,val=data)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(val));};

test('TeleMirror uses TheFeed authenticated loopback API, parses its post HTML and never changes the channel list',async t=>{
 const f=await fixture(t,(req,res)=>respond(res));
 const found=await f.mirror.fetch(CHANNELS[0]);assert.equal(found.length,1);assert.equal(found[0].id,parseLink(link).id);assert.equal(found[0].source,'@'+CHANNELS[0]+' · Google');
 assert.deepEqual(f.requests.map(r=>[r.method,r.path]),[['GET','/api/telemirror/channel/'+CHANNELS[0]+'?refresh=1']]);
 assert.equal(f.requests[0].auth,'Basic '+Buffer.from('lml:secret').toString('base64'));
 await assert.rejects(f.mirror.fetch('not_in_the_list'));assert.equal(f.requests.length,1);
});
test('recent private Mirror cache avoids network; stale cache is removed before an actual refresh',async t=>{
 const f=await fixture(t,(req,res)=>respond(res,{channel:{username:CHANNELS[0]},posts:[{text:link.replace('example.com','fresh.example.com')}]}));
 const d=path.join(f.dir,'telemirror'),file=path.join(d,CHANNELS[0].toLowerCase()+'.json');await fs.mkdir(d,{recursive:true});
 await fs.writeFile(file,JSON.stringify({...data,fetchedAt:new Date().toISOString()}));
 assert.equal((await f.mirror.fetch(CHANNELS[0]))[0].id,parseLink(link).id);assert.equal(f.requests.length,0);
 await fs.writeFile(file,JSON.stringify({...data,fetchedAt:new Date(Date.now()-600000).toISOString()}));
 const actual=await f.mirror.fetch(CHANNELS[0]);assert.equal(f.requests.length,1);assert.equal(actual[0].address,'fresh.example.com');
 await assert.rejects(fs.stat(file),{code:'ENOENT'});
});
test('official not-found and transport errors are distinct and sanitized',async t=>{
 let status=404;const f=await fixture(t,(req,res)=>{res.writeHead(status);res.end('secret/config-data');});
 await assert.rejects(f.mirror.fetch(CHANNELS[0]),{code:'MIRROR_NOT_FOUND'});
 status=502;await assert.rejects(f.mirror.fetch(CHANNELS[0]),{code:'MIRROR_UPSTREAM'});
 status=200;await assert.rejects(f.mirror.fetch(CHANNELS[0]),/invalid local API/);
});
test('stop aborts the in-flight API request and stops only the dedicated Mirror process',async t=>{
 let started;const began=new Promise(r=>started=r);const f=await fixture(t,(req,res)=>{started();req.on('close',()=>res.end());});
 const controller=new AbortController(),pending=f.mirror.fetch(CHANNELS[0],{signal:controller.signal});const rejected=assert.rejects(pending);await began;
 const begin=Date.now();controller.abort();await f.mirror.cancel();await rejected;assert(Date.now()-begin<1000);assert.equal(f.counts().stops,1);
});
test('ConfigSources uses its Mirror source for all channels, one at a time, then stops it',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lml-mirror-scan-'));let starts=0,stops=0,active=0,peak=0;const calls=[];
 const item=parseLink(link),m={start:async()=>{starts++;},cancel:async()=>{stops++;},stop:async()=>{stops++;},fetch:async name=>{active++;peak=Math.max(peak,active);calls.push(name);await new Promise(r=>setImmediate(r));active--;return name===CHANNELS[0]?[item]:[];}};
 const s=new ConfigSources({app:{getPath:()=>dir,isPackaged:false},binDir:()=>dir,mirrorSource:m});t.after(async()=>{await s.stop();await fs.rm(dir,{recursive:true,force:true});});
 const state=await s.refresh();assert.equal(starts,1);assert.equal(stops,1);assert.equal(peak,1);assert.deepEqual(calls,CHANNELS);assert.equal(state.scan.channelsDone,400);assert.equal(state.candidateCount,1);assert.equal(state.items.length,0);
 s.setLatency(item.id,23,{address:'8.8.8.8',transport:item.transport});assert.equal(s.snapshot().items[0].source,'Google');assert.match(s.snapshot().note,/TheFeed/);
});
test('a config scan cancels the real Mirror process and retains verified work',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lml-mirror-cancel-'));let began;const started=new Promise(r=>began=r);let stops=0;
 const item=parseLink(link),m={start:async()=>{},cancel:async()=>{stops++;},stop:async()=>{},fetch:async(name,{signal})=>{
  if(name===CHANNELS[0])return [item];began();return new Promise(resolve=>signal.addEventListener('abort',()=>resolve([]),{once:true}));
 }};
 const s=new ConfigSources({app:{getPath:()=>dir,isPackaged:false},binDir:()=>dir,mirrorSource:m});t.after(async()=>{await s.stop();await fs.rm(dir,{recursive:true,force:true});});
 const job=s.refresh();await started;s.setLatency(item.id,40,{address:'8.8.8.8',transport:item.transport});await s.cancelRefresh();await job;
 const state=s.snapshot();assert(stops>=1);assert.equal(state.scan.stopped,true);assert.equal(state.scan.channelsDone,1);assert.equal(state.items.length,1);
});
