'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{JSDOM}=require('jsdom');
const html=fs.readFileSync(path.join(__dirname,'../app/index.html'),'utf8'),js=fs.readFileSync(path.join(__dirname,'../app/app.js'),'utf8');
const wait=()=>new Promise(r=>setTimeout(r,25));
const copy=x=>JSON.parse(JSON.stringify(x));
async function fixture(t,opts={}){
 const dom=new JSDOM(html,{runScripts:'outside-only',url:'https://app.local/'});t.after(()=>dom.window.close());const {window}=dom;
 window.scrollTo=()=>{};window.setInterval=()=>0;
 const item={id:'1'.repeat(24),name:'LML VPN',source:'Google',scheme:'VLESS',network:'tcp',security:'tls',latency:42};
 const snap={settings:{engine:'shiro',systemProxy:true,cdnIPs:'',autoStart:false},shiro:{state:opts.engineState||'disconnected',detail:'شیر و خورشید',regions:[]},lantern:{state:'disconnected'},configConnection:{state:'disconnected',detail:'آمادهٔ انتخاب کانفیگ'},configProbe:{running:false,done:0,total:0}};
 const calls=[];
 window.lml={platform:'windows',invoke:async(method,data={})=>{
  calls.push({method,data:copy(data)});
  if(method==='snapshot')return copy(snap);
  if(method==='configsList')return {items:[item],revision:1};
  if(method==='servers')return [];
  if(method==='selectEngine'){snap.settings.engine=data.engine;return copy(snap);}
  if(method==='disconnect'){snap.shiro.state='disconnected';return copy(snap);}
  if(method==='connect'){snap.shiro.state='connecting';return copy(snap);}
  if(method==='configsConnect'){
   snap.configConnection=opts.fail?{state:'error',detail:'خطای واقعی کانفیگ انتخابی',id:data.id}:
    {state:'connected',detail:'کانفیگ فعال است',id:data.id,tested:true};
   return copy(snap);
  }
  if(method==='configsDisconnect'){snap.configConnection={state:'disconnected',detail:'قطع شد'};return copy(snap);}
  return copy(snap);
 }};
 window.eval(js);await wait();await wait();const d=window.document;
 d.querySelector('[data-nav="configs"]').click();await wait();
 d.querySelector(`[data-config-id="${item.id}"]`).click();await wait();
 return {d,calls,snap,item,window};
}
test('selecting a config makes the home power button connect precisely that config',async t=>{
 const {d,calls,item}=await fixture(t);
 assert.match(d.querySelector('#selected-engine-mini').textContent,/کانفیگ/);
 d.querySelector('[data-nav="home"]').click();d.querySelector('#power-button').click();await wait();
 const call=calls.filter(x=>['connect','configsConnect'].includes(x.method)).at(-1);
 assert.equal(call.method,'configsConnect');assert.equal(call.data.id,item.id);assert.equal(call.data.mode,'direct');
 assert(!calls.some(x=>x.method==='connect'),'selecting a config must never silently start an engine');
 assert.match(d.querySelector('#selected-engine-mini').textContent,/کانفیگ/);
 d.querySelector('#power-button').click();await wait();assert.equal(calls.at(-1).method,'configsDisconnect');
});
test('explicitly choosing an engine switches the next home power action back to that engine',async t=>{
 const {d,calls}=await fixture(t);d.querySelector('[data-engine="shiro"]').click();await wait();
 assert.match(d.querySelector('#selected-engine-mini').textContent,/شیر/);
 d.querySelector('#power-button').click();await wait();assert.equal(calls.at(-1).method,'connect');
 assert(!calls.some(x=>x.method==='configsConnect'));
});
test('an existing engine is disconnected first; next power click connects the selected config',async t=>{
 const {d,calls,item}=await fixture(t,{engineState:'connected'});
 assert.match(d.querySelector('#selected-engine-mini').textContent,/شیر/,'display the currently active engine honestly');
 d.querySelector('#power-button').click();await wait();assert.equal(calls.at(-1).method,'disconnect');
 d.querySelector('#power-button').click();await wait();assert.equal(calls.at(-1).method,'configsConnect');assert.equal(calls.at(-1).data.id,item.id);
});
test('a selected config failure is shown as a config error, not the engine state',async t=>{
 const {d}=await fixture(t,{fail:true});d.querySelector('#power-button').click();await wait();
 assert.equal(d.querySelector('#state-title').textContent,'اتصال برقرار نشد');
 assert.match(d.querySelector('#state-detail').textContent,/خطای واقعی کانفیگ/);
 assert.match(d.querySelector('#selected-engine-mini').textContent,/کانفیگ/);
});

test('using the config-page connect button restores config intent even after an engine was selected',async t=>{
 const {d,calls,item}=await fixture(t,{fail:true});
 d.querySelector('[data-engine="shiro"]').click();await wait();assert.match(d.querySelector('#selected-engine-mini').textContent,/شیر/);
 d.querySelector('#config-connect').click();await wait();assert.equal(calls.at(-1).method,'configsConnect');assert.equal(calls.at(-1).data.id,item.id);
 assert.match(d.querySelector('#selected-engine-mini').textContent,/کانفیگ/);assert.match(d.querySelector('#state-detail').textContent,/خطای واقعی کانفیگ/);
});
