'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {createAppUpdater}=require('../lib/app-updater.cjs');
test('GitHub whole-app updater allows stable newer releases only and installs on quit',async()=>{
 const u=new EventEmitter();u.setFeedURL=value=>{u.feed=value};u.checkForUpdates=async()=>u.emit('update-not-available');let installed=0;u.quitAndInstall=()=>installed++;
 const a=createAppUpdater({app:{isPackaged:true},autoUpdater:u,platform:'win32'});
 try{assert.deepEqual(u.feed,{provider:'github',owner:'nukesamp-crypto',repo:'LML-VPN',releaseType:'release'});assert.equal(u.allowDowngrade,false);assert.equal(u.allowPrerelease,false);assert.equal(u.autoDownload,true);assert.equal(u.autoInstallOnAppQuit,true);
  await a.check();assert.equal(a.snapshot().state,'current');assert.equal(a.install(),false);
  u.emit('update-downloaded',{version:'1.0.2'});assert.equal(a.snapshot().state,'ready');assert.equal(a.install(),true);assert.equal(installed,1);
 }finally{a.stop();}
});
test('actual updater version comparison never downgrades a 1.1.1 installation to 1.0.x',async()=>{
 const {AppUpdater}=require('electron-updater/out/AppUpdater'),semver=require('semver');
 const ctx={currentVersion:semver.parse('1.1.1'),allowDowngrade:false,isUpdateSupported:()=>true,isStagingMatch:async()=>true};
 for(const version of ['1.0.0','1.0.1','1.1.1'])assert.equal(await AppUpdater.prototype.isUpdateAvailable.call(ctx,{version}),false);
 assert.equal(await AppUpdater.prototype.isUpdateAvailable.call(ctx,{version:'1.1.2'}),true);
});
