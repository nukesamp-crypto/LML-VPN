'use strict';
const net=require('node:net');
const {domainToASCII}=require('node:url');
const PRESETS=new Set(['global','iran-bypass','china-bypass','china-proxy-listed','russia-bypass']);
function domain(value){
 const d=domainToASCII(String(value||'').trim().replace(/\.$/,''));
 if(!d||d.length>253||net.isIP(d)||!d.includes('.')||!d.split('.').every(x=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(x)))throw new Error('دامنهٔ قانون نامعتبر است.');
 return d.toLowerCase();
}
function ipOrCidr(value){
 const parts=String(value||'').split('/');const family=net.isIP(parts[0]);
 if(!family||parts.length>2||(parts.length===2&&(!/^\d+$/.test(parts[1])||+parts[1]>(family===4?32:128))))throw new Error('IP یا CIDR قانون نامعتبر است.');
 return parts.join('/');
}
function customRules(text){
 if(typeof text!=='string'||text.length>12000)throw new Error('قوانین بیش از حد طولانی هستند.');
 const rules=[];for(const [index,line] of text.split(/\r?\n/).entries()){
  const s=line.trim();if(!s||s.startsWith('#'))continue;
  const m=s.match(/^(proxy|direct|block)\s+(domain|ip)\s+(\S+)$/i);
  if(!m)throw new Error(`قالب قانون خط ${index+1} معتبر نیست.`);
  const [,act,kind,value]=m;const tag=act.toLowerCase(),k=kind.toLowerCase();
  try{rules.push({type:'field',[k]:[k==='domain'?'domain:'+domain(value):ipOrCidr(value)],outboundTag:tag});}
  catch{throw new Error(`مقدار قانون خط ${index+1} معتبر نیست.`);}
  if(rules.length>100)throw new Error('حداکثر ۱۰۰ قانون مجاز است.');
 }
 return rules;
}
function buildRouting({preset='global',custom=''}={}){
 if(!PRESETS.has(preset))throw new Error('پیش‌تنظیم مسیریابی نامعتبر است.');
 const rules=customRules(custom);
 if(preset==='iran-bypass')rules.push({type:'field',domain:['geosite:category-ir'],outboundTag:'direct'},{type:'field',ip:['geoip:ir','geoip:private'],outboundTag:'direct'});
 if(preset==='china-bypass')rules.push({type:'field',domain:['geosite:cn'],outboundTag:'direct'},{type:'field',ip:['geoip:cn','geoip:private'],outboundTag:'direct'});
 if(preset==='russia-bypass')rules.push({type:'field',domain:['geosite:category-ru'],outboundTag:'direct'},{type:'field',ip:['geoip:ru','geoip:private'],outboundTag:'direct'});
 if(preset==='china-proxy-listed')rules.push({type:'field',ip:['geoip:private'],outboundTag:'direct'},{type:'field',domain:['geosite:geolocation-!cn'],outboundTag:'proxy'},{type:'field',network:'tcp,udp',outboundTag:'direct'});
 return rules.length?{domainStrategy:preset==='global'?'AsIs':'IPIfNonMatch',rules}:null;
}
module.exports={PRESETS,buildRouting,customRules,domain,ipOrCidr};
