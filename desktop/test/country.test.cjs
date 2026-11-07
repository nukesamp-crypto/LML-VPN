'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {flagFromRemark,buildV4Index,findV4,GeoCountry}=require('../lib/country.cjs');
function varint(n){const out=[];do{let b=n%128;n=Math.floor(n/128);if(n)b|=128;out.push(b);}while(n);return Buffer.from(out);}
const field=(n,data)=>Buffer.concat([varint(n*8+2),varint(data.length),data]);
function cidr(ip,prefix){const bytes=Buffer.from(ip.split('.').map(Number));return Buffer.concat([field(1,bytes),varint(16),varint(prefix)]);}
function country(code,...ranges){return field(1,Buffer.concat([field(1,Buffer.from(code)),...ranges.map(r=>field(2,r))]));}
test('country flags come only from a clearly labelled flag or country hint',()=>{
 assert.equal(flagFromRemark('🇩🇪@FreakConfig'),'DE');assert.equal(flagFromRemark('[US] secure route'),'US');
 assert.equal(flagFromRemark('Frankfurt Germany'),'DE');assert.equal(flagFromRemark('کانادا شماره ۲'),'CA');
 assert.equal(flagFromRemark('bus station node'),'');assert.equal(flagFromRemark('example.com'),'');
});
test('GeoIP uses the most specific IPv4 range and never invents a result',()=>{
 const data=Buffer.concat([country('US',cidr('10.0.0.0',8)),country('CA',cidr('10.2.3.0',24)),country('DE',cidr('1.2.3.4',32))]);
 const index=buildV4Index(data);
 assert.equal(findV4(index,'10.2.3.8'),'CA');assert.equal(findV4(index,'10.5.2.1'),'US');
 assert.equal(findV4(index,'1.2.3.4'),'DE');assert.equal(findV4(index,'2.2.2.2'),'');assert.equal(findV4(index,'bad'),'');
});
test('missing GeoIP data yields an unknown location',async()=>{
 const lookup=new GeoCountry('/this/file/does/not/exist');assert.equal(await lookup.lookup('8.8.8.8'),'');assert.equal(await lookup.lookup('example.com'),'');
});
