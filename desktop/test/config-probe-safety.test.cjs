'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {isPublicIP,PublicResolver,pinCandidate}=require('../lib/config-probe.cjs');
const {parseLink,buildXray}=require('../lib/config-links.cjs'),{verifyCached}=require('../lib/config-engine.cjs');
const id='11111111-1111-4111-8111-111111111111';
test('public-IP allowlist blocks local, reserved, mapped, translated and tunneled addresses',()=>{
 for(const address of ['0.0.0.0','10.2.3.4','100.64.0.1','127.0.0.1','169.254.169.254','172.16.1.1','192.168.0.1','192.0.2.1','198.18.0.1','203.0.113.1','224.0.0.1','255.255.255.255',
  '::','::1','::ffff:127.0.0.1','::7f00:1','64:ff9b::7f00:1','fc00::1','fe80::1','ff02::1','2001:db8::1','2002:7f00:1::','3fff::1','not-an-ip'])assert.equal(isPublicIP(address),false,address);
 for(const address of ['8.8.8.8','1.1.1.1','93.184.216.34','2001:4860:4860::8888','2606:4700:4700::1111'])assert.equal(isPublicIP(address),true,address);
});
test('resolve once, select a public address, reject private-only results and pin against rebinding',async()=>{
 let calls=0;const resolver=new PublicResolver(async()=>{calls++;return calls===1?[{address:'127.0.0.1',family:4},{address:'93.184.216.34',family:4}]:[{address:'127.0.0.1',family:4}];});
 const original=parseLink(`vless://${id}@public.example:443?security=tls&type=ws`);
 const first=await resolver.address(original.address);const pinned=pinCandidate(original,first);
 assert.equal(first,'93.184.216.34');assert.equal(await resolver.address(original.address),'93.184.216.34');assert.equal(calls,1);
 assert.equal(pinned.address,'93.184.216.34');assert.equal(original.address,'public.example');assert.equal(pinned.tls.sni,'public.example');assert.equal(pinned.transport.host,'public.example');
 const bad=new PublicResolver(async()=>[{address:'127.0.0.1'},{address:'::1'},{address:'10.0.0.1'}]);
 await assert.rejects(bad.address('rebind.example'));await assert.rejects(bad.address('127.0.0.1'));assert.throws(()=>pinCandidate(original,'192.168.1.1'));
});
test('pinning preserves original TLS SNI and default or explicitly configured transport hosts',()=>{
 for(const type of ['ws','xhttp','httpupgrade']){
  const c=parseLink(`vless://${id}@dial.example:443?security=tls&type=${type}`),pinned=pinCandidate(c,'8.8.8.8'),stream=buildXray(pinned,10001,10002).outbounds[0].streamSettings;
  assert.equal(pinned.tls.sni,'dial.example');assert.equal(stream.tlsSettings.serverName,'dial.example');assert.equal(pinned.transport.host,'dial.example');
 }
 const explicit=parseLink(`vless://${id}@dial.example:443?security=tls&type=ws&host=cdn.example&sni=tls.example`),pinned=pinCandidate(explicit,'8.8.8.8');
 assert.equal(pinned.transport.host,'cdn.example');assert.equal(pinned.tls.sni,'tls.example');assert.equal(buildXray(pinned,10001,10002).outbounds[0].streamSettings.wsSettings.headers.Host,'cdn.example');
 const grpc=parseLink(`vless://${id}@grpc.example:443?security=tls&type=grpc`),g=buildXray(pinCandidate(grpc,'8.8.8.8'),10001,10002).outbounds[0].streamSettings;
 assert.equal(g.grpcSettings.authority,'grpc.example');assert.equal(g.tlsSettings.serverName,'grpc.example');
 const explicitGrpc=parseLink(`vless://${id}@grpc.example:443?security=tls&type=grpc&authority=authority.example`);
 assert.equal(pinCandidate(explicitGrpc,'8.8.8.8').transport.authority,'authority.example');
});
test('cached core hash verification detects replacement and modification of an already-verified file',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lml-hash-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'core');
 await fs.writeFile(file,'good');const hash=crypto.createHash('sha256').update('good').digest('hex');await Promise.all([verifyCached(file,hash),verifyCached(file,hash)]);
 await fs.writeFile(file+'.new','evil');await fs.rename(file+'.new',file);await assert.rejects(verifyCached(file,hash),/هسته/);
 await fs.writeFile(file,'good');await verifyCached(file,hash);await fs.writeFile(file,'bad!');await assert.rejects(verifyCached(file,hash),/هسته/);
});
