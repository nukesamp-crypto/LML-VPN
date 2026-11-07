'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const script=fs.readFileSync(path.join(__dirname,'../app/feed-pins.js'),'utf8');
const flush=()=>new Promise(resolve=>setTimeout(resolve,10));
function fixture(t){
 const dom=new JSDOM('<!doctype html><body><div id="channelList"><div id="savedChannelBtn"></div></div><div id="tmChannelsList"></div><div id="telSidebar"></div></body>',{runScripts:'outside-only',url:'http://127.0.0.1:43122/'});
 t.after(()=>dom.window.close());
 let calls=[];dom.window.tmSelectFromClick=name=>calls.push(['mirror',name]);dom.window.telOpenByUsername=name=>calls.push(['telegram',name]);dom.window.fetch=()=>{throw Error('pinning must not call an API');};
 dom.window.eval(script);return {dom,window:dom.window,document:dom.window.document,calls};
}
test('Google mirror always has one working LML shortcut while preserving the other channels',async t=>{
 const {document,calls}=fixture(t),list=document.querySelector('#tmChannelsList');await flush();
 assert.equal(list.firstElementChild.dataset.lmlPinned,'mirror');list.firstElementChild.click();assert.deepEqual(calls,[['mirror','LML_panel']]);
 // Upstream replaces the entire list whenever it loads a channel.
 list.innerHTML='<div class="tm-channel-item" data-u="one"></div><div class="tm-channel-item" data-u="two"></div>';await flush();
 assert.equal(list.children.length,3);assert.equal(list.firstElementChild.dataset.lmlPinned,'mirror');
 assert.deepEqual(Array.from(list.children).slice(1).map(x=>x.dataset.u),['one','two']);
 list.innerHTML='<div class="tm-channel-item" data-u="one"></div><div class="tm-channel-item" data-u="lml_panel"><span class="tm-channel-item-meta"></span><button class="tm-x">×</button></div><div class="tm-channel-item" data-u="two"></div>';await flush();
 assert.equal(list.children.length,3,'never duplicate a channel already in the mirror');
 assert.equal(list.firstElementChild.dataset.u,'lml_panel');assert(list.firstElementChild.querySelector('[data-lml-pin-badge]'));
 assert.deepEqual(Array.from(list.children).slice(1).map(x=>x.dataset.u),['one','two']);
 // The ordinary remove control remains owned by TheFeed; a local shortcut remains.
 list.firstElementChild.remove();await flush();assert.equal(list.firstElementChild.dataset.lmlPinned,'mirror');
});
test('Telegram shortcut appears after login, respects tab/search, and opens without joining',async t=>{
 const {window,document,calls}=fixture(t),sidebar=document.querySelector('#telSidebar');
 sidebar.innerHTML='<div id="telBody"><input id="login"></div>';await flush();assert(!document.querySelector('[data-lml-pinned="telegram"]'));
 window.telState={tab:'all',searchIn:'',search:'',dialogs:[]};sidebar.innerHTML='<div id="telBody"><div class="tel-tabs"></div><div class="tel-list"><div class="tel-row" id="another"></div></div></div>';await flush();
 let button=document.querySelector('[data-lml-pinned="telegram"]');assert(button);assert.equal(button.parentElement.firstElementChild,button);button.click();assert.deepEqual(calls,[['telegram','LML_panel']]);
 window.telState.tab='group';sidebar.innerHTML='<div id="telBody"><div class="tel-tabs"></div><div class="tel-list"></div></div>';await flush();assert(!document.querySelector('[data-lml-pinned="telegram"]'));
 window.telState.tab='channel';window.telState.searchIn='list';window.telState.search='unrelated';sidebar.innerHTML='<div id="telBody"><div class="tel-tabs"></div></div>';await flush();assert(!document.querySelector('[data-lml-pinned="telegram"]'));
 window.telState.search='LML';sidebar.innerHTML='<div id="telBody"><div class="tel-tabs"></div></div>';await flush();assert(document.querySelector('[data-lml-pinned="telegram"]'));
});
test('existing Telegram channel is moved to the top without duplication or account mutation',async t=>{
 const {window,document}=fixture(t),sidebar=document.querySelector('#telSidebar');
 window.telState={tab:'all',dialogs:[{peer:{username:'LML_panel',kind:'channel',id:'123'}}]};window.telPeerKey=p=>p.kind+':'+p.id;
 sidebar.innerHTML=`<div id="telBody"><div class="tel-tabs"></div><div class="tel-list"><div class="tel-row" id="other"></div><div class="tel-row" id="lml" onclick="telOpenPeer('channel:123')"><span class="tel-row-top"></span></div></div></div>`;await flush();
 assert.equal(document.querySelector('.tel-list').firstElementChild.id,'lml');assert(document.querySelector('#lml [data-lml-pin-badge]'));assert(!document.querySelector('[data-lml-pinned="telegram"]'));
 assert.equal(document.querySelectorAll('.tel-row').length,2);
});
test('DNS feed pins LML only if its actual server publishes that channel',async t=>{
 const {document}=fixture(t),list=document.querySelector('#channelList');await flush();
 assert.equal(list.children.length,1,'an unavailable DNS channel must not be fabricated');
 list.insertAdjacentHTML('beforeend','<div class="ch-item" data-name="another"><span class="ch-name"></span></div><div class="ch-item" data-name="@LML_panel"><span class="ch-name"></span></div>');await flush();
 assert.equal(list.children[0].id,'savedChannelBtn');assert.equal(list.children[1].dataset.name,'@LML_panel');assert(list.children[1].querySelector('[data-lml-pin-badge]'));
});
