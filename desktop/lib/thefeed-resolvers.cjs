'use strict';
// Synchronize candidate DNS resolvers directly from the running official core's
// /api/profiles/defaults, before the user's core starts. This only changes its
// private data directory: never Windows DNS, either VPN engine, or a selected
// list. User-added resolvers and user deletions are preserved across syncs.
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const SYNC_STATE='.lml-thefeed-resolver-sync.json';

const isObject=x=>!!x && typeof x==='object' && !Array.isArray(x);
const ws=(s,i)=>{while(i<s.length && /[\x20\t\r\n]/.test(s[i]))i++;return i;};
function endString(s,i){
  if(s[i]!== '"') throw new Error('invalid JSON string');
  for(i++;i<s.length;i++){
    if(s[i]==='\\')i++;
    else if(s[i]==='"')return i+1;
  }
  throw new Error('unterminated JSON string');
}
// JSON.parse checks the syntax first. We only locate values so the rest of an
// existing profiles.json stays byte-for-byte unchanged, including int64s and
// fields introduced by a later upstream version.
function endValue(s,i){
  if(s[i]==='"')return endString(s,i);
  if(s[i]==='{' || s[i]==='['){
    const stack=[];
    for(let j=i;j<s.length;j++){
      const c=s[j];
      if(c==='"'){j=endString(s,j)-1;continue;}
      if(c==='{'||c==='[')stack.push(c);
      else if(c==='}'||c===']'){
        if(stack.pop()!==(c==='}'?'{':'['))throw new Error('invalid JSON nesting');
        if(!stack.length)return j+1;
      }
    }
    throw new Error('unterminated JSON value');
  }
  let j=i;while(j<s.length && !/[\x20\t\r\n,}]/.test(s[j]))j++;
  if(j===i)throw new Error('invalid JSON value');
  return j;
}
function topLevelProperties(raw){
  let i=ws(raw,0);if(raw[i++]!=='{')throw new Error('profiles must be a JSON object');
  const props=[];i=ws(raw,i);
  while(raw[i]!=='}'){
    const start=i,end=endString(raw,start),key=JSON.parse(raw.slice(start,end));
    i=ws(raw,end);if(raw[i++]!==':')throw new Error('invalid JSON property');
    i=ws(raw,i);const valueStart=i,valueEnd=endValue(raw,i);
    props.push({key,valueStart,valueEnd});
    i=ws(raw,valueEnd);
    if(raw[i]===','){i=ws(raw,i+1);continue;}
    if(raw[i]!=='}')throw new Error('invalid JSON object');
  }
  return {props,close:i};
}
function uniqueProperty(props,name){
  const matches=props.filter(p=>p.key.toLowerCase()===name.toLowerCase());
  // Duplicate/case-variant keys are ambiguous between JSON implementations;
  // leave the original file entirely alone instead of guessing.
  if(matches.length>1)throw new Error('ambiguous profiles property');
  return matches[0];
}
function getCase(obj,name){
  if(!isObject(obj))return undefined;
  const keys=Object.keys(obj).filter(k=>k.toLowerCase()===name.toLowerCase());
  if(keys.length>1)throw new Error('ambiguous profiles field');
  return keys.length?obj[keys[0]]:undefined;
}
function strings(value){
  if(value==null)return [];
  if(!Array.isArray(value) || value.some(x=>typeof x!=='string'))throw new Error('invalid string list');
  return value;
}
function checkFields(obj,names,predicate){
  for(const name of names){const v=getCase(obj,name);if(v!=null && !predicate(v))throw new Error('invalid '+name);}
}
const stringValue=v=>typeof v==='string';
const booleanValue=v=>typeof v==='boolean';
const numberValue=v=>typeof v==='number' && Number.isFinite(v);
const integerValue=v=>numberValue(v) && Number.isInteger(v) && Math.abs(v)<=9223372036854775808;
function validateConfig(config){
  if(config==null)return;
  if(!isObject(config))throw new Error('invalid config');
  checkFields(config,['domain','key','serverKey','queryMode'],stringValue);
  checkFields(config,['autoScan'],booleanValue);
  checkFields(config,['rateLimit','timeout'],numberValue);
  checkFields(config,['scatter'],integerValue);
  strings(getCase(config,'resolvers'));strings(getCase(config,'extraDomains'));
}
function validateProfiles(pl){
  if(!isObject(pl))throw new Error('invalid profiles');
  checkFields(pl,['active','theme','lang','skipUpdateVersion','downloadedVersion','telApiHash','telLastServer','selectedList','queryMode'],stringValue);
  checkFields(pl,['debug','telWatch','telAuthorized','scanPromptOff','mirrorNoteOff','telIntroSeen','profilePicsEnabled','resolverCacheShare'],booleanValue);
  checkFields(pl,['fontSize','migrationVersion','telApiId','scatter','cacheBudgetMB'],integerValue);
  checkFields(pl,['rateLimit','timeout'],numberValue);
  strings(getCase(pl,'resolverBank'));
  const ps=getCase(pl,'profiles');
  if(ps!=null){
    if(!Array.isArray(ps))throw new Error('invalid profiles list');
    for(const p of ps){
      if(p==null)continue;
      if(!isObject(p))throw new Error('invalid profile');
      checkFields(p,['id','nickname'],stringValue);
      checkFields(p,['autoUpdateInterval'],integerValue);
      strings(getCase(p,'autoUpdate'));strings(getCase(p,'pinnedChannels'));
      validateConfig(getCase(p,'config'));
    }
  }
  const lists=getCase(pl,'activeLists');
  if(lists!=null){
    if(!Array.isArray(lists))throw new Error('invalid active lists');
    for(const list of lists){
      if(list==null)continue;
      if(!isObject(list))throw new Error('invalid active list');
      checkFields(list,['name'],stringValue);checkFields(list,['lastUsed'],integerValue);
      strings(getCase(list,'resolvers'));
    }
  }
  const scores=getCase(pl,'resolverScores');
  if(scores!=null){
    if(!isObject(scores))throw new Error('invalid resolver scores');
    for(const score of Object.values(scores)){
      if(score==null)continue;
      if(!isObject(score))throw new Error('invalid resolver score');
      checkFields(score,['success','failure','totalMs'],integerValue);
    }
  }
  for(const field of ['seenIds','seenHashes']){
    const map=getCase(pl,field);
    if(map!=null && (!isObject(map) || Object.values(map).some(v=>v!=null && !integerValue(v))))throw new Error('invalid seen map');
  }
}
function profilesResolvers(value){
  if(value==null)return [];
  if(!Array.isArray(value))throw new Error('invalid profiles list');
  const result=[];
  for(const profile of value){
    if(profile==null)continue;
    if(!isObject(profile))throw new Error('invalid profile');
    const config=getCase(profile,'config');
    if(config!=null && !isObject(config))throw new Error('invalid profile config');
    result.push(...strings(getCase(config,'resolvers')));
  }
  return result;
}
async function readOptional(file){
  try{return await fs.readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}
}
async function atomicWrite(file,text){
  const tmp=file+'.lml-'+crypto.randomBytes(8).toString('hex')+'.tmp';
  try{
    await fs.writeFile(tmp,text,{encoding:'utf8',mode:0o600,flag:'wx'});
    await fs.rename(tmp,file);
  }catch(e){await fs.rm(tmp,{force:true}).catch(()=>{});throw e;}
}
function normalizeResolver(value){
  if(typeof value!=='string' || !value || value.length>256 || /[\x00-\x20]/.test(value))throw new Error('invalid official DNS address');
  return value.includes(':')?value:value+':53';
}
function validateOfficialResolvers(resolvers){
  if(!Array.isArray(resolvers) || resolvers.length===0 || resolvers.length>10000)throw new Error('invalid official DNS list');
  return [...new Set(resolvers.map(normalizeResolver))];
}
async function ensureOfficialResolvers(dataDir,resolvers,sourceVersion){
  const official=validateOfficialResolvers(resolvers);
  if(typeof sourceVersion!=='string' || !sourceVersion || sourceVersion.length>80)throw new Error('invalid upstream version');
  const stateFile=path.join(dataDir,SYNC_STATE);
  const stateRaw=await readOptional(stateFile);
  let previous=null;
  if(stateRaw!==null){
    previous=JSON.parse(stateRaw);
    if(!isObject(previous) || previous.schema!==1 || !Array.isArray(previous.official) || !Array.isArray(previous.owned))throw new Error('invalid DNS sync state');
    previous.official=validateOfficialResolvers(previous.official);
    // owned may legitimately be empty, unlike official.
    if(previous.owned.length>10000)throw new Error('invalid managed DNS list');
    previous.owned=previous.owned.map(normalizeResolver);
  }
  const profileFile=path.join(dataDir,'profiles.json');
  let raw=await readOptional(profileFile);
  const originalRaw=raw;
  let cfgRaw=null;
  let cfg=null;
  if(raw===null){
    // Upstream normally migrates config.json to a profile on first GET. If
    // only that legacy file exists, mirror the migration before creating the
    // resolver bank so the existing config never disappears from the UI.
    cfgRaw=await readOptional(path.join(dataDir,'config.json'));
    if(cfgRaw!==null){
      cfg=JSON.parse(cfgRaw);
      if(!isObject(cfg))throw new Error('invalid legacy config');
      validateConfig(cfg);
      const domain=getCase(cfg,'domain');
      if(domain!=null && typeof domain!=='string')throw new Error('invalid legacy config domain');
      strings(getCase(cfg,'resolvers'));
      const id=crypto.randomBytes(8).toString('hex');
      const nickname=typeof domain==='string'?domain:'';
      // Preserve the legacy config's exact JSON, including unknown fields.
      raw=`{\n  "active": ${JSON.stringify(id)},\n  "profiles": [{"id":${JSON.stringify(id)},"nickname":${JSON.stringify(nickname)},"config":${cfgRaw}}]\n}\n`;
    }else raw='{\n  "active": "",\n  "profiles": []\n}\n';
  }
  const parsed=JSON.parse(raw);
  validateProfiles(parsed);
  const {props,close}=topLevelProperties(raw);
  const bankProp=uniqueProperty(props,'resolverBank');
  const profilesProp=uniqueProperty(props,'profiles');
  const activeProp=uniqueProperty(props,'active');
  const active=activeProp?JSON.parse(raw.slice(activeProp.valueStart,activeProp.valueEnd)):undefined;
  if(active!=null && typeof active!=='string')throw new Error('invalid active profile');
  const bank=bankProp?strings(JSON.parse(raw.slice(bankProp.valueStart,bankProp.valueEnd))):[];
  const legacy=profilesProp?profilesResolvers(JSON.parse(raw.slice(profilesProp.valueStart,profilesProp.valueEnd))):[];
  // An older config can still be loaded directly. When the bank is empty,
  // carry its resolver addresses forward before adding upstream candidates.
  if(bank.length===0 && cfg===null){
    cfgRaw=await readOptional(path.join(dataDir,'config.json'));
    if(cfgRaw!==null){
      cfg=JSON.parse(cfgRaw);
      if(!isObject(cfg))throw new Error('invalid config');
      validateConfig(cfg);
      legacy.push(...strings(getCase(cfg,'resolvers')));
    }
  }
  const allLists=getCase(parsed,'activeLists') || [];
  // A resolver explicitly included in any of the user's lists or legacy
  // profiles is considered user-pinned, and is never removed by an update.
  const protectedSet=new Set(legacy.map(normalizeResolver));
  for(const list of allLists){
    for(const value of strings(getCase(list,'resolvers')))protectedSet.add(normalizeResolver(value));
  }
  const oldOfficial=new Set(previous?.official || []),oldOwned=new Set(previous?.owned || []);
  const newOfficial=new Set(official);
  const result=bank.filter(value=>!oldOwned.has(value) || newOfficial.has(value) || protectedSet.has(value));
  const seen=new Set(result);
  const owned=new Set([...oldOwned].filter(value=>newOfficial.has(value) && seen.has(value)));
  // Legacy resolvers are migrated into the shared pool exactly once when
  // there was no bank. Existing addresses remain untouched.
  if(bank.length===0)for(const value of legacy){
    const addr=normalizeResolver(value);if(!seen.has(addr)){seen.add(addr);result.push(addr);}
  }
  for(const addr of official){
    if(!seen.has(addr) && (!previous || !oldOfficial.has(addr))){
      seen.add(addr);result.push(addr);owned.add(addr);
    }
  }
  const value=JSON.stringify(result,null,2);
  const updated=bankProp
    ?raw.slice(0,bankProp.valueStart)+value+raw.slice(bankProp.valueEnd)
    :raw.slice(0,close)+(props.length?',':'')+'\n  "resolverBank": '+value+'\n'+raw.slice(close);
  // Do not commit a stale snapshot if another writer changed the file while
  // we were preparing it. The app itself already enforces a single instance.
  if(await readOptional(profileFile)!==originalRaw || await readOptional(stateFile)!==stateRaw)throw new Error('profile changed during DNS sync');
  const bankChanged=bank.length!==result.length || bank.some((v,i)=>v!==result[i]);
  if(originalRaw===null || !bankProp || bankChanged)await atomicWrite(profileFile,updated);
  const next={schema:1,source:sourceVersion,official,owned:[...owned]};
  const nextRaw=JSON.stringify(next)+'\n';
  if(nextRaw!==stateRaw)await atomicWrite(stateFile,nextRaw);
  return {state:previous?'synced':'provisioned',officialCount:official.length,bankCount:result.length};
}
module.exports={ensureOfficialResolvers,validateOfficialResolvers,SYNC_STATE};
