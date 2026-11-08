'use strict';
// The direct Telegram/GitHub fallback tests were replaced by the stronger
// Google-only route, redirect, size, cancellation and scan tests in
// google-mirror-regression.test.cjs. Keep the fresh-first/cache regression.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {ConfigSources,CHANNELS}=require('../lib/config-source.cjs'),{parseLink}=require('../lib/config-links.cjs');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const sample=()=>({...parseLink('vless://11111111-1111-4111-8111-111111111111@example.com:443?security=tls'),source:'@cached · Google'});
async function fixture(t,options){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lml-google-fresh-'));const s=new ConfigSources({app:{getPath:()=>dir,isPackaged:false},binDir:()=>dir,geo:{lookup:async()=>''},...options});t.after(async()=>{await s.stop();await fs.rm(dir,{recursive:true,force:true});});return s;}

test('freshly acquired candidates are tested before old cached entries without resetting counts',async t=>{
 const old=sample(),fresh={...parseLink('vless://22222222-2222-4222-8222-222222222222@fresh.example.com:443?security=tls'),source:'@fresh · Google'};
 let release;const gate=new Promise(r=>release=r);
 const s=await fixture(t,{fetchTelegram:async name=>{if(name===CHANNELS[0])return [fresh];await gate;return [];}});
 s.entries.set(old.id,old);const job=s.refresh();for(let i=0;i<100&&!s.get(fresh.id);i++)await wait(2);
 assert.deepEqual(s.pendingIds(),[fresh.id,old.id]);assert.equal(s.snapshot().scan.found,2);
 const stopping=s.cancelRefresh();release();await stopping;await job;
});
