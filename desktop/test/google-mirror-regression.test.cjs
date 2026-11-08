'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{EventEmitter}=require('node:events'),{Readable}=require('node:stream'),{JSDOM}=require('jsdom');
const {ConfigSources,CHANNELS,googleTelegram}=require('../lib/config-source.cjs'),{parseLink}=require('../lib/config-links.cjs');
const sample=()=>({...parseLink('vless://11111111-1111-4111-8111-111111111111@example.com:443?security=tls'),source:'@one · Google'});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(t,options){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lml-google-test-'));const s=new ConfigSources({app:{getPath:()=>dir,isPackaged:false},binDir:()=>dir,geo:{lookup:async()=>''},...options});t.after(async()=>{await s.stop();await fs.rm(dir,{recursive:true,force:true});});return s;}
function fakeRequest({status=200,body='',hang=false,headers={}}={},seen=[]){return (opts,callback)=>{
 seen.push(opts);const req=new EventEmitter();let destroyed=false;
 req.destroy=err=>{if(destroyed)return;destroyed=true;setImmediate(()=>req.emit('error',err||Error('closed')));};
 if(opts.signal){if(opts.signal.aborted)req.destroy(Error('aborted'));else opts.signal.addEventListener('abort',()=>req.destroy(Error('aborted')),{once:true});}
 req.end=()=>{if(!hang)setImmediate(()=>{if(destroyed)return;const res=Readable.from([Buffer.from(body)]);res.statusCode=status;res.headers=headers;callback(res);});};return req;
};}
test('Google mirror uses authenticated Google TLS and extracts real Telegram text without following redirects',async()=>{
 const seen=[],body='<div class="tgme_page"><code>vless://11111111-1111-4111-8111-111111111111@example.com:443?security=tls</code></div>';
 const entries=await googleTelegram(CHANNELS[0],{route:'fronted',request:fakeRequest({body},seen)});
 assert.equal(entries.length,1);assert.match(entries[0].source,/Google/);
 assert.equal(seen[0].hostname,'www.google.com');assert.equal(seen[0].servername,'www.google.com');assert.equal(seen[0].headers.Host,'t-me.translate.goog');
 assert.equal(seen[0].rejectUnauthorized,true);assert.match(seen[0].path,new RegExp('^/s/'+CHANNELS[0]+'\\?'));assert.match(seen[0].path,/_x_tr_/);
 const translate=[];await googleTelegram(CHANNELS[1],{route:'translate',request:fakeRequest({body},translate)});assert.equal(translate[0].hostname,'t-me.translate.goog');
 await assert.rejects(googleTelegram('not-allowed',{request:fakeRequest({body})}));
 await assert.rejects(googleTelegram(CHANNELS[0],{request:fakeRequest({status:302,body:''})}));
 await assert.rejects(googleTelegram(CHANNELS[0],{request:fakeRequest({body:'<html>CAPTCHA</html>'})}));
});
test('Google mirror has bounded responses and promptly cancels a hanging request',async()=>{
 const abort=new AbortController(),job=googleTelegram(CHANNELS[0],{request:fakeRequest({hang:true}),signal:abort.signal,timeoutMs:5000});
 await wait(10);const start=Date.now();abort.abort();await assert.rejects(job);assert(Date.now()-start<500);
 await assert.rejects(googleTelegram(CHANNELS[0],{request:fakeRequest({body:'x'.repeat(3_000_001)})}));
});
test('the config search scans 400 channels in order using only Google, and labels successful results Google',async t=>{
 const calls=[],result=sample();let dnsCalls=0,mirrorCalls=0,active=0,peak=0;
 const s=await fixture(t,{fetchTelegram:async(name,{route})=>{active++;peak=Math.max(peak,active);calls.push({name,route});await wait(1);active--;return name===CHANNELS[0]?[result]:[];},
  dnsSource:{fetch:async()=>{dnsCalls++;return [result];},stop:async()=>{}},fetchMirror:async()=>{mirrorCalls++;return [result];}});
 const state=await s.refresh();assert.deepEqual(calls.map(x=>x.name),CHANNELS);assert(calls.every(x=>x.route===undefined));assert.equal(peak,1);
 assert.equal(dnsCalls,0);assert.equal(mirrorCalls,0);assert.equal(state.scan.channelsDone,400);assert.equal(state.scan.errors,0);assert.equal(state.candidateCount,1);
 s.setLatency(result.id,42,{...result,address:'8.8.8.8',transport:result.transport});assert.equal(s.snapshot().items[0].source,'Google');
 assert.match(s.snapshot().note,/Google/);assert(!s.snapshot().note.includes('وب تلگرام'));
});
test('the scanner delegates channel transport to the source rather than inventing Google routes',async t=>{
 const calls=[];const s=await fixture(t,{fetchTelegram:async(name,opts)=>{calls.push([name,opts.route]);return [];}});
 const result=await s.refresh();assert.equal(result.scan.channelsDone,400);assert.deepEqual(calls.map(x=>x[0]),CHANNELS);assert(calls.every(([,route])=>route===undefined));
});
test('after three actual transport failures the scan stops early to save bandwidth',async t=>{
 const names=[],s=await fixture(t,{fetchTelegram:async name=>{names.push(name);throw Object.assign(Error('blocked'),{code:'MIRROR_UPSTREAM'});}});const r=await s.refresh();
 assert.equal(r.scan.channelsDone,3);assert.equal(r.scan.errors,3);assert.equal(r.candidateCount,0);assert.deepEqual(names,CHANNELS.slice(0,3));assert.match(r.note,/مصرف/);assert.match(r.note,/TheFeed/);
});
test('pre-Google caches are not relabelled as Google mirror results',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lml-old-cache-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await fs.writeFile(path.join(dir,'public-configs.json'),JSON.stringify({fetchedAt:Date.now(),links:[{raw:sample().raw,source:'old non-Google'}]}));
 const s=new ConfigSources({app:{getPath:()=>dir,isPackaged:false},binDir:()=>dir,fetchTelegram:async()=>[]});t.after(()=>s.stop());await s.load();
 assert.notEqual(path.basename(s.file),'public-configs.json');assert.equal(s.pendingIds().length,0);
});
test('config screen identifies one Google source and explains the Telegram origin',()=>{
 const html=require('node:fs').readFileSync(path.join(__dirname,'../app/index.html'),'utf8');const dom=new JSDOM(html);const page=dom.window.document.querySelector('[data-page="configs"]');
 assert.match(page.textContent,/Google/);assert.match(page.textContent,/تلگرام/);assert(!page.textContent.includes('DNS فید'));
 const filter=page.querySelector('#config-source-filter');assert(filter.disabled);assert.equal(filter.options.length,1);assert.match(filter.textContent,/Google/);dom.window.close();
});
test('Google cache rejects missing provenance, foreign channels and stale mixed-source links',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lml-cache-provenance-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const s=new ConfigSources({app:{getPath:()=>dir,isPackaged:false},binDir:()=>dir,fetchTelegram:async()=>[]});t.after(()=>s.stop());
 const valid=sample().raw,other=valid.replace('example.com','other.example.com'),third=valid.replace('example.com','third.example.com');
 await fs.writeFile(s.file,JSON.stringify({fetchedAt:Date.now(),links:[{raw:valid,source:'@'+CHANNELS[0]+' · Google'}]}));await s.load();assert.equal(s.pendingIds().length,0,'missing provenance marker');
 await fs.writeFile(s.file,JSON.stringify({source:'thefeed-google-mirror-v1',fetchedAt:Date.now(),links:[
  {raw:valid,source:'@'+CHANNELS[0]+' · Google'},{raw:other,source:'@'+CHANNELS[1]+' · DNS/فید'},{raw:third,source:'@not_a_listed_channel · Google'}]}));
 await s.load();assert.equal(s.pendingIds().length,1);assert.equal(s.get(parseLink(valid).id).source,'@'+CHANNELS[0]+' · Google');
});
test('Google edge IP bypasses poisoned DNS but authenticates the Google hostname',async()=>{
 const seen=[],body='<div class="tgme_page">vless://11111111-1111-4111-8111-111111111111@example.com:443?security=tls</div>';
 const result=await googleTelegram(CHANNELS[0],{route:'edge38',request:fakeRequest({body},seen)});
 assert.equal(result.length,1);assert.equal(seen[0].hostname,'216.239.38.120');assert.equal(seen[0].servername,'www.google.com');
 assert.equal(seen[0].headers.Host,'t-me.translate.goog');assert.equal(seen[0].rejectUnauthorized,true);assert.equal(typeof seen[0].checkServerIdentity,'function');
});
test('three missing/private channels are not mistaken for a network outage',async t=>{
 const calls=[];const s=await fixture(t,{fetchTelegram:async name=>{calls.push(name);if(calls.length<=3)throw Object.assign(Error('not found'),{code:'MIRROR_NOT_FOUND'});return [];}});
 const result=await s.refresh();assert.equal(result.scan.errors,3);assert.equal(result.scan.channelsDone,400);assert.deepEqual(calls,CHANNELS);
});
test('when all Google routes fail the UI gives a safe reason and stopping does not invent successful results',async t=>{
 const s=await fixture(t,{fetchTelegram:async()=>{throw Object.assign(Error('secret/path/should/not/be/shown'),{code:'MIRROR_TIMEOUT'});}});
 await s.refresh();assert.match(s.snapshot().note,/زمان|timeout/i);assert(!s.snapshot().note.includes('secret'));
 await s.cancelRefresh();assert(!/نتیجه‌های موفق حفظ شدند/.test(s.snapshot().note));assert.match(s.snapshot().note,/موفقی.*پیدا نشده/);
});
