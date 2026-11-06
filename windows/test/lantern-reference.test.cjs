'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {configureHelper,helperRequest}=require('../lib/lantern.cjs');
const bin=path.join(__dirname,'..','resources','bin');
test('bundled Lantern daemon and helper match the working public Windows build',{skip:!require('node:fs').existsSync(path.join(bin,'lml-lanternd.exe'))},async()=>{
 const sha=async p=>crypto.createHash('sha256').update(await fs.readFile(p)).digest('hex');
 assert.equal(await sha(path.join(bin,'lml-lanternd.exe')),'111e8c510d805de28a92524376fb67064486319261b78395f80b64ff2777b8f0');
 assert.equal(await sha(path.join(bin,'lantern-ipc.exe')),'f6ff55cf79dfe3824213d4d4a5e3b0f34f37be0c2e51c6d51b0a865752a33ef7');
 const contents=await fs.readFile(path.join(bin,'lml-lanternd.exe'));
 assert(contents.includes(Buffer.from('build\t-tags=with_gvisor,with_quic,with_dhcp,with_wireguard,with_utls,with_acme,with_clash_api')));
});
test('Lantern helper honours the short timeout used for status checks',{skip:process.platform==='win32'},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lml-lantern-helper-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'slow-helper');await fs.writeFile(file,'#!/bin/sh\nexec sleep 5\n',{mode:0o700});configureHelper(file);
 const before=Date.now();await assert.rejects(helperRequest('GET','/vpn/status',null,{timeout:150}),/زمان پاسخ/);
 assert(Date.now()-before<2000);
});
