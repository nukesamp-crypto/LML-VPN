'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {cleanSettings,parseCdn,psiphonConfig}=require('../lib/config.cjs');
const {cleanServers,request,connect,status}=require('../lib/lantern.cjs');
const {parseDword}=require('../lib/proxy.cjs');
const http2=require('node:http2');const os=require('node:os');const path=require('node:path');const fs=require('node:fs');

test('CDN settings accept valid IPv4, CIDR, hostnames and reject invalid inputs',()=>{
 assert.deepEqual(parseCdn('192.0.2.7,198.51.100.0/24','EXAMPLE.com'),{ips:['192.0.2.7','198.51.100.0/24'],names:['example.com']});
 assert.throws(()=>parseCdn('999.0.0.1',''),/نامعتبر/);
 assert.throws(()=>parseCdn('192.0.2.1/33',''),/نامعتبر/);
 assert.throws(()=>parseCdn('','example.com'),/حداقل/);
 assert.throws(()=>parseCdn('192.0.2.1','https://example.com'),/SNI/);
});
test('a CDN IPv4 can be saved with no domain',()=>{
 const s=cleanSettings({cdnIPs:'192.0.2.15',sniNames:''});
 const c=psiphonConfig({SponsorId:'A',PropagationChannelId:'B'},s,0,0,'data');
 assert.deepEqual(c.FrontedMeekCDNScanSpec,{IPCandidates:['192.0.2.15']});
});
test('real fork fields are used; local listener and port are controlled',()=>{
 const base={SponsorId:'A',PropagationChannelId:'B',ListenInterface:'any'};
 const s=cleanSettings({cdnIPs:'192.0.2.8/30',sniNames:'edge.example',region:'DE'});
 const c=psiphonConfig(base,s,0,0,'data');
 assert.deepEqual(c.FrontedMeekCDNScanSpec,{IPCandidates:['192.0.2.8/30'],SNIServerNames:['edge.example']});
 assert.equal(c.ListenInterface,'');assert.equal(c.LocalHttpProxyPort,0);assert.equal(c.EgressRegion,'DE');
 assert.equal(c.CustomServerEntries,undefined);assert.equal(base.ListenInterface,'any');
});
test('Lantern listings exclude all credentials',()=>{
 const x=cleanServers([{tag:'safe',isLantern:true,type:'x',location:{country:'DE',country_code:'DE'},credentials:{access_token:'VERY_SECRET'},outbound:{server:'192.0.2.7',password:'VERY_SECRET'}}]);
 assert.equal(x[0].countryCode,'DE');assert.equal(x[0].country,'DE');assert(!JSON.stringify(x).includes('VERY_SECRET'));
});
test('Windows registry number format',()=>{assert.equal(parseDword('0x1'),1);assert.equal(parseDword('0x0'),0);assert.equal(parseDword('1'),1)});
test('local IPC uses HTTP/2 and only approved endpoints',async()=>{
 const sock=path.join(os.tmpdir(),`lml-test-${process.pid}.sock`);try{fs.unlinkSync(sock)}catch{}
 const received=[];const server=http2.createServer((req,res)=>{let b='';req.on('data',s=>b+=s);req.on('end',()=>{received.push({method:req.method,path:req.url,body:b?JSON.parse(b):null});res.setHeader('Content-Type','application/json');res.end(req.url==='/vpn/status'?'"disconnected"':'null');});});
 await new Promise(r=>server.listen(sock,r));const opts={socketPath:sock,timeout:2000};
 try{
  assert.equal(await status(opts),'disconnected');await connect('server-tag',opts);
  assert.equal(received[1].path,'/vpn/connect');assert.deepEqual(received[1].body,{tag:'server-tag'});
  await assert.rejects(()=>request('POST','/servers/private',{},opts));
  await assert.rejects(()=>request('GET','/unknown',null,opts));
 }finally{await new Promise(r=>server.close(r));try{fs.unlinkSync(sock)}catch{}}
});

test('Lantern servers after a large unrelated list remain visible',()=>{
 const {cleanServers}=require('../lib/lantern.cjs');
 const entries=Array.from({length:700},(_,i)=>({tag:'unrelated-'+i,isLantern:false}));
 entries.push({tag:'real-lantern',isLantern:true,location:{country_code:'de',city:'Frankfurt'}});
 const clean=cleanServers(entries);assert.equal(clean.length,1);assert.equal(clean[0].countryCode,'DE');assert.equal(clean[0].tag,'real-lantern');
});
