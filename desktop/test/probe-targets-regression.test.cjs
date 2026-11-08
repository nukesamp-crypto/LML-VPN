'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {verifyThroughProxy,VERIFY_TARGETS}=require('../lib/config-engine.cjs');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
test('independent HTTPS targets can rescue a working route when the primary fails',async()=>{
 const attempted=[],aborted=[];
 const targets=[{host:'one.example.com',path:'/'},{host:'two.example.com',path:'/'}];
 const ok=await verifyThroughProxy(4321,{targets,timeout:1000,stagger:5,attempt:async(_port,target,{signal})=>{
  attempted.push(target.host);
  if(target.host==='one.example.com')return false;
  signal.addEventListener('abort',()=>aborted.push(target.host),{once:true});await wait(5);return true;
 }});
 assert.equal(ok,true);assert.deepEqual(attempted,['one.example.com','two.example.com']);
 assert(VERIFY_TARGETS.length>=2);assert(new Set(VERIFY_TARGETS.map(x=>x.host)).size>=2);
});
test('successful or cancelled HTTPS target races promptly abort remaining work',async()=>{
 const targets=[{host:'fast.example.com',path:'/'},{host:'slow.example.com',path:'/'}];let sawAbort=false;
 const job=verifyThroughProxy(1,{targets,timeout:1000,stagger:0,attempt:(_port,target,{signal})=>{
  if(target.host==='fast.example.com')return wait(20).then(()=>true);
  return new Promise(resolve=>signal.addEventListener('abort',()=>{sawAbort=true;resolve(false);},{once:true}));
 }});
 assert.equal(await job,true);await wait(10);assert.equal(sawAbort,true);
 const abort=new AbortController(),pending=verifyThroughProxy(1,{targets,timeout:5000,stagger:0,signal:abort.signal,attempt:(_p,_t,{signal})=>new Promise(resolve=>signal.addEventListener('abort',()=>resolve(false),{once:true}))});
 await wait(20);const now=Date.now();abort.abort();assert.equal(await pending,false);assert(Date.now()-now<200);
});
