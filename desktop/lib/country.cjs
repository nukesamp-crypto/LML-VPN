'use strict';
// Country indicators are best-effort metadata, never a claim about the final
// VPN exit. A publisher's flag is shown as such; literal IPv4 addresses can be
// looked up offline using the already-bundled v2fly GeoIP data.
const fs=require('node:fs/promises');
const net=require('node:net');

const COUNTRY_NAMES=Object.freeze({
  germany:'DE',deutschland:'DE',آلمان:'DE',netherlands:'NL',holland:'NL',هلند:'NL',
  unitedstates:'US',america:'US',آمریکا:'US',امریکا:'US',canada:'CA',کانادا:'CA',
  france:'FR',فرانسه:'FR',turkey:'TR',türkiye:'TR',ترکیه:'TR',
  unitedkingdom:'GB',britain:'GB',england:'GB',بریتانیا:'GB',انگلیس:'GB',
  sweden:'SE',سوئد:'SE',finland:'FI',فنلاند:'FI',norway:'NO',نروژ:'NO',
  switzerland:'CH',سوئیس:'CH',singapore:'SG',سنگاپور:'SG',japan:'JP',ژاپن:'JP',
  australia:'AU',استرالیا:'AU',russia:'RU',روسیه:'RU',india:'IN',هند:'IN',
  italy:'IT',ایتالیا:'IT',spain:'ES',اسپانیا:'ES',poland:'PL',لهستان:'PL',
  austria:'AT',اتریش:'AT',iran:'IR',ایران:'IR',uae:'AE',ireland:'IE',belgium:'BE',
  portugal:'PT',czechia:'CZ',romania:'RO',bulgaria:'BG',ukraine:'UA',taiwan:'TW',
  hongkong:'HK',southkorea:'KR',korea:'KR',brazil:'BR',argentina:'AR',israel:'IL'
});
// Restrict ambiguous two-letter tags to known country abbreviations, and only
// accept standalone uppercase tokens (not pieces of usernames or hostnames).
const COMMON_CODES=new Set('DE NL US GB CA FR TR SE FI NO CH SG JP AU RU IN IT ES PL AT IR AE IE BE PT CZ RO BG UA TW HK KR BR AR IL DK GR ZA NZ HU LU MX RS IS LT LV EE GE AM CY'.split(' '));
function flagFromRemark(value){
  const text=String(value||'').slice(0,300);
  const match=text.match(/\p{Regional_Indicator}{2}/u);
  if(match){
    const chars=Array.from(match[0]);
    return String.fromCharCode(...chars.map(c=>c.codePointAt(0)-0x1f1e6+65));
  }
  for(const [name,code] of Object.entries(COUNTRY_NAMES)){
    if(/[\u0600-\u06ff]/u.test(name)){if(text.includes(name))return code;continue;}
    if(new RegExp('(?:^|[^a-z])'+name+'(?:$|[^a-z])','i').test(text.replace(/[\s_-]+/g,'')))return code;
    if(new RegExp('(?:^|[^a-z])'+name+'(?:$|[^a-z])','i').test(text))return code;
  }
  for(const m of text.matchAll(/(?:^|[^A-Za-z0-9_])([A-Z]{2})(?=$|[^A-Za-z0-9_])/g))if(COMMON_CODES.has(m[1]))return m[1];
  return '';
}
function readVarint(b,start,end){
  let value=0,shift=0,pos=start;
  for(;pos<end && shift<=49;shift+=7){const byte=b[pos++];value+=(byte&127)*2**shift;if(!(byte&128))return [value,pos];}
  throw new Error('invalid protobuf varint');
}
function fields(b,start,end,visit){
  let p=start;
  while(p<end){
    let tag;[tag,p]=readVarint(b,p,end);const n=Math.floor(tag/8),wire=tag%8;
    if(!n)throw new Error('invalid protobuf tag');
    if(wire===2){let len;[len,p]=readVarint(b,p,end);const next=p+len;if(next>end)throw new Error('truncated protobuf');visit(n,wire,p,next);p=next;}
    else if(wire===0){let v;[v,p]=readVarint(b,p,end);visit(n,wire,v,v);}
    else if(wire===1){p+=8;}else if(wire===5){p+=4;}else throw new Error('unsupported protobuf wire');
    if(p>end)throw new Error('truncated protobuf');
  }
}
function networkNumber(ip,prefix){return prefix===0?0:((ip >>> (32-prefix)) << (32-prefix))>>>0;}
function addGeoEntry(buffer,maps,start,end){
  let code='',reverse=false;const cidrs=[];
  fields(buffer,start,end,(f,wire,a,z)=>{
    if(f===1&&wire===2)code=buffer.toString('ascii',a,z).toUpperCase();
    else if(f===2&&wire===2)cidrs.push([a,z]);
    else if(f===3&&wire===0)reverse=!!a;
  });
  if(!/^[A-Z]{2}$/.test(code)||reverse)return;
  for(const [a,z] of cidrs){
    let ip=null,prefix=0;
    fields(buffer,a,z,(f,wire,x,y)=>{
      if(f===1&&wire===2&&y-x===4)ip=buffer.readUInt32BE(x);
      else if(f===2&&wire===0)prefix=x;
    });
    if(ip!==null&&Number.isInteger(prefix)&&prefix>=0&&prefix<=32){
      const key=networkNumber(ip,prefix);
      // Keep the first country for ambiguous overlapping ranges; most
      // specific prefix wins at lookup time.
      if(!maps[prefix].has(key))maps[prefix].set(key,code);
    }
  }
}
function geoEntries(buffer){const entries=[];fields(buffer,0,buffer.length,(n,w,a,z)=>{if(n===1&&w===2)entries.push([a,z]);});return entries;}
function buildV4Index(buffer){const maps=Array.from({length:33},()=>new Map());for(const [a,z] of geoEntries(buffer))addGeoEntry(buffer,maps,a,z);return maps;}
async function buildV4IndexAsync(buffer){
  const maps=Array.from({length:33},()=>new Map());let i=0;
  for(const [a,z] of geoEntries(buffer)){
    addGeoEntry(buffer,maps,a,z);
    // Keep Electron's main thread responsive while indexing the bundled data.
    if(++i%3===0)await new Promise(resolve=>setImmediate(resolve));
  }
  return maps;
}
function ipv4Number(value){if(net.isIP(value)!==4)return null;return value.split('.').reduce((n,p)=>(n*256+Number(p))>>>0,0);}
function findV4(maps,value){
  const ip=ipv4Number(value);if(ip===null)return '';
  for(let prefix=32;prefix>=0;prefix--){const c=maps[prefix].get(networkNumber(ip,prefix));if(c)return c;}
  return '';
}
class GeoCountry {
  constructor(file){this.file=file;this.loading=null;}
  load(){
    if(!this.loading)this.loading=fs.readFile(this.file).then(b=>{
      if(b.length>60_000_000)throw new Error('GeoIP data too large');return buildV4IndexAsync(b);
    }).catch(()=>null);
    return this.loading;
  }
  async lookup(ip){if(net.isIP(ip)!==4)return '';const index=await this.load();return index?findV4(index,ip):'';}
}
module.exports={flagFromRemark,buildV4Index,findV4,GeoCountry};
