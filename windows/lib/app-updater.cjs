'use strict';
// Full-application updates, separate from TheFeed's core updates. Only stable
// GitHub releases newer than the installed version are considered. The updater
// verifies the SHA-512 in electron-builder's latest.yml before installation.
function createAppUpdater({app,autoUpdater,onChange=()=>{},interval=4*60*60*1000,platform=process.platform}){
  let state={state:'idle',detail:'بررسی خودکار به‌روزرسانی برنامه فعال است.',version:''},timer=null,first=null;
  const set=(value,detail,version=state.version)=>{state={state:value,detail,version};onChange({...state});};
  const enabled=app.isPackaged && platform==='win32';
  if(!enabled){state={state:'disabled',detail:'بررسی خودکار فقط در نسخهٔ نصب‌شدهٔ ویندوز فعال است.',version:''};return {snapshot:()=>({...state}),check:async()=>({...state}),install:()=>false,stop:()=>{}};}
  autoUpdater.setFeedURL({provider:'github',owner:'nukesamp-crypto',repo:'LML-VPN',releaseType:'release'});
  autoUpdater.autoDownload=true;autoUpdater.autoInstallOnAppQuit=true;autoUpdater.allowDowngrade=false;autoUpdater.allowPrerelease=false;autoUpdater.autoRunAppAfterInstall=true;
  autoUpdater.on('checking-for-update',()=>set('checking','در حال بررسی نسخهٔ جدید برنامه…'));
  autoUpdater.on('update-not-available',()=>set('current','نسخهٔ جدیدتری برای برنامه پیدا نشد.'));
  autoUpdater.on('update-available',info=>set('downloading','نسخهٔ جدید برنامه در حال دریافت است.',String(info?.version||'')));
  autoUpdater.on('download-progress',p=>set('downloading',`دریافت به‌روزرسانی: ${Math.max(0,Math.min(100,Math.round(p?.percent||0))).toLocaleString('fa-IR')}٪`));
  autoUpdater.on('update-downloaded',info=>set('ready','به‌روزرسانی آماده است؛ هنگام بستن برنامه نصب می‌شود یا می‌توانی اکنون نصب کنی.',String(info?.version||'')));
  autoUpdater.on('error',()=>set('error','بررسی یا دریافت به‌روزرسانی ممکن نشد؛ بعداً دوباره تلاش می‌شود.'));
  async function check(){try{await autoUpdater.checkForUpdates();}catch{set('error','بررسی یا دریافت به‌روزرسانی ممکن نشد؛ اتصال به GitHub را بررسی کن.');}return {...state};}
  first=setTimeout(()=>void check(),8000);first.unref?.();timer=setInterval(()=>void check(),interval);timer.unref?.();
  return {snapshot:()=>({...state}),check,install:()=>{if(state.state!=='ready')return false;autoUpdater.quitAndInstall(false,true);return true;},stop:()=>{clearTimeout(first);clearInterval(timer);}};
}
module.exports={createAppUpdater};
