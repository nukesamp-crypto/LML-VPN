'use strict';
const {contextBridge,ipcRenderer}=require('electron');
function subscribe(channel,callback){if(typeof callback==='function')ipcRenderer.on(channel,(_e,value)=>callback(value));}
contextBridge.exposeInMainWorld('lml', Object.freeze({
  platform:'windows',
  invoke: (method, data) => ipcRenderer.invoke('lml:invoke', method, data),
  window: action => ipcRenderer.send('lml:window', action),
  onFeedStatus:callback=>subscribe('feed:status',callback),
  onConfigs:callback=>subscribe('configs:updated',callback),
  onConfigProgress:callback=>subscribe('configs:progress',callback),
  onAppUpdate:callback=>subscribe('app:update',callback)
}));
