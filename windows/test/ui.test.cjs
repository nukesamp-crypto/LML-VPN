'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const html=fs.readFileSync(path.join(__dirname,'../app/index.html'),'utf8');
const js=fs.readFileSync(path.join(__dirname,'../app/app.js'),'utf8');
const wait=()=>new Promise(resolve=>setTimeout(resolve,25));

test('dashboard country selector uses the chosen engine’s actual list',async()=>{
  const dom=new JSDOM(html,{runScripts:'outside-only',url:'https://app.local/'});
  const {window}=dom, calls=[];
  const snap={settings:{engine:'shiro',systemProxy:true,cdnIPs:'',sniNames:'',autoStart:false,region:'',lanternTag:''},
    shiro:{state:'disconnected',detail:'ready',regions:['DE','NL']},lantern:{state:'disconnected',detail:'ready'}};
  const fakeServers=[{tag:'actual-de-tag',countryCode:'DE',country:'Germany',city:'Frankfurt'},
    {tag:'actual-us-tag',countryCode:'US',country:'U.S.A.',city:'Los Angeles'}];
  window.scrollTo=()=>{};window.setInterval=()=>0;
  window.lml={platform:'windows',invoke:async(method,data)=>{
    calls.push({method,data});
    if(method==='servers')return fakeServers;
    if(method==='selectEngine')snap.settings.engine=data.engine;
    if(method==='selectServer')snap.settings.lanternTag=data.tag;
    if(method==='saveSettings')Object.assign(snap.settings,data);
    if(method==='connect')snap.lantern.state='connecting';
    if(method==='disconnect')snap.lantern.state='disconnected';
    return JSON.parse(JSON.stringify(snap));
  }};
  window.eval(js); await wait();
  const d=window.document,select=d.querySelector('#home-region');
  assert.equal(d.querySelector('[data-page="home"] #home-region'),select);
  assert.deepEqual(Array.from(select.options,x=>x.value),['','DE','NL','GB','US','CA','FR','TR']);
  assert.equal(d.querySelector('[data-page="about"]'),null);
  assert.equal(d.querySelector('#add-private'),null);
  assert(!d.body.textContent.includes('موتورهای داخلی'));
  assert(d.body.textContent.includes('v1.0.1'));
  d.querySelector('[data-engine="lantern"]').click(); await wait(); await wait();
  assert.deepEqual(Array.from(select.options,x=>x.value),['','actual-de-tag','actual-us-tag']);
  select.value='actual-de-tag';select.dispatchEvent(new window.Event('change',{bubbles:true}));await wait();
  assert(calls.some(x=>x.method==='selectServer'&&x.data.tag==='actual-de-tag'));
  d.querySelector('#power-button').click();await wait();
  assert.equal(d.querySelector('#state-title').textContent,'در حال اتصال');
  assert.equal(select.disabled,true);
  d.querySelector('#power-button').click();await wait();
  assert(calls.some(x=>x.method==='disconnect'));
  dom.window.close();
});

test('Android receives Lantern server results asynchronously and allows choosing one',async()=>{
  const dom=new JSDOM(html,{runScripts:'outside-only',url:'https://app.local/'});
  const {window}=dom,calls=[]; let tick;
  window.scrollTo=()=>{};window.setInterval=fn=>{tick=fn;return 0;};
  const snap={settings:{engine:'lantern',systemProxy:false,cdnIPs:'',sniNames:'',autoStart:false,region:'',lanternTag:''},
    shiro:{state:'disconnected',regions:[]},lantern:{state:'disconnected',detail:'ready',serversReady:false,servers:[]}};
  const servers=[{tag:'de-real',countryCode:'DE',country:'Germany',city:'Frankfurt'}];
  window.LMLNative={invoke:(method,raw)=>{
    const data=JSON.parse(raw);calls.push({method,data});
    if(method==='servers')return JSON.stringify({ok:true,value:[]});
    if(method==='selectServer')snap.settings.lanternTag=data.tag;
    return JSON.stringify({ok:true,value:snap});
  }};
  window.eval(js);await wait();
  assert(calls.some(x=>x.method==='servers'));
  const select=window.document.querySelector('#home-region');
  assert.equal(select.disabled,false);
  assert.match(window.document.querySelector('#country-hint').textContent,/دریافت/);
  snap.lantern.serversReady=true;snap.lantern.servers=servers;
  await tick();await wait();
  assert.deepEqual(Array.from(select.options,x=>x.value),['','de-real']);
  select.value='de-real';select.dispatchEvent(new window.Event('change',{bubbles:true}));await wait();
  assert(calls.some(x=>x.method==='selectServer'&&x.data.tag==='de-real'));
  assert.equal(window.document.querySelector('#android-banner').classList.contains('hidden'),false);
  dom.window.close();
});

