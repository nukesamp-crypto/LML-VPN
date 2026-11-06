'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
const {parseLink,buildXray,extractLinks,publicEntry}=require('../lib/config-links.cjs');
const id='11111111-1111-4111-8111-111111111111';
const vless=`vless://${id}@example.com:443?type=ws&security=tls&sni=example.com&host=example.com&path=%2Fsecret#Example`;
const vmess='vmess://'+Buffer.from(JSON.stringify({v:'2',ps:'VMess',add:'example.com',port:'443',id,aid:'0',net:'ws',type:'none',host:'example.com',path:'/hello',tls:'tls'})).toString('base64');
const trojan='trojan://password@example.com:443?type=tcp&security=tls#Trojan';
const ss='ss://'+Buffer.from('aes-128-gcm:password').toString('base64')+'@example.com:443#SS';
const xhttp=`vless://${id}@example.com:443?type=xhttp&security=tls&sni=example.com&path=%2Fx#XHTTP`;
test('VLESS/VMess/Trojan/Shadowsocks links produce explicit loopback-only Xray settings',()=>{
 for(const raw of [vless,vmess,trojan,ss,xhttp]){
  const c=parseLink(raw),j=buildXray(c,11111,11112);
  assert.equal(j.inbounds.length,2);assert(j.inbounds.every(x=>x.listen==='127.0.0.1'));assert.equal(j.outbounds.length,1);
  assert.equal(j.outbounds[0].protocol,c.scheme==='ss'?'shadowsocks':c.scheme);
  const visible=JSON.stringify(publicEntry(c));assert(!visible.includes(c.user));assert(!visible.includes('password'));assert(!visible.includes(c.raw));
 }
 assert.equal(parseLink(vmess).transport.network,'ws');assert.equal(parseLink(vmess).transport.security,'tls');
 assert.equal(buildXray(parseLink(vless),11111,11112).outbounds[0].streamSettings.wsSettings.path,'/secret');
});
test('unsupported plugins, local destinations, invalid identifiers and executable-looking schemes are rejected',()=>{
 assert.throws(()=>parseLink('ss://YWVzLTEyOC1nY206cA@example.com:443?plugin=obfs-local'),/پلاگین/);
 assert.throws(()=>parseLink(`vless://${id}@127.0.0.1:443`),/خصوصی/);
 assert.throws(()=>parseLink('vless://bad@example.com:443'),/UUID/);
 assert.throws(()=>parseLink('file:///etc/passwd'),/پروتکل/);
 assert.throws(()=>parseLink('trojan://%0A@example.com:443'),/معتبر/);
});
test('channel content is decoded as data and de-duplicated, never executable markup',()=>{
 const text=`<b onclick="evil()">${vless.replace(/&/g,'&amp;')}</b><p>${vless}</p> javascript:alert(1)`;
 const list=extractLinks(text,'@public');assert.equal(list.length,1);assert.equal(list[0].source,'@public');assert.equal(list[0].remark,'Example');
});
test('insecure legacy TLS request is mapped to verified names, not removed allowInsecure',()=>{
 const c=parseLink('trojan://password@example.com:443?security=tls&allowInsecure=1');
 const tls=buildXray(c,11111,11112).outbounds[0].streamSettings.tlsSettings;
 assert.equal(c.tls.insecure,true);assert.equal(tls.verifyPeerCertByName,'example.com');assert(!Object.hasOwn(tls,'allowInsecure'));
});
test('supported examples pass the exact ZedSecure-pinned Xray binary config checker',{skip:!process.env.LML_XRAY_TEST_BIN},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lml-xray-config-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 for(const [i,link] of [vless,vmess,trojan,ss,xhttp,'trojan://password@example.com:443?security=tls&allowInsecure=1'].entries()){
  const file=path.join(dir,i+'.json');await fs.writeFile(file,JSON.stringify(buildXray(parseLink(link),18001+i*2,18002+i*2)));
  await promisify(execFile)(process.env.LML_XRAY_TEST_BIN,['run','-test','-c',file],{timeout:10000});
 }
});
