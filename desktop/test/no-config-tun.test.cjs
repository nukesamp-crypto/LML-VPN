'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {buildXray,parseLink}=require('../lib/config-links.cjs'),{cleanSettings}=require('../lib/config.cjs');
const root=path.join(__dirname,'..');
test('old systemTunnel settings are ignored, including when true',()=>{
 const cleaned=cleanSettings({systemTunnel:true,systemProxy:true});assert.equal(Object.hasOwn(cleaned,'systemTunnel'),false);assert.equal(cleaned.systemProxy,true);
});
test('direct configs expose only local proxy inbounds even if obsolete tunnel options are passed',()=>{
 const c=parseLink('vless://11111111-1111-4111-8111-111111111111@example.com:443?security=tls');
 const x=buildXray(c,10808,10809,{systemTunnel:true,ipv6:true});
 assert(x.inbounds.length>=2);assert(x.inbounds.every(v=>['http','socks'].includes(v.protocol)));assert(x.inbounds.every(v=>v.listen==='127.0.0.1'));assert(!JSON.stringify(x).includes('tun'));
});
test('the interface and package have no experimental config tunnel controls or helper binaries',()=>{
 const html=fs.readFileSync(path.join(root,'app/index.html'),'utf8'),js=fs.readFileSync(path.join(root,'app/app.js'),'utf8'),main=fs.readFileSync(path.join(root,'main.cjs'),'utf8');
 assert(!html.includes('system-tunnel'));assert(!js.includes('systemTunnel'));assert(!main.includes('systemTunnel'));
 for(const p of ['resources/bin/wintun.dll','resources/bin/lml-tun-supervisor.exe','tun-supervisor'])assert(!fs.existsSync(path.join(root,p)),p);
 assert(html.includes('این پروژه‌ها به ما کمکی نکرده‌اند'));
});