test('TheFeed entry opens inside the main navigation without connecting a VPN',async()=>{
 const dom=new JSDOM(html,{runScripts:'outside-only',url:'https://app.local/'});
 const {window}=dom,calls=[];
 window.scrollTo=()=>{};window.setInterval=()=>0;
 const snapshot={settings:{engine:'shiro',systemProxy:false,cdnIPs:'',sniNames:'',autoStart:false,region:'',lanternTag:''},
  shiro:{state:'disconnected',detail:'ready',regions:[]},lantern:{state:'disconnected',detail:'ready'}};
 window.lml={platform:'windows',invoke:async(method,data)=>{calls.push(method);return method==='snapshot'?snapshot:true;},window:()=>{}};
 window.eval(js);await wait();
 window.document.querySelector('[data-nav="feed"]').click();await wait();
 assert(window.document.querySelector('[data-page="feed"]').classList.contains('active'));
 assert(window.document.querySelector('[data-nav="feed"]').textContent.includes('تلگرام (سارتو)'));
 window.document.querySelector('[data-nav="home"]').click();await wait();assert(calls.includes('hideFeed'));
 assert(calls.includes('openFeed'));assert(!calls.includes('connect'));assert(!calls.includes('selectEngine'));
 dom.window.close();
});

test('Lantern locations are retried automatically after an initially empty response',async()=>{
 const dom=new JSDOM(html,{runScripts:'outside-only',url:'https://app.local/'});const {window}=dom;let tick,count=0,now=1000;
 window.scrollTo=()=>{};window.setInterval=fn=>{tick=fn;return 0;};window.Date.now=()=>now;
 const snapshot={settings:{engine:'lantern',systemProxy:false,cdnIPs:'',sniNames:'',autoStart:false,region:'',lanternTag:''},shiro:{state:'disconnected',regions:[]},lantern:{state:'disconnected',detail:'ready'}};
 window.lml={platform:'windows',invoke:async method=>{if(method==='servers'){count++;return count===1?[]:[{tag:'eventually-ready',countryCode:'DE',country:'Germany',city:'Frankfurt'}];}if(method==='snapshot')return snapshot;return true;}};
 window.eval(js);await wait();assert.equal(count,1);assert.match(window.document.querySelector('#country-hint').textContent,/دوباره/);
 now+=10000;await tick();await wait();await wait();assert.equal(count,2);assert.deepEqual(Array.from(window.document.querySelector('#home-region').options,x=>x.value),['','eventually-ready']);
 dom.window.close();
});

test('local config proxy is not shown as a confirmed connection when HTTPS probe fails',async()=>{
 const dom=new JSDOM(html,{runScripts:'outside-only',url:'https://app.local/'});const {window}=dom;window.scrollTo=()=>{};window.setInterval=()=>0;
 const snapshot={settings:{engine:'shiro',systemProxy:true,cdnIPs:'',sniNames:'',autoStart:false,region:'',lanternTag:''},shiro:{state:'disconnected',regions:[]},lantern:{state:'disconnected'},configConnection:{state:'connected',detail:'پراکسی فعال است، اما آزمون HTTPS موفق نشد.',tested:false}};
 const calls=[];window.lml={platform:'windows',invoke:async method=>{calls.push(method);if(method==='snapshot')return snapshot;return {items:[]};}};
 window.eval(js);await wait();assert.match(window.document.querySelector('#state-title').textContent,/ناموفق/);assert.equal(window.document.querySelector('#power-button').getAttribute('aria-label'),'قطع اتصال');
 window.document.querySelector('#power-button').click();await wait();assert(calls.includes('configsDisconnect'));dom.window.close();
});

