import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalStorage } from './storage.js';
import { WechatBenchmarkService, benchmarkAssessment, type BenchmarkAccount } from './wechat-benchmarks.js';

const candidate = (i:number): Omit<BenchmarkAccount,'id'> => ({ name:`示例号${i}`, identity:`account-${i}`, identityConfirmed:true,relevant:true,selected:true,notes:'短段落，先说明适用条件',samples:[{ title:'教程实例',url:`https://mp.weixin.qq.com/s/example-${i}`,dateText:'',reads:1200,lowerBound:false,metricSource:'用户核对文章页面',measuredAt:'2026-09-30T01:00:00.000Z' }] });

test('benchmark evidence, conflict, ten-account gate and restart persistence', async t => {
  const root = await mkdtemp(path.join(tmpdir(),'wechat-benchmarks-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const storage = new LocalStorage(root);await storage.ensureBaseDirs();const service = new WechatBenchmarkService(storage);
  let g = await service.create({name:'用户自选领域',audience:'自行定义的读者',keywords:['实用教程'],minReads:1000});
  await assert.rejects(service.update(g.id,{version:g.version,addAccount:{...candidate(0),samples:[{...candidate(0).samples[0],metricSource:''}]}}),/来源/);
  await assert.rejects(service.forArticle(g.id),/10/);
  for(let i=0;i<10;i++) g=await service.update(g.id,{version:g.version,addAccount:candidate(i)});
  assert.equal(g.assessment.qualifiedCount,10);
  const reference=await service.forArticle(g.id);assert.equal(reference.domain,'用户自选领域');assert.ok(reference.styleSample.includes('示例号9'));
  await assert.rejects(service.update(g.id,{version:g.version-1,minReads:1}),/版本/);
  await assert.rejects(service.update(g.id,{version:g.version,addAccount:candidate(0)}),/身份/);
  const previous=g.accounts[0]!;
  g=await service.update(g.id,{version:g.version,account:{...previous,samples:[{...previous.samples[0],reads:null,metricSource:'',measuredAt:''}]}});
  assert.equal(g.assessment.qualifiedCount,9);assert.equal(g.assessment.accounts[0]!.medianReads,null);
  await assert.rejects(service.forArticle(g.id),/10/);
  const restarted=new WechatBenchmarkService(storage);assert.equal((await restarted.list())[0]!.assessment.qualifiedCount,9);
});

test('unknown values, lower-bound median and unconfirmed identity never masquerade as exact verified traffic', () => {
  const a={...candidate(0),id:'test-account'};
  const group={id:'group',version:1,name:'领域',audience:'读者',keywords:['教程'],minReads:1000,accounts:[a],createdAt:'2026-09-30',updatedAt:'2026-09-30'};
  const summary=benchmarkAssessment({...group,accounts:[{...a,samples:[{...a.samples[0],reads:100000,lowerBound:true}]}]});
  assert.equal(summary.accounts[0]!.medianReads,100000);assert.equal(summary.accounts[0]!.lowerBound,true);
  assert.equal(benchmarkAssessment({...group,accounts:[{...a,identityConfirmed:false}]}).qualifiedCount,0);
  assert.equal(benchmarkAssessment({...group,accounts:[{...a,samples:[{...a.samples[0],reads:null}]}]}).qualifiedCount,0);
  const uncertain=benchmarkAssessment({...group,accounts:[{...a,samples:[{...a.samples[0],reads:100,lowerBound:true},{...a.samples[0],url:'https://mp.weixin.qq.com/s/two',reads:1200},{...a.samples[0],url:'https://mp.weixin.qq.com/s/three',reads:2000}]}]});
  assert.equal(uncertain.accounts[0]!.lowerBound,true);
});

test('corrupt index is rejected without replacing original contents',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'wechat-benchmark-bad-'));t.after(()=>rm(root,{recursive:true,force:true}));const storage=new LocalStorage(root);await storage.ensureBaseDirs();
  await writeFile(storage.resolve('cache/wechat-benchmarks.json'),'broken');
  await assert.rejects(new WechatBenchmarkService(storage).create({name:'领域',audience:'',keywords:['教程'],minReads:1000}),/损坏/);
});

test('public search caches ten minutes, coalesces calls and throttles failures',async()=>{
  let now=0,calls=0;const service=new WechatBenchmarkService(new LocalStorage('/unused'),{now:()=>now,search:async()=>{calls++;return [];}});
  await Promise.all([service.search('教程'),service.search('教程')]);assert.equal(calls,1);
  now=60000;await service.search('教程');assert.equal(calls,1);
  now=600001;await service.search('教程');assert.equal(calls,2);
  await assert.rejects(service.search('另一关键词'),/60/);
  const failed=new WechatBenchmarkService(new LocalStorage('/unused'),{now:()=>now,search:async()=>{throw new Error('验证码');}});
  await assert.rejects(failed.search('教程'),/验证码/);await assert.rejects(failed.search('另一关键词'),/60/);
});
