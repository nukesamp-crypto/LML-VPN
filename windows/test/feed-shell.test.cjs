'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
test('TheFeed uses the main window and retains upstream name while hiding About',()=>{
 const feature=fs.readFileSync(path.join(__dirname,'../lib/feed-window.cjs'),'utf8');
 const html=fs.readFileSync(path.join(__dirname,'../app/index.html'),'utf8');
 const css=fs.readFileSync(path.join(__dirname,'../app/feed-theme.css'),'utf8');
 assert(!/new BrowserWindow/.test(feature));assert.match(feature,/contentView\.addChildView/);
 assert.match(html,/data-page="feed"/);assert.match(html,/تلگرام \(سارتو\)/);assert.match(css,/TheFeed/);
 assert(!css.includes('LML FEED'));assert.match(css,/#settingsTabBtnAbout/);assert(!html.includes('بخش مستقل آماده است'));
});
