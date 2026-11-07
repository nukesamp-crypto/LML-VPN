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
const {AutoProbe} = require('./lib/auto-probe.cjs');
const {buildRouting} = require('./lib/routing.cjs');
const {ConfigEngine,verifyThroughProxy} = require('./lib/config-engine.cjs');
const {performance} = require('node:perf_hooks');
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
  channel:'https://t.me/LML_panel',
  thefeedSource:'https://github.com/sartoopjj/thefeed',
  creditShiro:'https://github.com/shirokhorshid/psiphon-tunnel-core',
  creditPsiphon:'https://github.com/Psiphon-Labs/psiphon-tunnel-core',
  creditLantern:'https://github.com/getlantern/lantern',
  creditRadiance:'https://github.com/getlantern/radiance',
  creditWintun:'https://github.com/WireGuard/wintun',
  creditMehron:'https://github.com/CluvexStudio/MehrON/tree/4aae47b2ef089eb8750c91fd4a0186591d9fc85d',
  creditThefeed:'https://github.com/sartoopjj/thefeed',
  creditZedsecure:'https://github.com/CluvexStudio/ZedSecure-Cores',
  creditXrayfork:'https://github.com/CluvexStudio/Xray-core',
  creditXray:'https://github.com/XTLS/Xray-core',
  creditCronet:'https://github.com/SagerNet/cronet-go',
  creditNaive:'https://github.com/SagerNet/naiveproxy',
  creditChromium:'https://github.com/chromium/chromium',
  creditGeoip:'https://github.com/v2fly/geoip',
  creditGeosite:'https://github.com/v2fly/domain-list-community',
  creditFlags:'https://github.com/lipis/flag-icons',
  creditVazirmatn:'https://github.com/rastikerdar/vazirmatn',
  creditElectron:'https://github.com/electron/electron',
  creditNode:'https://github.com/nodejs/node',
  creditWinio:'https://github.com/microsoft/go-winio',
  creditGoSys:'https://github.com/golang/sys',
  creditGo:'https://github.com/golang/go',
  creditSingbox:'https://github.com/getlantern/sing-box-minimal'
});
let mainWindow, feedFeature, configSources, configEngine, chainEngine, configProbe, autoProbe, settings={...DEFAULTS}, proxy, psiphonProcess=null, stopping=false, quitting=false;
let scanStarting=false,scanStopping=false,scanStartJob=null,scanStopJob=null,notifyConfigs=()=>{};
const configView=(value=configSources?.snapshot()||{})=>({...value,scanRunning:!!(autoProbe?.enabled||scanStarting||scanStopping),scanStopping});
let configKind='direct';
const anyConfigActive=()=>!!(chainEngine?.active()||configEngine?.active());
let shiroState={state:'disconnected',detail:'آمادهٔ اتصال',httpPort:0,socksPort:0,regions:[],connectedAt:null,pingMs:null};
let lanternState={state:'unknown',detail:'وضعیت سرویس هنوز بررسی نشده است.'};
let lastLanternCheck=0, lanternStartedByUs=false, connectingProxy=false;
let lanternConnectJob=null, lanternController=null, lanternGeneration=0, lanternStopping=false;
const dataDir=()=>app.getPath('userData');
const settingsPath=()=>path.join(dataDir(),'settings.json');
const regionsPath=()=>path.join(dataDir(),'psiphon-regions.json');
const binDir=()=>app.isPackaged ? path.join(process.resourcesPath,'bin') : path.join(__dirname,'resources','bin');
const setShiro=(state,detail, extra={})=>{const connectedAt=state==='connected'?(shiroState.state==='connected'?shiroState.connectedAt:Date.now()):null;shiroState={...shiroState,state,detail,connectedAt,...extra};if(['error','disconnected'].includes(state))autoProbe?.schedule();};
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
  if (process.platform!=='win32') return lanternState={state:'unavailable',detail:'کنترل سرویس لنترن در این محیط ارائه نشده است.'};
  if (!force && Date.now()-lastLanternCheck < 2000) return lanternState;
  lastLanternCheck=Date.now();
  try {
    const s=await lantern.status(timeout ? {timeout} : undefined);
    const label={connected:'سرویس لنترن متصل است.',disconnected:'سرویس لنترن آماده است.',connecting:'لنترن در حال اتصال است.',disconnecting:'در حال قطع اتصال.',restarting:'در حال راه‌اندازی دوباره.',error:'سرویس لنترن خطا گزارش کرده است.'};
    lanternState={state:label[s]?s:'unknown',detail:label[s]||'وضعیت سرویس نامشخص است.',connectedAt:s==='connected'?(lanternState.state==='connected'?lanternState.connectedAt:Date.now()):null};
  } catch { lanternState={state:'unavailable',detail:'سرویس داخلی لنترن در دسترس نیست؛ نصب LML VPN را بررسی کن.'}; }
  return lanternState;
}
async function snapshot(){
  if (settings.engine==='lantern' && !lanternConnectJob && !lanternStopping) await refreshLantern(false,2500);
  return {platform:'windows', settings:{...settings}, shiro:{...shiroState}, lantern:{...lanternState}, configConnection:(configKind==='direct'?configEngine:chainEngine)?.snapshot(), configProbe:configProbe?.snapshot(), version:app.getVersion()};
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
      setShiro('connected',settings.systemProxy?'تونل برقرار شد؛ پراکسی سیستم فعال است.':'تونل برقرار شد؛ فقط پراکسی محلی فعال است.',{pingMs:null});
      const started=performance.now(),port=shiroState.httpPort;
      void verifyThroughProxy(port).then(ok=>{if(proc===psiphonProcess&&shiroState.state==='connected'&&shiroState.httpPort===port)setShiro('connected',shiroState.detail,{pingMs:ok?Math.max(1,Math.round(performance.now()-started)):-1});});
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
  setShiro('connecting','در حال پیدا کردن مسیر اتصال…',{httpPort:0,socksPort:0,pingMs:null});
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
    try {await proxy.restore();} catch {setShiro('error','بازگرداندن پراکسی سیستم ناموفق بود؛ تنظیمات پراکسی سیستم را بررسی کن.'); return;}
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
    case 'configsList': return configView();
    case 'configsRefresh': {
      // One explicit user action starts both acquisition and live HTTPS tests.
      // No source fetch or probe starts merely by opening the page.
      if(scanStarting||scanStopping||autoProbe.enabled||configSources.busy||configProbe.job||connectionGuard.busy)throw new Error('جست‌وجو، آزمون یا اتصال دیگری در حال انجام است.');
      scanStarting=true;notifyConfigs();
      try{
        const job=connectionGuard.run(async check=>{
          if(anyConfigActive()||psiphonProcess||lanternConnectJob||lanternStopping)throw new Error('برای تست با اینترنت فعلی، ابتدا اتصال LML را قطع کن.');
          await autoProbe.pause();check();
          const ls=await refreshLantern(true,2500);check();
          if(['connected','connecting','restarting','disconnecting'].includes(ls.state)||anyConfigActive()||psiphonProcess||lanternConnectJob||lanternStopping)throw new Error('برای تست با اینترنت فعلی، ابتدا اتصال LML را قطع کن.');
          autoProbe.enable();
          const fetching=configSources.refresh();
          fetching.catch(()=>{configSources.note='دریافت برخی منابع ناموفق بود؛ نتیجه‌های موفق تا این لحظه حفظ شدند.';configSources.emit();});
          autoProbe.resume();return true;
        });
        scanStartJob=job;await job;return configView();
      }finally{scanStarting=false;scanStartJob=null;autoProbe.resume();notifyConfigs();}
    }
    case 'configsTest': return connectionGuard.run(async check=>{
      try{
        if(anyConfigActive()||psiphonProcess||lanternConnectJob||lanternStopping)throw new Error('ابتدا اتصال فعلی را قطع کن.');
        await autoProbe.pause();check();
        const ls=await refreshLantern(true,2500);check();if(['connected','connecting','restarting','disconnecting'].includes(ls.state))throw new Error('اول اتصال لنترن را قطع کن.');
        if(anyConfigActive()||psiphonProcess||lanternConnectJob||lanternStopping)throw new Error('ابتدا اتصال فعلی را قطع کن.');
        const ids=data?.all?configSources.snapshot().items.map(c=>c.id):[data?.id];return configProbe.start(ids.filter(id=>configSources.getUsable(id)));
      }finally{autoProbe.resume();}
    });
    case 'configsTestStop': {
      if(!scanStopJob){
        scanStopping=true;if(scanStarting)connectionGuard.cancel();notifyConfigs();
        const starting=scanStartJob;
        const job=(async()=>{
          // Cancel source downloads, the isolated DNS feed, and all Xray/HTTPS probes.
          await Promise.all([autoProbe.disable(),configSources.cancelRefresh()]);
          if(starting)await starting.catch(()=>{});
        })();scanStopJob=job;
        job.then(()=>{if(scanStopJob===job){scanStopJob=null;scanStopping=false;notifyConfigs();}},()=>{if(scanStopJob===job){scanStopJob=null;scanStopping=false;notifyConfigs();}});
      }
      await scanStopJob;return {...configProbe.snapshot(),configs:configView()};
    }
    case 'configsRemove': return {removed:await configSources.remove(data?.id),...configView()};
    case 'configsRemoveFailed': return {removed:await configSources.removeFailed(),...configView()};
    case 'configsRestore': await configSources.restoreRemoved();return configView();
    case 'configsConnect': return connectionGuard.run(async check=>{
      try{
        // Connecting takes precedence over the background scan; interrupted
        // candidates stay pending and resume after the connection ends.
        await autoProbe.pause();check();
        if(anyConfigActive())throw new Error('ابتدا اتصال کانفیگ فعلی را قطع کن.');
        if(psiphonProcess||lanternConnectJob||lanternStopping)throw new Error('اول اتصال موتور فعلی را قطع کن.');
        const ls=await refreshLantern(true,2500);check();if(['connected','connecting','restarting','disconnecting'].includes(ls.state))throw new Error('اول اتصال لنترن را قطع کن.');
        if(typeof data?.id!=='string'||!/^([a-f0-9]{24})$/.test(data.id))throw new Error('کانفیگ معتبر انتخاب نشده است.');
        const c=configSources.getUsable(data.id);if(!c)throw new Error('این کانفیگ هنوز آزمون موفق ندارد یا دیگر در فهرست نیست.');
        const mode=data?.mode||'direct';if(mode!=='direct'&&!MODES.has(mode))throw new Error('حالت اتصال نامعتبر است.');
        const routing=buildRouting({preset:settings.routingPreset,custom:settings.routingCustom});
        configKind=mode==='direct'?'direct':'chain';
        if(mode==='direct')void configEngine.start(c,{systemProxy:settings.systemProxy,routing}).catch(()=>{});
        else chainEngine.start(c,{mode,settings:{...settings},systemProxy:settings.systemProxy,routing});
        return snapshot();
      }finally{autoProbe.resume();}
    });
    case 'configsDisconnect': connectionGuard.cancel();if(configKind==='chain')await chainEngine.stop();else await configEngine.stop();autoProbe.schedule();return snapshot();
    case 'selectEngine': {
      if(connectionGuard.busy)throw new Error('ابتدا درخواست اتصال را کامل یا لغو کن.');
      if (!['shiro','lantern'].includes(data?.engine)) throw new Error('موتور نامعتبر است.');
      if(anyConfigActive())throw new Error('برای تغییر موتور، اول اتصال کانفیگ را قطع کن.');
      if(psiphonProcess && data.engine!=='shiro') throw new Error('برای تغییر موتور، اول اتصال شیر و خورشید را قطع کن.');
      if(settings.engine==='lantern' && data.engine!=='lantern') { if(lanternConnectJob || lanternStopping) throw new Error('ابتدا اتصال لنترن را قطع کن.'); const ls=await refreshLantern(true); if(['connected','connecting','restarting'].includes(ls.state)) throw new Error('برای تغییر موتور، اول لنترن را قطع کن.'); }
      settings=cleanSettings({...settings,engine:data.engine}); await save(); return snapshot();
    }
    case 'saveSettings': {
      if(connectionGuard.busy||psiphonProcess||anyConfigActive()) throw new Error('برای تغییر تنظیمات، اول اتصال فعال را قطع کن.');
      const next=cleanSettings({...settings,...data,engine:settings.engine});
      app.setLoginItemSettings({openAtLogin:next.autoStart}); settings=next; await save(); return snapshot();
    }
    case 'connect': return connectionGuard.run(async check=>{
      try{await autoProbe.pause();check();return await (settings.engine==='shiro' ? startShiro(check) : startLantern(check));}
      finally{autoProbe.resume();}
    });
    case 'disconnect': connectionGuard.cancel();{const result=settings.engine==='shiro' ? (await stopShiro(),await snapshot()) : await stopLantern();autoProbe.schedule();return result;}
    case 'servers': return lantern.servers();
    case 'selectServer': {
      if(connectionGuard.busy)throw new Error('ابتدا درخواست اتصال را کامل یا لغو کن.');
      if(typeof data?.tag!=='string' || data.tag.length>256 || /[\x00-\x1f]/.test(data.tag)) throw new Error('سرور نامعتبر است.');
      const s=await refreshLantern(true); if (lanternConnectJob || lanternStopping || !['disconnected','error'].includes(s.state)) throw new Error('برای انتخاب سرور، ابتدا لنترن را قطع کن.');
      if(data.tag && !(await lantern.servers()).some(server=>server.tag===data.tag)) throw new Error('این سرور لنترن دیگر در دسترس نیست.');
      settings=cleanSettings({...settings,lanternTag:data.tag}); await save(); return snapshot();
    }
    case 'openNotices': {
      const file=app.isPackaged?path.join(process.resourcesPath,'licenses','THIRD-PARTY-NOTICES.md'):path.join(__dirname,'resources','licenses','THIRD-PARTY-NOTICES.md');
      const problem=await shell.openPath(file);if(problem)throw new Error('باز کردن متن مجوزها ممکن نشد.');return true;
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
  try{await proxy.restore();}catch{setShiro('error','بازگرداندن پراکسی قبلی ممکن نشد؛ تنظیمات سیستم را بررسی کن.');}
  await load();
  mainWindow=new BrowserWindow({width:1240,height:820,minWidth:920,minHeight:650,backgroundColor:'#f8f7f3',frame:false,show:false,icon:path.join(__dirname,'resources','icon.ico'),
    webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  const send=(channel,value)=>{if(mainWindow&&!mainWindow.isDestroyed()&&!mainWindow.webContents.isDestroyed())mainWindow.webContents.send(channel,value);};
  feedFeature=createFeedFeature({app,WebContentsView,session,shell,dialog,binDir,getMainWindow:()=>mainWindow});
  // Limit renderer redraws while hundreds of probe results arrive.
  const queuedSend=(channel,delay=350)=>{let timer=null,last;return value=>{last=value;if(timer)return;timer=setTimeout(()=>{timer=null;send(channel,last);},delay);timer.unref?.();};};
  const sendConfigs=queuedSend('configs:updated'),sendProgress=queuedSend('configs:progress');
  notifyConfigs=()=>sendConfigs(configView());
  configSources=new ConfigSources({app,binDir,sharedController:feedFeature.getController(),onChange:value=>{sendConfigs(configView(value));autoProbe?.schedule();}});await configSources.load();
  const devXray=!app.isPackaged && process.platform!=='win32' && process.env.LML_XRAY_DEV_BIN;
  const devPsiphon=!app.isPackaged && process.platform!=='win32' && process.env.LML_PSIPHON_DEV_BIN;
  configEngine=new ConfigEngine({binDir:binDir(),dataDir:dataDir(),proxy,devBinary:devXray||null,onChange:value=>{chainEngine?.onXrayState(value);if(configKind==='direct'&&value.state==='connected'&&Number.isFinite(value.pingMs)&&value.id&&configSources.getUsable(value.id))configSources.setLatency(value.id,value.pingMs);if(['error','disconnected'].includes(value.state))autoProbe?.schedule();}});await configEngine.cleanup();
  const hop=new PsiphonHop({binDir:binDir(),dataDir:dataDir(),devBinary:devPsiphon||null});
  chainEngine=new ChainEngine({xray:configEngine,hop,proxy,onChange:value=>{if(['error','disconnected'].includes(value.state))autoProbe?.schedule();}});
  configProbe=new ConfigProbe({binDir:binDir(),dataDir:dataDir(),sources:configSources,devBinary:devXray||null,onChange:value=>{sendProgress(value);if(!value.running)autoProbe?.schedule();}});
  autoProbe=new AutoProbe({sources:configSources,probe:configProbe,canRun:()=>!quitting&&!connectionGuard.busy&&!anyConfigActive()&&!psiphonProcess&&!lanternConnectJob&&!lanternStopping&&!['connected','connecting','restarting','disconnecting'].includes(lanternState.state),canFinish:()=>!configSources.busy,onState:()=>notifyConfigs()});
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
    try{await autoProbe?.stop();}catch{}
    try{await configProbe?.stop();}catch{}
    try{await chainEngine?.stop();}catch{}
    try{await configEngine?.stop();}catch{}
    try{await configSources?.stop();}catch{}
    try{await feedFeature?.stop();}catch{}
    try{await stopShiro();}catch{}
    if(lanternStartedByUs){try{await stopLantern();}catch{}}
  })().finally(()=>app.quit());
});
