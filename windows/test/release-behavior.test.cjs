'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..');
test('config connection has no confirmation dialog and bundled cores do not auto-update from GitHub',()=>{
 const main=fs.readFileSync(path.join(root,'main.cjs'),'utf8'),feed=fs.readFileSync(path.join(root,'lib/feed-window.cjs'),'utf8');
 const start=main.indexOf("case 'configsConnect'");const end=main.indexOf("case 'configsDisconnect'",start);assert(start>0&&end>start);
 assert(!main.slice(start,end).includes('showMessageBox'));assert(!main.includes('checkAppUpdate'));assert(!main.includes('electron-updater'));assert(!feed.includes('ThefeedUpdater'));
 const pkg=require('../package.json');assert(!pkg.dependencies?.['electron-updater']);
});
