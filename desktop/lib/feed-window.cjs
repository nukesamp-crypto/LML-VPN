'use strict';
const path=require('node:path');
const fs=require('node:fs/promises');
const {ThefeedController,WINDOWS_SHA256}=require('./thefeed.cjs');

// The official client runs as its own authenticated, loopback-only process.
// Its renderer is a sandboxed view inside the main window, never a new window;
// no privileged LML preload is exposed to the upstream network-facing page.
function createFeedFeature({app,WebContentsView,session,shell,dialog,binDir,getMainWindow}) {
  const devOverride=!app.isPackaged && process.platform!=='win32' && process.env.LML_FEED_DEV_BIN;
  const executable=devOverride || path.join(binDir(),'thefeed-client.exe');
  const controller=new ThefeedController({executable,dataDir:path.join(app.getPath('userData'),'thefeed'),expectedHash:devOverride?null:WINDOWS_SHA256});
  const partition=session.fromPartition('persist:lml-thefeed');
  let view=null,endpoint=null,status={state:'starting'},theme='',pins='',loading=null,ready=false,visible=false,bounds=null,lastExternal={url:'',time:0};
  const parent=()=>{const p=getMainWindow();return p && !p.isDestroyed()?p:null;};
  function isFeedURL(value){try{return !!endpoint && new URL(value).origin===endpoint.origin;}catch{return false;}}
  function sendStatus(next){status=next;const win=parent();if(win && !win.webContents.isDestroyed())win.webContents.send('feed:status',next);}
  function safeExternal(value){
    try{
      const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)return;
      const host=u.hostname.toLowerCase();if(host==='localhost'||host==='[::1]'||/^127\./.test(host)||host==='0.0.0.0')return;
      if(lastExternal.url===u.href && Date.now()-lastExternal.time<1500)return;
      lastExternal={url:u.href,time:Date.now()};void shell.openExternal(u.href).catch(()=>{});
    }catch{}
  }
  function layout(){
    const win=parent();if(!win||!view)return;
    if(!bounds){view.setVisible(false);return;}
    const [w,h]=win.getContentSize();
    // Bounds come only from the trusted main renderer, and are clipped to the
    // visible window to avoid the view covering window controls or menus.
    const x=Math.max(0,Math.min(w-1,Math.round(bounds.x)));
    const y=Math.max(0,Math.min(h-1,Math.round(bounds.y)));
    const right=Math.max(x+1,Math.min(w,Math.round(bounds.x+bounds.width)));
    const bottom=Math.max(y+1,Math.min(h,Math.round(bounds.y+bounds.height)));
    view.setBounds({x,y,width:right-x,height:bottom-y});
    view.setVisible(!!(visible && ready && bounds.width>1 && bounds.height>1));
  }
  function detach(){
    if(!view)return;const old=view;view=null;ready=false;
    const win=parent();if(win){try{win.contentView.removeChildView(old);}catch{}}
    try{old.webContents.close();}catch{}
  }
  partition.webRequest.onBeforeSendHeaders((details,callback)=>{
    const headers={...details.requestHeaders};
    if(isFeedURL(details.url))headers.Authorization='Basic '+Buffer.from('lml:'+endpoint.secret).toString('base64');
    callback({requestHeaders:headers});
  });
  partition.setPermissionRequestHandler((contents,permission,callback,details)=>{
    const requesting=(details && details.requestingUrl)||contents?.getURL()||'';
    callback(!!view && contents===view.webContents && isFeedURL(requesting) && ['notifications','clipboard-read','clipboard-sanitized-write'].includes(permission));
  });
  partition.setPermissionCheckHandler((contents,permission,origin)=>!!view && contents===view.webContents && isFeedURL(origin) && ['notifications','clipboard-read','clipboard-sanitized-write'].includes(permission));
  partition.on('will-download',(_event,item,contents)=>{
    const win=parent();if(!view||contents!==view.webContents||!win){item.cancel();return;}
    const raw=path.basename(item.getFilename()||'thefeed-download');
    const safe=raw.replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').slice(0,160)||'thefeed-download';
    const target=dialog.showSaveDialogSync(win,{title:'ذخیرهٔ فایل',defaultPath:path.join(app.getPath('downloads'),safe)});
    if(!target){item.cancel();return;}item.setSavePath(target);
    item.once('done',(_e,state)=>{if(state!=='completed' && state!=='cancelled')sendStatus({state:'error',message:'دریافت فایل کامل نشد؛ دوباره تلاش کن.'});});
  });
  controller.on('unexpected-exit',()=>{endpoint=null;ready=false;layout();sendStatus({state:'error',message:'TheFeed متوقف شد؛ دوباره تلاش کن.'});});
  async function start(){
    if(loading)return loading;
    loading=(async()=>{
      sendStatus({state:'starting'});ready=false;layout();
      try{
        theme=theme||await fs.readFile(path.join(__dirname,'..','app','feed-theme.css'),'utf8');
        pins=pins||await fs.readFile(path.join(__dirname,'..','app','feed-pins.js'),'utf8');
        endpoint=await controller.start();
        await partition.setProxy({mode:'direct'}); // TheFeed doesn't depend on the system proxy.
        const win=parent();if(!win)return;detach();
        view=new WebContentsView({webPreferences:{partition:'persist:lml-thefeed',contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,spellcheck:false,backgroundThrottling:false}});
        const current=view;current.setBackgroundColor('#fbfaf7');current.setVisible(false);win.contentView.addChildView(current);layout();
        let skinReady=Promise.resolve();
        current.webContents.on('dom-ready',()=>{
          // The shortcut is bundled trusted code, applied only to the local,
          // authenticated TheFeed view; it never touches account membership.
          skinReady=Promise.resolve().then(()=>Promise.all([current.webContents.insertCSS(theme,{cssOrigin:'user'}),current.webContents.executeJavaScript(pins)]));
          skinReady.catch(()=>{}); // did-finish-load below reports the failure
        });
        current.webContents.on('did-finish-load',async()=>{
          try{await skinReady;}catch{if(view===current){ready=false;layout();sendStatus({state:'error',message:'آماده‌سازی نمای TheFeed انجام نشد؛ دوباره تلاش کن.'});}return;}
          if(view===current && parent()){ready=true;layout();sendStatus({state:'ready'});}
        });
        current.webContents.on('render-process-gone',()=>{if(view===current){ready=false;layout();sendStatus({state:'error',message:'نمایش TheFeed متوقف شد؛ دوباره تلاش کن.'});}});
        current.webContents.setWindowOpenHandler(({url})=>{if(!isFeedURL(url))safeExternal(url);return {action:'deny'};});
        current.webContents.on('will-navigate',(event,url)=>{if(!isFeedURL(url)){event.preventDefault();safeExternal(url);}});
        await current.webContents.loadURL(endpoint.origin+'/');
      }catch(e){endpoint=null;ready=false;layout();sendStatus({state:'error',message:String(e?.message||'راه‌اندازی TheFeed ممکن نشد.').slice(0,240)});}
    })().finally(()=>{loading=null;});return loading;
  }
  function position(rect){
    if(rect && ['x','y','width','height'].every(k=>Number.isFinite(rect[k])) && rect.width>=0 && rect.height>=0)bounds=rect;
    layout();
  }
  async function show(rect){visible=true;position(rect);if(!view && !loading)void start();else {layout();sendStatus(status);}return true;}
  function hide(){visible=false;layout();return true;}
  async function retry(){detach();await controller.stop();return start();}
  async function stop(){visible=false;detach();await controller.stop();}
  return {show,hide,position,retry,stop,getView:()=>view,getController:()=>controller};
}
module.exports={createFeedFeature};