test('fast navigation away cancels the queued TheFeed view opening',async()=>{
 const dom=new JSDOM(html,{runScripts:'outside-only',url:'https://app.local/'});const {window}=dom;window.scrollTo=()=>{};window.setInterval=()=>0;
 const snapshot={settings:{engine:'shiro',systemProxy:false,cdnIPs:'',sniNames:'',autoStart:false,region:'',lanternTag:''},shiro:{state:'disconnected',regions:[]},lantern:{state:'disconnected'}};
 const calls=[];window.lml={platform:'windows',invoke:async method=>{calls.push(method);if(method==='snapshot')return snapshot;return {items:[]};}};
 window.eval(js);await wait();window.document.querySelector('[data-nav="feed"]').click();window.document.querySelector('[data-nav="home"]').click();await wait();
 assert(calls.includes('hideFeed'));assert(!calls.includes('openFeed'));dom.window.close();
});

test('config section offers separate direct and two chain modes and starts the selected mode',async()=>{
 const dom=new JSDOM(html,{runScripts:'outside-only',url:'https://app.local/'});const {window}=dom,calls=[];window.scrollTo=()=>{};window.setInterval=()=>0;
 const snapshot={settings:{engine:'shiro',systemProxy:false,cdnIPs:'',sniNames:'',autoStart:false,region:'',lanternTag:'',routingPreset:'global',routingCustom:''},shiro:{state:'disconnected',regions:[]},lantern:{state:'disconnected'},configConnection:{state:'disconnected'}};
 const item={id:'123456789012345678901234',name:'my route',source:'@sample · DNS/فید',scheme:'vless',network:'tcp',security:'tls'};
 window.lml={platform:'windows',invoke:async(method,data)=>{calls.push({method,data});if(method==='snapshot')return snapshot;if(method==='configsList')return {items:[item],subscriptions:[]};if(method==='configsConnect'){snapshot.configConnection={state:'connecting',detail:'در حال اتصال',tested:null};return snapshot}if(method==='configsDisconnect'){snapshot.configConnection={state:'disconnected'};return snapshot}return true;}};
 window.eval(js);await wait();window.document.querySelector('[data-nav="configs"]').click();await wait();
 assert.equal(window.document.querySelector('[data-page="configs"]').classList.contains('active'),true);
 assert.deepEqual(Array.from(window.document.querySelector('#config-mode').options,o=>o.value),['direct','psiphon-via-xray','xray-via-psiphon']);
 const proto=window.document.querySelector('#config-protocol-filter');proto.value='VLESS';proto.dispatchEvent(new window.Event('change'));assert(window.document.querySelector('[data-config-id]'));
 window.document.querySelector('[data-config-id]').click();const sel=window.document.querySelector('#config-mode');sel.value='xray-via-psiphon';sel.dispatchEvent(new window.Event('change'));
 window.document.querySelector('#config-connect').click();await wait();assert(calls.some(x=>x.method==='configsConnect'&&x.data.mode==='xray-via-psiphon'));
 window.document.querySelector('#config-connect').click();await wait();assert(calls.some(x=>x.method==='configsDisconnect'));
 assert(calls.some(x=>x.method==='configsRefresh'));assert.equal(window.document.querySelector('#config-manual'),null);assert.equal(window.document.querySelector('#config-add'),null);assert.equal(window.document.querySelector('#subscription-url'),null);assert(window.document.querySelector('[data-nav="engines"]').textContent.includes('لنترن'));
 dom.window.close();
});

test('Telegram channel button opens only the whitelisted channel key',async()=>{
 const dom=new JSDOM(html,{runScripts:'outside-only',url:'https://app.local/'});const {window}=dom,calls=[];window.scrollTo=()=>{};window.setInterval=()=>0;
 const snapshot={settings:{engine:'shiro',systemProxy:false,cdnIPs:'',sniNames:'',autoStart:false,region:'',lanternTag:''},shiro:{state:'disconnected',regions:[]},lantern:{state:'disconnected'}};
 window.lml={platform:'windows',invoke:async(method,data)=>{calls.push({method,data});if(method==='snapshot')return snapshot;return true;}};
 window.eval(js);await wait();window.document.querySelector('.channel-card').click();await wait();assert(calls.some(x=>x.method==='openLink'&&x.data.key==='channel'));dom.window.close();
});
