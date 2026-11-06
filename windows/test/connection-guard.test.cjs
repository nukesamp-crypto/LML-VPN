'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {ConnectionGuard}=require('../lib/connection-guard.cjs');
test('connection intents exclude each other and disconnect invalidates a pending intent',async()=>{
 const g=new ConnectionGuard();let release;const pending=new Promise(r=>release=r);let started=false;
 const first=g.run(async check=>{await pending;check();started=true;});
 assert(g.busy);assert.throws(()=>g.run(async()=>{}),/دیگر/);
 g.cancel();release();await assert.rejects(first,/لغو/);assert.equal(started,false);assert.equal(g.busy,false);
 assert.equal(await g.run(async check=>{check();return 42;}),42);assert.equal(g.busy,false);
});
