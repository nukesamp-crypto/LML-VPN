'use strict';
// Explicitly supported subset of share links. Never evaluate remote JSON or
// pass unknown options, executable paths or arbitrary outbound objects to Xray.
const crypto=require('node:crypto');
const net=require('node:net');
const MAX_LINK=8192;
// Public channel names are retained internally for source/flag metadata only.
const PUBLIC_CONFIG_NAME='LML VPN';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CIPHERS=new Set(['aes-128-gcm','aes-256-gcm','chacha20-poly1305','xchacha20-poly1305','2022-blake3-aes-128-gcm','2022-blake3-aes-256-gcm','2022-blake3-chacha20-poly1305','none','plain']);
const trimText=(x,n=300)=>String(x??'').replace(/[\x00-\x1f\x7f]/g,'').slice(0,n);
function decode(s){try{return decodeURIComponent(s);}catch{return s;}}
function base64(s){
  if(!/^[\w+\-/]*={0,2}$/.test(s)||s.length>7000)throw new Error('base64 نامعتبر است.');
  const result=Buffer.from(s.replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8');
  if(!result || result.includes('\ufffd'))throw new Error('base64 نامعتبر است.');return result;
}
function safeHost(host,allowLocal=false){
  host=String(host||'').replace(/^\[|\]$/g,'').trim();
  if(!host||host.length>253||/[\s/\\@?#\x00-\x1f]/.test(host))throw new Error('آدرس سرور نامعتبر است.');
  if(allowLocal)return host;
  const lower=host.toLowerCase(),ip=net.isIP(host);
  if(lower==='localhost'||lower.endsWith('.localhost')||lower.endsWith('.local')||lower.endsWith('.internal'))throw new Error('آدرس محلی مجاز نیست.');
  if(ip===4){
    const a=host.split('.').map(Number);
    if(a[0]===0||a[0]===10||a[0]===127||a[0]>=224||(a[0]===169&&a[1]===254)||(a[0]===172&&a[1]>=16&&a[1]<=31)||(a[0]===192&&a[1]===168)||(a[0]===100&&a[1]>=64&&a[1]<=127))throw new Error('آدرس خصوصی مجاز نیست.');
  }else if(ip===6){
    if(lower==='::'||lower==='::1'||lower.startsWith('fc')||lower.startsWith('fd')||/^fe[89ab]/.test(lower)||lower.startsWith('::ffff:'))throw new Error('آدرس خصوصی مجاز نیست.');
  }else if(!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host) || !host.includes('.'))throw new Error('نام سرور نامعتبر است.');
  return host;
}
function qv(q,...keys){for(const k of keys){const v=q.get(k);if(v!==null&&v!=='')return trimText(v,2048);}return '';}
function parseLink(raw,{allowLocal=false}={}){
  if(typeof raw!=='string'||raw.length>MAX_LINK)throw new Error('لینک بسیار طولانی یا نامعتبر است.');
  raw=raw.trim();if(/[\x00-\x20\x7f<>"'`]/.test(raw))throw new Error('لینک نویسهٔ نامعتبر دارد.');
  const scheme=raw.split('://')[0].toLowerCase();
  if(!['vless','vmess','trojan','ss'].includes(scheme))throw new Error('پروتکل پشتیبانی نمی‌شود.');
  let address,port,user,secret='',remark='',q=new URLSearchParams(),vm={};
  if(scheme==='vmess' && !raw.slice(8).includes('@')){
    const body=raw.slice(8).split('#')[0];
    try{vm=JSON.parse(base64(body));}catch{throw new Error('لینک VMess معتبر نیست.');}
    if(!vm||typeof vm!=='object'||Array.isArray(vm))throw new Error('لینک VMess معتبر نیست.');
    address=safeHost(vm.add,allowLocal);port=Number(vm.port||443);user=String(vm.id||'');remark=trimText(vm.ps||decode(raw.split('#')[1]||''));
    for(const [k,v] of Object.entries(vm))if(typeof v==='string'||typeof v==='number')q.set(k,String(v));
  }else if(scheme==='ss'){
    let rest=raw.slice(5),fragment='';const hi=rest.indexOf('#');
    if(hi>=0){fragment=rest.slice(hi+1);rest=rest.slice(0,hi);}remark=trimText(decode(fragment));
    const qi=rest.indexOf('?');if(qi>=0){q=new URLSearchParams(rest.slice(qi+1));rest=rest.slice(0,qi);}
    if(q.has('plugin'))throw new Error('پلاگین Shadowsocks در این نسخه پشتیبانی نمی‌شود.');
    if(!rest.includes('@'))rest=base64(rest);
    const at=rest.lastIndexOf('@');if(at<0)throw new Error('لینک Shadowsocks معتبر نیست.');
    let credentials=decode(rest.slice(0,at));if(!credentials.includes(':'))credentials=base64(credentials);
    const cut=credentials.indexOf(':');if(cut<=0)throw new Error('رمز Shadowsocks معتبر نیست.');
    user=credentials.slice(0,cut).toLowerCase();secret=credentials.slice(cut+1);
    const u=new URL('ss://x@'+rest.slice(at+1));address=safeHost(u.hostname,allowLocal);port=Number(u.port||443);
    if(!CIPHERS.has(user)||!secret||secret.length>1024)throw new Error('رمزنگاری Shadowsocks پشتیبانی نمی‌شود.');
  }else{
    let u;try{u=new URL(raw);}catch{throw new Error('لینک معتبر نیست.');}
    address=safeHost(u.hostname,allowLocal);port=Number(u.port||443);user=decode(u.username);secret=decode(u.password);remark=trimText(decode(u.hash.slice(1)));q=u.searchParams;
    if(secret)user+=':'+secret;
  }
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('پورت نامعتبر است.');
  if(!user||user.length>1024||/[\x00-\x1f\x7f]/.test(user+secret))throw new Error('شناسه یا رمز معتبر نیست.');
  if(['vless','vmess'].includes(scheme)&&!UUID.test(user))throw new Error('شناسهٔ UUID معتبر نیست.');
  const network=(scheme==='vmess' && vm.net ? String(vm.net) : (qv(q,'type','net')||'tcp')).toLowerCase().replace('websocket','ws').replace('splithttp','xhttp');
  if(!['tcp','raw','ws','grpc','xhttp','httpupgrade'].includes(network))throw new Error('نوع انتقال در این نسخه پشتیبانی نمی‌شود.');
  if(scheme==='ss' && network!=='tcp')throw new Error('انتقال Shadowsocks پشتیبانی نمی‌شود.');
  let security=((scheme==='vmess' && Object.keys(vm).length ? String(vm.tls||'none') : qv(q,'security','tls'))||(scheme==='trojan'?'tls':'none')).toLowerCase();
  if(['','false','0'].includes(security))security='none';
  if(!['none','tls','reality'].includes(security))throw new Error('نوع امنیت پشتیبانی نمی‌شود.');
  if(security==='reality'&&!qv(q,'pbk','publicKey'))throw new Error('کلید Reality موجود نیست.');
  const insecure=['1','true'].includes(qv(q,'allowInsecure','insecure').toLowerCase());
  const transport={network,security,host:qv(q,'host'),path:qv(q,'path')||'/',service:qv(q,'serviceName','service','path'),authority:qv(q,'authority'),mode:qv(q,'mode'),header:qv(q,'headerType','header')};
  const tls={sni:qv(q,'sni','serverName')||qv(q,'host')||address,fp:qv(q,'fp','fingerprint'),alpn:qv(q,'alpn'),pbk:qv(q,'pbk','publicKey'),sid:qv(q,'sid','shortId'),spx:qv(q,'spx','spiderX'),pin:qv(q,'pcs'),verifyName:qv(q,'vcn'),insecure};
  const flow=qv(q,'flow');if(flow && !['xtls-rprx-vision','xtls-rprx-vision-udp443'].includes(flow))throw new Error('Flow در این نسخه پشتیبانی نمی‌شود.');
  const aid=Number(qv(q,'aid','alterId')||0);if(!Number.isInteger(aid)||aid<0||aid>65535)throw new Error('alterId نامعتبر است.');
  return {id:crypto.createHash('sha256').update(raw).digest('hex').slice(0,24),scheme,address,port,user,secret,remark,transport,tls,flow,alterId:aid,vmessSecurity:qv(q,'scy','encryption')||'auto',vlessEncryption:qv(q,'encryption')||'none',raw};
}
function buildXray(config,httpPort,socksPort,{upstreamSocksPort=0,routing=null}={}){
  if(!config||!Number.isInteger(httpPort)||!Number.isInteger(socksPort)||httpPort<1||socksPort<1||httpPort>65535||socksPort>65535||httpPort===socksPort)throw new Error('پورت پراکسی نامعتبر است.');
  const {scheme,address,port,user,secret,transport:t,tls,flow}=config;
  let settings;
  if(scheme==='vless')settings={vnext:[{address,port,users:[{id:user,encryption:config.vlessEncryption,...(flow?{flow}:{})}]}]};
  else if(scheme==='vmess')settings={vnext:[{address,port,users:[{id:user,alterId:config.alterId,security:config.vmessSecurity}]}]};
  else if(scheme==='trojan')settings={servers:[{address,port,password:user}]};
  else if(scheme==='ss')settings={servers:[{address,port,method:user,password:secret}]};
  else throw new Error('پروتکل پشتیبانی نمی‌شود.');
  const stream={network:t.network,security:t.security};
  if(['tcp','raw'].includes(t.network) && t.header==='http')stream[t.network==='raw'?'rawSettings':'tcpSettings']={header:{type:'http',request:{path:[t.path],headers:t.host?{Host:[t.host]}:{}}}};
  if(t.network==='ws')stream.wsSettings={path:t.path,...(t.host?{host:t.host,headers:{Host:t.host}}:{})};
  if(t.network==='httpupgrade')stream.httpupgradeSettings={path:t.path,...(t.host?{host:t.host}:{})};
  if(t.network==='xhttp')stream.xhttpSettings={path:t.path,mode:t.mode||'auto',...(t.host?{host:t.host}:{})};
  if(t.network==='grpc')stream.grpcSettings={serviceName:t.service||'',multiMode:t.mode==='multi',...(t.authority||t.host?{authority:t.authority||t.host}:{})};
  if(t.security==='tls')stream.tlsSettings={serverName:tls.sni,...(tls.fp?{fingerprint:tls.fp}:{}),...(tls.alpn?{alpn:tls.alpn.split(',').map(x=>x.trim()).filter(Boolean)}:{}),...(tls.pin?{pinnedPeerCertSha256:tls.pin}:{}),...(tls.verifyName?{verifyPeerCertByName:tls.verifyName}:(!tls.pin && tls.insecure?{verifyPeerCertByName:tls.sni}:{}))};
  if(t.security==='reality')stream.realitySettings={serverName:tls.sni,fingerprint:tls.fp||'chrome',publicKey:tls.pbk,...(tls.sid?{shortId:tls.sid}:{}),...(tls.spx?{spiderX:tls.spx}:{})};
  const outbounds=[{tag:'proxy',protocol:scheme==='ss'?'shadowsocks':scheme,settings,streamSettings:stream}];
  if(upstreamSocksPort){
    if(!Number.isInteger(upstreamSocksPort)||upstreamSocksPort<1||upstreamSocksPort>65535||[httpPort,socksPort].includes(upstreamSocksPort))throw new Error('پورت زنجیره نامعتبر است.');
    // The selected outbound is dialled via the existing local Psiphon SOCKS
    // listener, rather than pointing system proxy settings at either server.
    stream.sockopt={...(stream.sockopt||{}),dialerProxy:'lml-upstream'};
    outbounds.push({tag:'lml-upstream',protocol:'socks',settings:{servers:[{address:'127.0.0.1',port:upstreamSocksPort}]}});
  }
  const result={log:{loglevel:'warning'},inbounds:[{tag:'lml-http',listen:'127.0.0.1',port:httpPort,protocol:'http',settings:{}},{tag:'lml-socks',listen:'127.0.0.1',port:socksPort,protocol:'socks',settings:{auth:'noauth',udp:true}}],outbounds};
  if(routing){
    outbounds.push({tag:'direct',protocol:'freedom',settings:{}},{tag:'block',protocol:'blackhole',settings:{}});
    result.routing=routing;
  }
  return result;
}
function decodeEntities(s){return s.replace(/&(?:amp|quot|lt|gt|apos|#\d+|#x[0-9a-f]+);/gi,m=>{
  const v=m.slice(1,-1).toLowerCase();if(v==='amp')return '&';if(v==='quot')return '"';if(v==='lt')return '<';if(v==='gt')return '>';if(v==='apos')return "'";
  try{const n=v[1]==='x'?parseInt(v.slice(2),16):parseInt(v.slice(1),10);return n>0&&n<=0x10ffff?String.fromCodePoint(n):' ';}catch{return ' ';}
});}
function extractLinks(text,source){
  if(typeof text!=='string')return [];
  const input=decodeEntities(text.slice(0,3_000_000));
  const matches=input.match(/(?:vless|vmess|trojan|ss):\/\/[^\s<>"'`\\]+/gi)||[];const found=[];const seen=new Set();
  for(let raw of matches.slice(0,700)){
    raw=raw.replace(/[),;]+$/,'');
    try{const c=parseLink(raw);if(!seen.has(c.id)){seen.add(c.id);found.push({...c,source:trimText(source,50)});}}catch{}
  }return found;
}
function publicEntry(c){return {id:c.id,scheme:c.scheme.toUpperCase(),name:PUBLIC_CONFIG_NAME,source:'Google',network:c.transport.network,security:c.transport.security,insecure:c.tls.insecure};}
module.exports={parseLink,buildXray,extractLinks,publicEntry,safeHost,PUBLIC_CONFIG_NAME};
