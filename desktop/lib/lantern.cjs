'use strict';
// The bundled Radiance service speaks HTTP/2 prior-knowledge over a named
// pipe. On Windows the helper verifies the service process and uses the
// restricted impersonation level; Unix sockets are used only in tests.
const http2 = require('node:http2');
const net = require('node:net');
const {spawn} = require('node:child_process');
let helperPath = '';
function configureHelper(path){ helperPath=path; }
const PIPE = '\\\\.\\pipe\\LMLVPN\\lantern';
const allowed = new Set(['/vpn/status','/vpn/connect','/vpn/disconnect','/server/selected','/servers']);
function request(method, endpoint, body, options = {}) {
  if (!allowed.has(endpoint) || !['GET','POST'].includes(method)) return Promise.reject(new Error('درخواست نامعتبر است.'));
  if (options.signal?.aborted) return Promise.reject(new Error('درخواست اتصال لغو شد.'));
  if (process.platform==='win32' && !options.socketPath) return helperRequest(method,endpoint,body,options);
  return new Promise((resolve,reject)=>{
    let done=false, output='', responseStatus=0;
    const finish=(error,value)=>{
      if(done)return; done=true; clearTimeout(timer); options.signal?.removeEventListener('abort',abort);
      client.close(); if(error)reject(error); else resolve(value);
    };
    const abort=()=>{ stream.close(); finish(new Error('درخواست اتصال لغو شد.')); };
    const client=http2.connect('http://lantern',{createConnection:()=>net.connect(options.socketPath || PIPE)});
    const timer=setTimeout(()=>{client.destroy();finish(new Error('زمان پاسخ لنترن تمام شد.'));},options.timeout||5000);
    client.on('error',()=>finish(new Error('سرویس لنترن در دسترس نیست.')));
    const serialized=body==null?null:JSON.stringify(body);
    const headers={':method':method,':path':endpoint};
    if(serialized!==null) headers['content-type']='application/json';
    const stream=client.request(headers);
    options.signal?.addEventListener('abort',abort,{once:true});
    stream.on('response',headers=>{responseStatus=Number(headers[':status']);});
    stream.setEncoding('utf8');
    stream.on('data',chunk=>{output+=chunk;if(output.length>4_000_000){stream.close();finish(new Error('پاسخ لنترن بیش از حد بزرگ است.'));}});
    stream.on('error',()=>finish(new Error('سرویس لنترن در دسترس نیست.')));
    stream.on('end',()=>{
      if(responseStatus>=400)return finish(new Error(`لنترن درخواست را نپذیرفت (${responseStatus}).`));
      if(!output.trim())return finish(null,null);
      try{finish(null,JSON.parse(output));}catch{finish(new Error('پاسخ لنترن نامعتبر بود.'));}
    });
    stream.end(serialized||undefined);
  });
}
function helperRequest(method, endpoint, body, options={}) {
  return new Promise((resolve,reject)=>{
    if(!helperPath) return reject(new Error('ابزار کنترل لنترن پیدا نشد.'));
    let child;
    try{child=spawn(helperPath,[],{windowsHide:true,stdio:['pipe','pipe','ignore']});}
    catch{return reject(new Error('ابزار کنترل لنترن اجرا نشد.'));}
    let output='',done=false;
    const abort=()=>{child.kill();finish(new Error('درخواست اتصال لغو شد.'));};
    const finish=(err,val)=>{if(done)return;done=true;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);if(err)reject(err);else resolve(val);};
    const timer=setTimeout(()=>{child.kill();finish(new Error('زمان پاسخ لنترن تمام شد.'));},options.timeout || (endpoint==='/vpn/connect'?65000:18000));
    options.signal?.addEventListener('abort',abort,{once:true});
    if(options.signal?.aborted) return abort();
    child.on('error',()=>finish(new Error('ابزار کنترل لنترن اجرا نشد.')));
    child.stdout.setEncoding('utf8');child.stdout.on('data',s=>{output+=s;if(output.length>4_100_000){child.kill();finish(new Error('پاسخ لنترن بیش از حد بزرگ است.'));}});
    child.on('close',()=>{
      try{const r=JSON.parse(output);if(r.ok)return finish(null,r.data??null);
        return finish(new Error(r.code?`لنترن درخواست را نپذیرفت (${r.code}).`:'سرویس لنترن در دسترس نیست یا تأیید نشد؛ نصب برنامه را بررسی کن.'));
      }catch{return finish(new Error('سرویس لنترن در دسترس نیست. نصب برنامه را بررسی کن.'));}
    });
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({method,path:endpoint,body}));
  });
}
function cleanServers(entries) {
  if (!Array.isArray(entries)) return [];
  // Apply the limit after filtering: a long preceding non-Lantern list must
  // not hide all genuine Lantern locations.
  return entries.filter(s=>s && s.isLantern===true && typeof s.tag==='string' && s.tag.length<=256 && !/[\x00-\x1f]/.test(s.tag)).slice(0,500).map(s=>{
    const loc=s.location && typeof s.location==='object'?s.location:{};
    const rawCode=loc.country_code || loc.countryCode || '';
    const code=typeof rawCode==='string' && /^[A-Za-z]{2}$/.test(rawCode)?rawCode.toUpperCase():'';
    return {tag:s.tag,city:typeof loc.city==='string'?loc.city.slice(0,80):'',
      country:typeof loc.country==='string'?loc.country.slice(0,80):'',countryCode:code};
  });
}
async function status(options){const s=await request('GET','/vpn/status',null,options);return typeof s==='string'?s:'unknown';}
async function servers(options){return cleanServers(await request('GET','/servers',null,options));}
async function connect(tag,options){return request('POST','/vpn/connect',{tag:tag||''},options);}
async function disconnect(options){return request('POST','/vpn/disconnect',null,options);}
module.exports={PIPE,request,status,servers,cleanServers,connect,disconnect,configureHelper,helperRequest};
