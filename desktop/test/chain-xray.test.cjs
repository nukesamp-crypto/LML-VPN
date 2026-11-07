'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),net=require('node:net'),http=require('node:http'),{spawn}=require('node:child_process');
const {parseLink,buildXray}=require('../lib/config-links.cjs');
const {ConfigEngine,freePort}=require('../lib/config-engine.cjs');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
test('chained Xray actually dials its server via the local SOCKS hop',{skip:!process.env.LML_XRAY_TEST_BIN},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lml-chain-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const target=http.createServer((_req,res)=>res.end('CHAIN_OK'));await new Promise(r=>target.listen(0,'127.0.0.1',r));t.after(()=>target.close());
 const inboundPort=await freePort(),id='11111111-1111-4111-8111-111111111111';
 const serverConfig={log:{loglevel:'warning'},inbounds:[{listen:'127.0.0.1',port:inboundPort,protocol:'vless',settings:{clients:[{id}],decryption:'none'}}],outbounds:[{protocol:'freedom',settings:{finalRules:[{action:'allow',ip:['127.0.0.1/32']}]}}]};
 const file=path.join(dir,'server.json');await fs.writeFile(file,JSON.stringify(serverConfig));
 const server=spawn(process.env.LML_XRAY_TEST_BIN,['run','-c',file],{stdio:'ignore'});t.after(()=>server.kill());await wait(350);
 let forwards=0;const sockets=new Set();
 const socks=net.createServer(client=>{
  sockets.add(client);client.once('close',()=>sockets.delete(client));let state=0,buf=Buffer.alloc(0);
  client.on('data',function data(chunk){buf=Buffer.concat([buf,chunk]);
   if(state===0){if(buf.length<2||buf.length<2+buf[1])return;buf=buf.subarray(2+buf[1]);client.write(Buffer.from([5,0]));state=1;}
   if(state===1){if(buf.length<4)return;let host,n;if(buf[3]===1){n=10;if(buf.length<n)return;host=Array.from(buf.subarray(4,8)).join('.');}
    else if(buf[3]===3){if(buf.length<5)return;n=7+buf[4];if(buf.length<n)return;host=buf.subarray(5,5+buf[4]).toString();}else{client.destroy();return;}
    const port=buf.readUInt16BE(n-2),rest=buf.subarray(n);buf=Buffer.alloc(0);state=2;assert.equal(port,inboundPort);forwards++;
    const out=net.connect({host,port},()=>{client.write(Buffer.from([5,0,0,1,127,0,0,1,0,0]));if(rest.length)out.write(rest);client.pipe(out);out.pipe(client);});
    out.on('error',()=>client.destroy());client.on('error',()=>out.destroy());client.removeListener('data',data);
   }
  });
 });await new Promise(r=>socks.listen(0,'127.0.0.1',r));t.after(()=>{for(const s of sockets)s.destroy();socks.close();});
 const c=parseLink(`vless://${id}@127.0.0.1:${inboundPort}?security=none&type=tcp`,{allowLocal:true});
 const engine=new ConfigEngine({binDir:dir,dataDir:dir,devBinary:process.env.LML_XRAY_TEST_BIN,proxy:{activate:async()=>{},restore:async()=>{}}});t.after(()=>engine.stop());
 const status=await engine.start(c,{systemProxy:false,upstreamSocksPort:socks.address().port});
 const body=await new Promise((resolve,reject)=>{const req=http.get({host:'127.0.0.1',port:status.httpPort,path:`http://127.0.0.1:${target.address().port}/`,timeout:8000},res=>{let b='';res.on('data',x=>b+=x);res.on('end',()=>resolve(b));});req.on('error',reject);req.on('timeout',()=>req.destroy(Error('timeout')));});
 assert.equal(body,'CHAIN_OK');assert.ok(forwards>0);await engine.stop();
});
test('chained SOCKS hop can only target a validated local port',()=>{
 const c=parseLink('vless://11111111-1111-4111-8111-111111111111@example.com:443?security=none');
 assert.throws(()=>buildXray(c,1001,1002,{upstreamSocksPort:1001}));
 assert.throws(()=>buildXray(c,1001,1002,{upstreamSocksPort:65536}));
 const conf=buildXray(c,1001,1002,{upstreamSocksPort:1003});assert.equal(conf.outbounds[0].streamSettings.sockopt.dialerProxy,'lml-upstream');assert.equal(conf.outbounds[1].settings.servers[0].address,'127.0.0.1');
});
