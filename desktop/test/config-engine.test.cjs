'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http'),{spawn}=require('node:child_process');
const {ConfigEngine,freePort}=require('../lib/config-engine.cjs');const {parseLink}=require('../lib/config-links.cjs');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
test('real local VLESS traffic flows through pinned Xray and private session file is removed',{skip:!process.env.LML_XRAY_TEST_BIN},async t=>{
 const bin=process.env.LML_XRAY_TEST_BIN,dir=await fs.mkdtemp(path.join(os.tmpdir(),'lml-xray-local-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const target=http.createServer((_req,res)=>res.end('LOCAL VLESS OK'));await new Promise(r=>target.listen(0,'127.0.0.1',r));t.after(()=>target.close());
 const port=await freePort(),id='11111111-1111-4111-8111-111111111111';
 const serverCfg={log:{loglevel:'warning'},inbounds:[{listen:'127.0.0.1',port,protocol:'vless',settings:{clients:[{id}],decryption:'none'}}],outbounds:[{protocol:'freedom',settings:{finalRules:[{action:'allow',ip:['127.0.0.1/32']}]}}]};
 const file=path.join(dir,'server.json');await fs.writeFile(file,JSON.stringify(serverCfg));const server=spawn(bin,['run','-c',file],{stdio:'ignore'});t.after(()=>server.kill());await wait(300);
 const c=parseLink(`vless://${id}@127.0.0.1:${port}?security=none&type=tcp`,{allowLocal:true});
 const engine=new ConfigEngine({binDir:dir,dataDir:dir,devBinary:bin,proxy:{activate:async()=>{},restore:async()=>{}}});t.after(()=>engine.stop());
 const status=await engine.start(c,{systemProxy:false});assert.equal(status.state,'connected');assert.equal(status.name,'LML VPN');
 const body=await new Promise((resolve,reject)=>{const req=http.get({host:'127.0.0.1',port:status.httpPort,path:`http://127.0.0.1:${target.address().port}/`,timeout:5000},res=>{let b='';res.on('data',x=>b+=x);res.on('end',()=>resolve(b));});req.on('error',reject);req.on('timeout',()=>req.destroy(Error('timeout')));});
 assert.equal(body,'LOCAL VLESS OK');await engine.stop();await assert.rejects(fs.stat(path.join(dir,'config-engine','session.json')),{code:'ENOENT'});
});

test('stopping during proxy activation waits and restores before returning',{skip:!process.env.LML_XRAY_TEST_BIN},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lml-xray-race-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 let begun,release;const started=new Promise(r=>begun=r),gate=new Promise(r=>release=r);let active=false,restores=0;
 const engine=new ConfigEngine({binDir:dir,dataDir:dir,devBinary:process.env.LML_XRAY_TEST_BIN,proxy:{activate:async()=>{begun();await gate;active=true;},restore:async()=>{active=false;restores++;}}});
 const c=parseLink('vless://11111111-1111-4111-8111-111111111111@example.com:443?security=none');
 const starting=engine.start(c,{systemProxy:true});starting.catch(()=>{});await started;
 let stopFinished=false;const stopping=engine.stop().then(()=>{stopFinished=true;});await wait(100);assert.equal(stopFinished,false);
 release();await stopping;await assert.rejects(starting,/لغو|متوقف/);assert.equal(active,false);assert.equal(restores,1);assert.equal(engine.snapshot().state,'disconnected');
 await assert.rejects(fs.stat(path.join(dir,'config-engine','session.json')),{code:'ENOENT'});
});

test('an in-flight HTTPS-through-proxy measurement can be aborted promptly',async t=>{
 const net=require('node:net');const {verifyThroughProxy}=require('../lib/config-engine.cjs');
 const sockets=new Set(),server=net.createServer(s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(r=>server.close(r));});
 const abort=new AbortController(),job=verifyThroughProxy(server.address().port,{timeout:8000,signal:abort.signal});
 await new Promise(r=>setTimeout(r,50));const before=Date.now();abort.abort();assert.equal(await job,false);assert(Date.now()-before<500);
});

test('an HTTP response from a fake proxy cannot pass the authenticated HTTPS test',async t=>{
 const {verifyThroughProxy}=require('../lib/config-engine.cjs');const sockets=new Set();
 const fake=http.createServer();fake.on('connect',(_req,socket)=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.write('HTTP/1.1 200 Connection Established\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK');socket.end();});
 await new Promise(r=>fake.listen(0,'127.0.0.1',r));t.after(async()=>{for(const s of sockets)s.destroy();await new Promise(r=>fake.close(r));});
 assert.equal(await verifyThroughProxy(fake.address().port,{timeout:2000}),false);
});
