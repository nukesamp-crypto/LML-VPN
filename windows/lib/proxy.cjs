'use strict';
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const fs = require('node:fs/promises');
const run = promisify(execFile);
const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const PROXY_KEYS = ['ProxyEnable','ProxyServer'];
async function query(name) {
  try {
    const {stdout} = await run('reg.exe',['query',KEY,'/v',name],{windowsHide:true,timeout:8000});
    const line = stdout.split(/\r?\n/).find(x => new RegExp(`^\\s*${name}\\s+REG_`).test(x));
    if (!line) return {exists:false};
    const m = line.match(/^\s*\S+\s+(REG_\w+)\s*(.*)$/);
    return m ? {exists:true,type:m[1],value:m[2].trim()} : {exists:false};
  } catch (err) {
    // reg exits 1 when the value does not exist. Other errors must not be treated as success.
    if (err && (err.code===1 || err.code==='1')) return {exists:false};
    throw new Error('خواندن تنظیمات پراکسی ویندوز ممکن نشد.');
  }
}
async function write(name, entry) {
  if (!PROXY_KEYS.includes(name)) throw new Error('Invalid proxy setting');
  if (!entry.exists) {
    try { await run('reg.exe',['delete',KEY,'/v',name,'/f'],{windowsHide:true,timeout:8000}); }
    catch (e) { if (e.code!==1) throw e; }
    return;
  }
  const type = entry.type === 'REG_DWORD' ? 'REG_DWORD' : 'REG_SZ';
  await run('reg.exe',['add',KEY,'/v',name,'/t',type,'/d',String(entry.value),'/f'],{windowsHide:true,timeout:8000});
}
async function notify() {
  // Notify WinINet clients without running any user input in PowerShell.
  const command = `$s='[DllImport("wininet.dll")] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l);'; Add-Type -MemberDefinition $s -Name Native -Namespace LmlWinInet; [LmlWinInet.Native]::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0) | Out-Null; [LmlWinInet.Native]::InternetSetOption([IntPtr]::Zero,37,[IntPtr]::Zero,0) | Out-Null`;
  try { await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:12000}); } catch { /* Registry still changed; some apps may require refresh. */ }
}
function parseDword(v) { const n=String(v||'').trim(); return n.startsWith('0x') ? parseInt(n.slice(2),16) : parseInt(n,10); }
class ProxyManager {
  constructor(snapshotPath){ this.snapshotPath=snapshotPath; }
  async activate(port) {
    if (process.platform !== 'win32') throw new Error('تنظیم پراکسی خودکار فقط در ویندوز فعال است.');
    if (!Number.isInteger(port)||port<1||port>65535) throw new Error('پورت پراکسی معتبر نیست.');
    // On a reconnect the same port is still ours; do not temporarily restore
    // direct access between tunnel attempts.
    try {
      const old=JSON.parse(await fs.readFile(this.snapshotPath,'utf8'));
      const current=await query('ProxyServer'), enabled=await query('ProxyEnable');
      if(old.ours===`127.0.0.1:${port}` && current.value===old.ours && parseDword(enabled.value)===1) return;
    } catch {}
    // Recover any previous interrupted session before replacing its backup.
    await this.restore();
    const previous={}; for (const name of PROXY_KEYS) previous[name]=await query(name);
    const ours=`127.0.0.1:${port}`;
    const tmp=this.snapshotPath+'.tmp';
    await fs.writeFile(tmp,JSON.stringify({ours,previous}),{mode:0o600});
    await fs.rename(tmp,this.snapshotPath);
    try {
      await write('ProxyServer',{exists:true,type:'REG_SZ',value:ours});
      await write('ProxyEnable',{exists:true,type:'REG_DWORD',value:'1'});
      await notify();
    } catch(e) {
      try { for (const name of PROXY_KEYS) await write(name,previous[name]); await notify(); await fs.unlink(this.snapshotPath); } catch {}
      throw new Error('اعمال پراکسی ویندوز انجام نشد؛ اتصال متوقف می‌شود.');
    }
  }
  async restore() {
    if (process.platform !== 'win32') return;
    let snap; try { snap=JSON.parse(await fs.readFile(this.snapshotPath,'utf8')); } catch { return; }
    if (!snap || !/^127\.0\.0\.1:\d{1,5}$/.test(snap.ours||'') || !snap.previous) return;
    const current=await query('ProxyServer'), enabled=await query('ProxyEnable');
    // If another program or the user changed the proxy, leave it untouched.
    if (current.value===snap.ours && parseDword(enabled.value)===1) {
      for (const name of PROXY_KEYS) if (snap.previous[name] && typeof snap.previous[name].exists==='boolean') await write(name,snap.previous[name]);
      await notify();
    }
    await fs.unlink(this.snapshotPath).catch(()=>{});
  }
}
module.exports={ProxyManager,parseDword};
