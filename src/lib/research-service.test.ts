import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResearchService } from './research-service.js';
import { parseResearchContent } from './research-content.js';

test('last cancelled consumer aborts the provider and never caches a late search result',async()=>{
 let entered!:()=>void,release!:(value:any[])=>void;const started=new Promise<void>(r=>entered=r);let signal:AbortSignal|undefined;
 const f=fixture({providers:{search:async(_q:string,s:AbortSignal)=>{signal=s;entered();return new Promise(r=>release=r);},readJina:async()=>article()}});
 const controller=new AbortController();const pending=f.service.search('u','cancel',controller.signal);await started;controller.abort();await assert.rejects(pending);assert.equal(signal?.aborted,true);
 release([]);await new Promise(r=>setImmediate(r));await assert.rejects(f.service.search('u','cancel'),(e:any)=>e.status===429);
});
test('cancelling a joined research consumer leaves another active reader intact',async()=>{
 let entered!:()=>void,release!:(value:any[])=>void;const started=new Promise<void>(r=>entered=r);let signal:AbortSignal|undefined;
 const f=fixture({providers:{search:async(_q:string,s:AbortSignal)=>{signal=s;entered();return new Promise(r=>release=r);},readJina:async()=>article()}});
 const controller=new AbortController();const cancelled=f.service.search('u','shared',controller.signal);await started;const other=f.service.search('u','shared');await new Promise(r=>setImmediate(r));controller.abort();await assert.rejects(cancelled);assert.equal(signal?.aborted,false);release([]);assert.equal((await other).candidates.length,0);assert.equal((await f.service.search('u','shared')).cached,true);
});
test('cancelled direct reading never starts Jina fallback or stores a readable snapshot',async()=>{
 let entered!:()=>void,release!:(value:any)=>void;const started=new Promise<void>(r=>entered=r);let signal:AbortSignal|undefined,jina=0;
 const f=fixture({resolveConfig:async()=>({exaEnabled:true,jinaEnabled:true}),readDirect:async(_url:string,s:AbortSignal)=>{signal=s;entered();return new Promise(r=>release=r);},providers:{search:async()=>[],readJina:async()=>{jina++;return article();}}});
 const controller=new AbortController();const pending=f.service.read('u',{url:'https://example.com/article'},controller.signal);await started;controller.abort();await assert.rejects(pending);assert.equal(signal?.aborted,true);release(article());await new Promise(r=>setImmediate(r));assert.equal(jina,0);await assert.rejects(f.service.read('u',{url:'https://example.com/article'}),(e:any)=>e.status===429);
});
const article=(url='https://news.example.com/article/1')=>parseResearchContent({url,provider:'direct',format:'html',body:`<title>原始报道</title><article><p>${'这份报道介绍技术与生活变化，也解释功能使用的条件和来源。'.repeat(12)}</p></article>`});
function fixture(overrides:any={}){
  let now=0;let searches=0;let reads=0;
  const config={jinaEnabled:false,exaEnabled:true};
  const service=new ResearchService({now:()=>now,resolveConfig:async()=>config,validateUrl:async()=>{},readDirect:async(url:string)=>{reads++;return article(url);},providers:{search:async()=>{searches++;return [{id:'candidate',title:'报道',url:'https://news.example.com/article/1',domain:'news.example.com',provider:'exa'}];},readJina:async(url:string)=>article(url)},...overrides});
  return {service,config,tick:(n:number)=>{now+=n;},counts:()=>({searches,reads})};
}
test('search/read cache and atomic selections are actor bound, hash checked and expire',async()=>{
  const f=fixture();const a=await f.service.search('u','技术');const cached=await f.service.search('u','技术');assert.equal(cached.cached,true);assert.equal(a.searchId,cached.searchId);
  const read=await f.service.read('u',{searchId:a.searchId,candidateId:'candidate'});const selections=[{readId:read.readId,hash:read.hash}];
  assert.equal((await f.service.resolveSelections('u',selections))[0].text,read.text);
  await assert.rejects(f.service.resolveSelections('other',selections),(e:any)=>e.status===410);
  await assert.rejects(f.service.resolveSelections('u',[{readId:read.readId,hash:'changed'}]),(e:any)=>e.status===409);
  await assert.rejects(f.service.resolveSelections('u',[...selections,{readId:'missing',hash:read.hash}]),(e:any)=>e.status===410);
  assert.deepEqual(f.counts(),{searches:1,reads:1});f.tick(30*60000);
  await assert.rejects(f.service.resolveSelections('u',selections),(e:any)=>e.status===410);
});
test('disabled services do not request providers, and failed requests are limited for 60 seconds',async()=>{
  const f=fixture({providers:{search:async()=>{throw Error('offline');},readJina:async()=>{throw Error('must not');}}});
  f.config.exaEnabled=false;await assert.rejects(f.service.search('u','技术'),(e:any)=>e.status===422);
  f.config.exaEnabled=true;await assert.rejects(f.service.search('u','技术'),(e:any)=>e.status===502);
  await assert.rejects(f.service.search('u','技术'),(e:any)=>e.status===429&&e.retryAfterSeconds===60);
  f.tick(60000);await assert.rejects(f.service.search('u','技术'),(e:any)=>e.status===502);
});
test('same key coalesces, three operations limit concurrency, cache eviction cannot bypass throttle',async()=>{
  let release!:()=>void;const hold=new Promise<void>(r=>{release=r;});let calls=0;
  const f=fixture({maxEntriesPerActor:1,providers:{search:async()=>{calls++;await hold;return [];},readJina:async()=>article()}});
  const one=f.service.search('u','a');const joined=f.service.search('u','a');const two=f.service.search('u','b');const three=f.service.search('u','c');
  await new Promise(r=>setImmediate(r));await assert.rejects(f.service.search('u','d'),(e:any)=>e.status===429);
  release();await Promise.all([one,joined,two,three]);assert.equal(calls,3);
  await assert.rejects(f.service.search('u','a'),(e:any)=>e.status===429);
});
test('topic cannot be evidence; disable changes cache fingerprint but retains selected read snapshots',async()=>{
  const f=fixture();const read=await f.service.read('u',{url:'https://news.example.com/article/1'});
  f.config.jinaEnabled=true;
  await assert.rejects(f.service.read('u',{url:read.url}),(e:any)=>e.status===429);
  assert.equal((await f.service.resolveSelections('u',[{readId:read.readId,hash:read.hash}])).length,1);
  const topic=fixture({readDirect:async()=>parseResearchContent({url:'https://www.toutiao.com/trending/1/',provider:'direct',format:'html',body:'<title>话题</title>'})});
  const result=await topic.service.read('u',{url:'https://www.toutiao.com/trending/1/'});
  await assert.rejects(topic.service.resolveSelections('u',[{readId:result.readId,hash:result.hash}]),(e:any)=>e.status===422);
});
test('disabling Jina while direct read is running prevents a new proxy request',async()=>{
  let release!:(value:any)=>void;let calls=0;
  const f=fixture({readDirect:()=>new Promise(r=>{release=r;}),providers:{search:async()=>[],readJina:async()=>{calls++;return article();}}});
  f.config.jinaEnabled=true;const pending=f.service.read('u',{url:'https://news.example.com/article/1'});
  await new Promise(r=>setImmediate(r));f.config.jinaEnabled=false;
  release({...article(),kind:'unreadable',status:'needs_material',text:''});await pending;assert.equal(calls,0);
});
test('failed reads can actually be retried after the 60-second throttle',async()=>{
  let calls=0;const f=fixture({readDirect:async()=>{calls++;throw Error('offline');}});
  await f.service.read('u',{url:'https://news.example.com/a'});f.tick(60000);await f.service.read('u',{url:'https://news.example.com/a'});assert.equal(calls,2);
});
