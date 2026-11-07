'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
const {buildRouting,customRules}=require('../lib/routing.cjs');const {parseLink,buildXray}=require('../lib/config-links.cjs');
test('routing presets and custom domain/IP rules are validated',()=>{
 assert.equal(buildRouting(),null);
 const r=buildRouting({preset:'iran-bypass',custom:'proxy domain example.com\nblock ip 192.0.2.0/24'});assert.equal(r.rules[0].outboundTag,'proxy');assert.deepEqual(r.rules[0].domain,['domain:example.com']);assert.deepEqual(r.rules[1].ip,['192.0.2.0/24']);
 for(const text of ['direct domain example.com;evil','direct ip 1.2.3.4/999','direct process foo.exe','block domain *.example.com'])assert.throws(()=>customRules(text));
 assert.throws(()=>buildRouting({preset:'invalid'}));
});
test('all supported geo presets pass real Xray configuration validation',{skip:!process.env.LML_XRAY_TEST_BIN},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lml-routing-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const binDir=path.resolve(__dirname,'..','resources','bin'),c=parseLink('vless://11111111-1111-4111-8111-111111111111@example.com:443?security=none');
 for(const preset of ['global','iran-bypass','china-bypass','china-proxy-listed','russia-bypass']){
  const file=path.join(dir,preset+'.json');await fs.writeFile(file,JSON.stringify(buildXray(c,10111,10112,{routing:buildRouting({preset})})));
  try{await promisify(execFile)(process.env.LML_XRAY_TEST_BIN,['run','-test','-c',file],{env:{...process.env,XRAY_LOCATION_ASSET:binDir},timeout:15000});}
  catch(error){assert.fail(`${preset}: ${error.stderr||error.stdout||error.message}`);}
 }
});
