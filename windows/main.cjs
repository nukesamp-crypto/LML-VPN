'use strict';
const {app, BrowserWindow, WebContentsView, ipcMain, shell, session, dialog} = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const {spawn} = require('node:child_process');
const readline = require('node:readline');
const {DEFAULTS,cleanSettings,psiphonConfig} = require('./lib/config.cjs');
const lantern = require('./lib/lantern.cjs');
const {ProxyManager} = require('./lib/proxy.cjs');
const {createFeedFeature} = require('./lib/feed-window.cjs');
const {ConfigSources} = require('./lib/config-source.cjs');
const {PsiphonHop} = require('./lib/psiphon-hop.cjs');
const {ChainEngine,MODES} = require('./lib/chain-engine.cjs');
const {ConfigProbe} = require('./lib/config-probe.cjs');
const {buildRouting} = require('./lib/routing.cjs');
const {ConfigEngine} = require('./lib/config-engine.cjs');
const {createAppUpdater} = require('./lib/app-updater.cjs');
const {ConnectionGuard} = require('./lib/connection-guard.cjs');
const connectionGuard = new ConnectionGuard();

const LINKS = Object.freeze({
  lanternWin:'https://s3.amazonaws.com/lantern.io/releases/beta/10.0.5-beta.1/lantern-installer-beta.exe',
  lanternAndroid:'https://s3.amazonaws.com/lantern.io/releases/beta/10.0.5-beta.1/lantern-installer-beta.apk',
  shiroAndroid:'https://github.com/shirokhorshid/shirokhorshid-android/releases/latest',
  lanternSource:'https://github.com/getlantern/lantern/releases/tag/v10.0.5-beta.1',
  shiroSource:'https://github.com/shirokhorshid/shirokhorshid-android',
  psiphonCore:'https://github.com/shirokhorshid/psiphon-tunnel-core',
  help:'https://github.com/getlantern/lantern/issues',
  channel:'https://t.me/LML_panel'
});
let mainWindow, feedFeature, configSources, configEngine, chainEngine, configProbe, appUpdates, settings={...DEFAULTS}, proxy, psiphonProcess=null, stopping=false, quitting=false;
let configKind='direct';
const anyConfigActive=()=>!!(chainEngine?.active()||configEngine?.active());
let shiroState={state:'disconnected',detail:'آمادهٔ اتصال',httpPort:0,socksPort:0,regions:[]};
let lanternState={state:'unknown',detail:'وضعیت سرویس هنوز بررسی نشده است.'};
let lastLanternCheck=0, lanternStartedByUs=false, connectingProxy=false;
let lanternConnectJob=null, lanternController=null, lanternGeneration=0, lanternStopping=false;
const dataDir=()=>app.getPath('userData');
const settingsPath=()=>path.join(dataDir(),'settings.json');
const regionsPath=()=>path.join(dataDir(),'psiphon-regions.json');
const binDir=()=>app.isPackaged ? path.join(process.resourcesPath,'bin') : path.join(__dirname,'resources','bin');
const setShiro=(state,detail, extra={})=>{ shiroState={...shiroState,state,detail,...extra}; };
async function save(){
  const p=settingsPath(), t=p+'.tmp';
  await fs.writeFile(t,JSON.stringify(settings,null,2),{mode:0o600});
  await fs.rename(t,p);
}
async function load(){
  try { settings=cleanSettings(JSON.parse(await fs.readFile(settingsPath(),'utf8'))); }
  catch { settings={...DEFAULTS}; }
  try { const values=JSON.parse(await fs.readFile(regionsPath(),'utf8')); if(Array.isArray(values)) shiroState.regions=[...new Set(values.filter(x=>typeof x==='string' && /^[A-Z]{2}$/.test(x)))].slice(0,100); } catch {}
}
async function refreshLantern(force=false,timeout){
  if (process.platform!=='win32') return lanternState={state:'unavailable',detail:'کنترل سرویس لنترن فقط در ویندوز ارائه شده است.'};
  if (!force && Date.now()-lastLanternCheck < 2000) return lanternState;
  lastLanternCheck=Date.now();
  try {
    const s=await lantern.status(timeout ? {timeout} : undefined);
    const label={connected:'سرویس لنترن متصل است.',disconnected:'سرویس لنترن آماده است.',connecting:'لنترن در حال اتصال است.',disconnecting:'در حال قطع اتصال.',restarting:'در حال راه‌اندازی دوباره.',error:'سرویس لنترن خطا گزارش کرده است.'};
    lanternState={state:label[s]?s:'unknown',detail:label[s]||'وضعیت سرویس نامشخص است.'};
  } catch { lanternState={state:'unavailable',detail:'سرویس داخلی لنترن در دسترس نیست؛ نصب LML VPN را بررسی کن.'}; }
  return lanternState;
}
async function snapshot(){
  if (settings.engine==='lantern' && !lanternConnectJob && !lanternStopping) await refreshLantern(false,2500);
  return {platform:'windows', settings:{...settings}, shiro:{...shiroState}, lantern:{...lanternState}, configConnection:(configKind==='direct'?configEngine:chainEngine)?.snapshot(), configProbe:configProbe?.snapshot(), appUpdate:appUpdates?.snapshot(), version:app.getVersion()};
}
async function onNotice(proc,notice){
  if (proc!==psiphonProcess || stopping || !notice || typeof notice!=='object') return;
  const d=notice.data || {}, kind=notice.noticeType;
  if (kind==='AvailableEgressRegions' && Array.isArray(d.regions)) {
    const regions=[...new Set(d.regions.filter(x=>typeof x==='string' && /^[A-Z]{2}$/.test(x)))].slice(0,100);
    if(JSON.stringify(regions)!==JSON.stringify(shiroState.regions)) {shiroState.regions=regions; void fs.writeFile(regionsPath(),JSON.stringify(regions),{mode:0o600}).catch(()=>{});}
  }
  if (kind==='ListeningHttpProxyPort' && Number.isInteger(d.port)) shiroState.httpPort=d.port;
  if (kind==='ListeningSocksProxyPort' && Number.isInteger(d.port)) shiroState.socksPort=d.port;
  if (kind==='Tunnels') {
    if (Number(d.count)>0) proc._hasTunnel=true;
    else if (proc._hasTunnel) {proc._hasTunnel=false; setShiro('connecting','تونل قطع شد؛ در حال تلاش دوباره.');}
  }
  // Ports can arrive before or after tunnel notices.
  if (proc._hasTunnel && shiroState.httpPort>0 && shiroState.socksPort>0 && shiroState.state!=='connected' && !connectingProxy) {
    connectingProxy=true;
    try {
      if (settings.systemProxy) await proxy.activate(shiroState.httpPort);
      if (proc!==psiphonProcess || stopping) { if (settings.systemProxy) await proxy.restore(); return; }
      setShiro('connected',settings.systemProxy?'تونل برقرار شد؛ پراکسی ویندوز فعال است.':'تونل برقرار شد؛ فقط پراکسی محلی فعال است.');
    } catch(e) {
      setShiro('error',e.message||'فعال‌سازی پراکسی انجام نشد.');
      proc.kill();
    } finally {connectingProxy=false;}
  }
}
async function startShiro(check=()=>{}){
  if(anyConfigActive()||configProbe?.snapshot().running)throw new Error('اول اتصال یا آزمون کانفیگ را قطع کن.');
  if (psiphonProcess) throw new Error('موتور شیر و خورشید در حال اجراست.');
  const ls=await refreshLantern(true,2500);check();
  if (['connected','connecting','restarting'].includes(ls.state)) throw new Error('اول اتصال لنترن را قطع کن، بعد موتور را عوض کن.');
  const core=path.join(binDir(),'psiphon-core.exe'), profile=path.join(binDir(),'psiphon-default.json'), list=path.join(binDir(),'server_list.dat');
  for(const f of [core,profile,list]) { try{await fs.access(f);}catch{throw new Error('فایل موتور یا پروفایل سایفون پیدا نشد؛ نصب را دوباره انجام بده.');} }
  const work=path.join(dataDir(),'psiphon'); await fs.mkdir(work,{recursive:true});
  const base=JSON.parse(await fs.readFile(profile,'utf8'));
  // 0 lets the core choose available local-only ports and report them in its notices.
  const config=psiphonConfig(base,settings,0,0,work);
  const cfgFile=path.join(work,'config.json');
  await fs.writeFile(cfgFile,JSON.stringify(config),{mode:0o600});check();
  setShiro('connecting','در حال پیدا کردن مسیر اتصال…',{httpPort:0,socksPort:0});
  stopping=false;
  const child=spawn(core,['-config',cfgFile,'-serverList',list],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  psiphonProcess=child;
  readline.createInterface({input:child.stderr}).on('line',line=>{
    if(line.length>100_000) return;
    try {void onNotice(child,JSON.parse(line));} catch {}
  });
  child.once('error',()=>{if(child===psiphonProcess){psiphonProcess=null; setShiro('error','اجرای موتور سایفون ممکن نشد.');}});
  child.once('exit',async()=>{
    if(child!==psiphonProcess) return;
    psiphonProcess=null;
    const wasStopping=stopping; stopping=false;
    try {await proxy.restore();} catch {setShiro('error','بازگرداندن پراکسی ویندوز ناموفق بود؛ تنظیمات پراکسی ویندوز را بررسی کن.'); return;}
    if (wasStopping) setShiro('disconnected','اتصال قطع شد.',{httpPort:0,socksPort:0});
    else if(shiroState.state!=='error') setShiro('error','موتور متوقف شد؛ اتصال برقرار نشد.',{httpPort:0,socksPort:0});
  });
  return snapshot();
}
async function stopShiro(){
  const child=psiphonProcess;
  if (!child) { await proxy.restore(); setShiro('disconnected','اتصال قطع است.',{httpPort:0,socksPort:0}); return; }
  stopping=true; setShiro('disconnecting','در حال قطع اتصال…');
  await new Promise(resolve=>{
    let settled=false; const done=()=>{if(!settled){settled=true;resolve();}};
    child.once('exit',done); child.once('error',done);
    try{child.kill();}catch{done();}
    setTimeout(done,4000).unref();
  });
  if (psiphonProcess===child) { psiphonProcess=null; try{child.kill('SIGKILL');}catch{} }
  await proxy.restore();
  stopping=false; setShiro('disconnected','اتصال قطع شد.',{httpPort:0,socksPort:0});
}
async function startLantern(check=()=>{}){
  if(anyConfigActive()||configProbe?.snapshot().running)throw new Error('اول اتصال یا آزمون کانفیگ را قطع کن.');
  if (psiphonProcess) throw new Error('اول اتصال شیر و خورشید را قطع کن.');
  if (lanternConnectJob || lanternStopping) throw new Error('لنترن در حال تغییر وضعیت است.');
  const ls=await refreshLantern(true);check();
  if(ls.state==='unavailable') throw new Error(ls.detail);
  if(ls.state==='connected') return snapshot();
  if(ls.state!=='disconnected' && ls.state!=='error') throw new Error('سرویس لنترن در حال تغییر وضعیت است؛ کمی صبر کن.');
  const tag=settings.lanternTag;
  if(tag && !(await lantern.servers()).some(server=>server.tag===tag)) throw new Error('این سرور دیگر در دسترس نیست؛ دوباره کشور را انتخاب کن.');
  check();const generation=++lanternGeneration;
  const controller=new AbortController(); lanternController=controller;
  lanternState={state:'connecting',detail:'لنترن در حال اتصال است…'};
  lanternStartedByUs=true;
  // The service may take a long time to initialize. Do not block the WebView;
  // aborting this request and disconnecting allows the user to cancel it.
  const job=lantern.connect(tag,{signal:controller.signal}).then(async()=>{
    if(generation===lanternGeneration) await refreshLantern(true);
  }).catch(error=>{
    if(generation===lanternGeneration) {
      lanternStartedByUs=false;
      lanternState={state:'error',detail:error.message||'اتصال لنترن برقرار نشد.'};
      lastLanternCheck=Date.now();
    }
  }).finally(()=>{
    if(lanternConnectJob===job){lanternConnectJob=null;lanternController=null;}
  });
  lanternConnectJob=job;
  return snapshot();
}
async function stopLantern(){
  if(lanternStopping) return snapshot();
  lanternStopping=true; ++lanternGeneration;
  lanternState={state:'disconnecting',detail:'در حال قطع اتصال لنترن…'};
  if(lanternController) lanternController.abort();
  try {
    // The service serializes disconnect behind any in-progress bring-up.
    await lantern.disconnect(); lanternStartedByUs=false;
    lanternConnectJob=null; lanternController=null;
    await refreshLantern(true);
  } catch(error) {
    lanternState={state:'error',detail:error.message||'قطع اتصال لنترن انجام نشد.'};
    lastLanternCheck=Date.now(); throw error;
  } finally {lanternStopping=false;}
  return snapshot();
}

async function invoke(method,data){
  switch(method){
    case 'snapshot': return snapshot();
    case 'openFeed': if(!feedFeature)throw new Error('TheFeed هنوز آماده نیست.'); return feedFeature.show(data?.bounds);
    case 'hideFeed': return feedFeature?.hide() ?? true;
    case 'feedPosition': feedFeature?.position(data?.bounds); return true;
    case 'retryFeed': if(!feedFeature)throw new Error('TheFeed هنوز آماده نیست.'); await feedFeature.retry();return true;
    case 'configsList': return configSources.snapshot();
    case 'configsRefresh': {if(configProbe?.snapshot().running)throw new Error('ابتدا پینگ در حال اجرا را متوقف کن.');return configSources.refresh();}
    case 'configsTest': return connectionGuard.run(async check=>{
      if(anyConfigActive()||psiphonProcess||lanternConnectJob||lanternStopping||configProbe.snapshot().running)throw new Error('ابتدا اتصال یا آزمون فعلی را قطع کن.');
      const ls=await refreshLantern(true,2500);check();if(['connected','connecting','restarting','disconnecting'].includes(ls.state))throw new Error('اول اتصال لنترن را قطع کن.');
      if(anyConfigActive()||psiphonProcess||lanternConnectJob||lanternStopping||configProbe.snapshot().running)throw new Error('ابتدا اتصال یا آزمون فعلی را قطع کن.');
      const ids=data?.all?configSources.snapshot().items.map(c=>c.id):[data?.id];return configProbe.start(ids);
    });
    case 'configsTestStop': await configProbe.stop();return configProbe.snapshot();
    case 'configsConnect': return connectionGuard.run(async check=>{
      if(anyConfigActive()||configProbe.snapshot().running)throw new Error('ابتدا اتصال یا آزمون کانفیگ فعلی را قطع کن.');
      if(psiphonProcess||lanternConnectJob||lanternStopping)throw new Error('اول اتصال موتور فعلی را قطع کن.');
      const ls=await refreshLantern(true,2500);check();if(['connected','connecting','restarting','disconnecting'].includes(ls.state))throw new Error('اول اتصال لنترن را قطع کن.');
      if(typeof data?.id!=='string'||!/^([a-f0-9]{24})$/.test(data.id))throw new Error('کانفیگ معتبر انتخاب نشده است.');
      const c=configSources.get(data.id);if(!c)throw new Error('این کانفیگ دیگر در فهرست نیست.');
      const mode=data?.mode||'direct';if(mode!=='direct'&&!MODES.has(mode))throw new Error('حالت اتصال نامعتبر است.');
      let detail='گردانندهٔ سرور می‌تواند IP و ترافیک بدون HTTPS را ببیند. همهٔ برنامه‌ها از پراکسی ویندوز پیروی نمی‌کنند و Kill Switch وجود ندارد.';
      if(c.tls.insecure)detail+='\n\nهشدار: گواهی TLS همچنان بررسی می‌شود و این کانفیگ ممکن است برقرار نشود.';
      if(c.transport.security==='none')detail+='\n\nهشدار: این کانفیگ امنیت لایهٔ انتقال TLS ندارد.';
      if(settings.routingPreset!=='global'||settings.routingCustom)detail+='\n\nقوانین مسیریابی ممکن است بعضی ترافیک‌ها را مستقیم و خارج از پراکسی بفرستند.';
      const answer=await dialog.showMessageBox(mainWindow,{type:'warning',title:'اتصال به سرور کانفیگ',message:'به این سرور وصل می‌شوی؟',detail,buttons:['انصراف','اتصال'],defaultId:0,cancelId:0,noLink:true});check();
      if(answer.response!==1)return snapshot();
      if(psiphonProcess||lanternConnectJob||lanternStopping||anyConfigActive()||configProbe.snapshot().running)throw new Error('یک اتصال دیگر فعال شده است؛ ابتدا آن را قطع کن.');
      const latest=await refreshLantern(true,2500);check();if(['connected','connecting','restarting','disconnecting'].includes(latest.state))throw new Error('اول اتصال لنترن را قطع کن.');
      const routing=buildRouting({preset:settings.routingPreset,custom:settings.routingCustom});
      configKind=mode==='direct'?'direct':'chain';
      if(mode==='direct')void configEngine.start(c,{systemProxy:settings.systemProxy,routing}).catch(()=>{});
      else chainEngine.start(c,{mode,settings:{...settings},systemProxy:settings.systemProxy,routing});
      return snapshot();
    });
    case 'configsDisconnect': connectionGuard.cancel();if(configKind==='chain')await chainEngine.stop();else await configEngine.stop();return snapshot();
    case 'checkAppUpdate': return appUpdates.check();
    case 'installAppUpdate': if(!appUpdates.install())throw new Error('به‌روزرسانی آمادهٔ نصب نیست.');return true;
    case 'selectEngine': {
      if(connectionGuard.busy)throw new Error('ابتدا درخواست اتصال را کامل یا لغو کن.');
      if (!['shiro','lantern'].includes(data?.engine)) throw new Error('موتور نامعتبر است.');
      if(anyConfigActive()||configProbe?.snapshot().running)throw new Error('برای تغییر موتور، اول اتصال یا آزمون کانفیگ را قطع کن.');
      if(psiphonProcess && data.engine!=='shiro') throw new Error('برای تغییر موتور، اول اتصال شیر و خورشید را قطع کن.');
      if(settings.engine==='lantern' && data.engine!=='lantern') { if(lanternConnectJob || lanternStopping) throw new Error('ابتدا اتصال لنترن را قطع کن.'); const ls=await refreshLantern(true); if(['connected','connecting','restarting'].includes(ls.state)) throw new Error('برای تغییر موتور، اول لنترن را قطع کن.'); }
      settings=cleanSettings({...settings,engine:data.engine}); await save(); return snapshot();
    }
    case 'saveSettings': {
      if(connectionGuard.busy||psiphonProcess||anyConfigActive()||configProbe?.snapshot().running) throw new Error('برای تغییر تنظیمات، اول اتصال یا آزمون فعال را قطع کن.');
      const next=cleanSettings({...settings,...data,engine:settings.engine});
      app.setLoginItemSettings({openAtLogin:next.autoStart}); settings=next; await save(); return snapshot();
    }
    case 'connect': return connectionGuard.run(check=>settings.engine==='shiro' ? startShiro(check) : startLantern(check));
    case 'disconnect': connectionGuard.cancel();return settings.engine==='shiro' ? (await stopShiro(),snapshot()) : stopLantern();
    case 'servers': return lantern.servers();
    case 'selectServer': {
      if(connectionGuard.busy)throw new Error('ابتدا درخواست اتصال را کامل یا لغو کن.');
      if(typeof data?.tag!=='string' || data.tag.length>256 || /[\x00-\x1f]/.test(data.tag)) throw new Error('سرور نامعتبر است.');
      const s=await refreshLantern(true); if (lanternConnectJob || lanternStopping || !['disconnected','error'].includes(s.state)) throw new Error('برای انتخاب سرور، ابتدا لنترن را قطع کن.');
      if(data.tag && !(await lantern.servers()).some(server=>server.tag===data.tag)) throw new Error('این سرور لنترن دیگر در دسترس نیست.');
      settings=cleanSettings({...settings,lanternTag:data.tag}); await save(); return snapshot();
    }
    case 'openLink': {const url=LINKS[data?.key]; if(!url)throw new Error('پیوند نامعتبر است.'); await shell.openExternal(url); return true;}
    default: throw new Error('عملیات نامعتبر است.');
  }
}
app.setName('LML VPN');
// Development-only isolation for automated desktop tests; never used in a packaged build.
if(!app.isPackaged && process.platform!=='win32' && process.env.LML_FEED_TEST_USER_DATA) app.setPath('userData',process.env.LML_FEED_TEST_USER_DATA);
const locked=app.requestSingleInstanceLock();
if(!locked) app.quit();
app.on('second-instance',()=>{ if(mainWindow){if(mainWindow.isMinimized())mainWindow.restore();mainWindow.focus();} });
app.whenReady().then(async()=>{
  await fs.mkdir(dataDir(),{recursive:true}); proxy=new ProxyManager(path.join(dataDir(),'proxy-backup.json'));
  lantern.configureHelper(path.join(binDir(),'lantern-ipc.exe'));
  try{await proxy.restore();}catch{setShiro('error','بازگرداندن پراکسی قبلی ممکن نشد؛ تنظیمات ویندوز را بررسی کن.');}
  await load();
  mainWindow=new BrowserWindow({width:1240,height:820,minWidth:920,minHeight:650,backgroundColor:'#080d15',frame:false,show:false,icon:path.join(__dirname,'resources','icon.ico'),
    webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  const send=(channel,value)=>{if(mainWindow&&!mainWindow.isDestroyed()&&!mainWindow.webContents.isDestroyed())mainWindow.webContents.send(channel,value);};
  feedFeature=createFeedFeature({app,WebContentsView,session,shell,dialog,binDir,getMainWindow:()=>mainWindow});
  configSources=new ConfigSources({app,binDir,sharedController:feedFeature.getController(),onChange:value=>send('configs:updated',value)});await configSources.load();
  const devXray=!app.isPackaged && process.platform!=='win32' && process.env.LML_XRAY_DEV_BIN;
  const devPsiphon=!app.isPackaged && process.platform!=='win32' && process.env.LML_PSIPHON_DEV_BIN;
  configEngine=new ConfigEngine({binDir:binDir(),dataDir:dataDir(),proxy,devBinary:devXray||null,onChange:value=>chainEngine?.onXrayState(value)});await configEngine.cleanup();
  const hop=new PsiphonHop({binDir:binDir(),dataDir:dataDir(),devBinary:devPsiphon||null});
  chainEngine=new ChainEngine({xray:configEngine,hop,proxy});
  configProbe=new ConfigProbe({binDir:binDir(),dataDir:dataDir(),sources:configSources,devBinary:devXray||null,onChange:value=>send('configs:progress',value)});
  appUpdates=createAppUpdater({app,autoUpdater:require('electron-updater').autoUpdater,onChange:value=>send('app:update',value)});
  mainWindow.on('closed',()=>{mainWindow=null;app.quit();});
  mainWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  mainWindow.webContents.on('will-navigate',(e)=>e.preventDefault());
  mainWindow.once('ready-to-show',()=>mainWindow.show());
  await mainWindow.loadFile(path.join(__dirname,'app','index.html'));
});
ipcMain.handle('lml:invoke',async(event,method,data)=>{
  if (!mainWindow || event.sender!==mainWindow.webContents || typeof method!=='string') throw new Error('دسترسی مجاز نیست.');
  return invoke(method,data);
});
ipcMain.on('lml:window',(event,action)=>{
  if(!mainWindow || event.sender!==mainWindow.webContents)return;
  if(action==='minimize')mainWindow.minimize();
  if(action==='maximize'){if(mainWindow.isMaximized())mainWindow.unmaximize();else mainWindow.maximize();}
  if(action==='close')mainWindow.close();
});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',event=>{
  if(quitting)return; event.preventDefault(); quitting=true;connectionGuard.cancel();
  (async()=>{
    appUpdates?.stop();
    try{await configProbe?.stop();}catch{}
    try{await chainEngine?.stop();}catch{}
    try{await configEngine?.stop();}catch{}
    try{await configSources?.stop();}catch{}
    try{await feedFeature?.stop();}catch{}
    try{await stopShiro();}catch{}
    if(lanternStartedByUs){try{await stopLantern();}catch{}}
  })().finally(()=>app.quit());
});
