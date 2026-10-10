import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ArticleService } from './articles.js';
import { LocalStorage } from './storage.js';

async function fixture(writer?: any) {
  const root = await mkdtemp(path.join(tmpdir(), 'article-test-'));
  const service = new ArticleService({ storage: new LocalStorage(root), writer: writer ?? { run: async () => ({ topics: [1,2,3].map(n => ({ id: `topic-${n}`, title: `方向${n}`, audience: '读者', question: '问题', thesis: '主张', hook: '开头', angle: '解释', researchQuestions: [] })) }) } });
  return { root, service, dispose: () => rm(root, { recursive: true, force: true }) };
}

test('layout changes preserve writing results and benchmark references enter only writing requirements', async t => {
  const f=await fixture();t.after(f.dispose);
  let a=await f.service.create({keyword:'自行选择的话题'});
  a=await f.service.run(a.id,'diagnose',a.version);
  const themed=await f.service.update(a.id,{version:a.version,layoutTemplate:'minimal-read'});
  assert.equal(themed.layoutTemplate,'minimal-read');assert.deepEqual(themed.topics,a.topics);assert.equal(themed.steps.diagnose,'succeeded');
  await assert.rejects(f.service.update(a.id,{version:themed.version,layoutTemplate:'unknown'}),/模板/);
  const service=new ArticleService({storage:new LocalStorage(f.root),writer:{run:async()=>({})},resolveBenchmark:async()=>({domain:'任意领域',audience:'用户定义',styleSample:'对标写作观察，仅供风格参考'})});
  const fromBenchmark=await service.create({keyword:'独立文章选题',benchmarkId:'selected-group'});
  assert.equal(fromBenchmark.requirements.domain,'任意领域');assert.equal(fromBenchmark.sources.length,0);assert.equal(fromBenchmark.facts.length,0);
  assert.ok(fromBenchmark.requirements.styleSample.includes('风格参考'));
});

test('independent article persists without a video and rejects stale saves', async () => {
  const f = await fixture();
  try {
    const a = await f.service.create({ keyword: '项目变化' });
    const saved = await f.service.update(a.id, { version: a.version, requirements: { audience: '产品用户' } });
    await assert.rejects(f.service.update(a.id, { version: a.version, keyword: '旧编辑' }), /版本/);
    const fresh = new ArticleService({ storage: new LocalStorage(f.root), writer: { run: async () => ({}) } });
    assert.equal((await fresh.get(a.id)).requirements.audience, '产品用户');
    assert.equal((await fresh.list()).length, 1);
    assert.ok(saved.version > a.version);
  } finally { await f.dispose(); }
});

test('no material cannot become an article and changing source invalidates generated work', async () => {
  const f = await fixture();
  try {
    let a = await f.service.create({ keyword: '项目变化' });
    a = await f.service.run(a.id, 'diagnose', a.version);
    a = await f.service.update(a.id, { version: a.version, selectedTopic: 'topic-1' });
    await assert.rejects(f.service.run(a.id, 'evidence', a.version), /资料/);
    a = await f.service.update(a.id, { version: a.version, addText: { title: '原始资料', text: '项目周三开放了导出，离线编辑仍在开发。' } });
    assert.equal(a.sources[0]?.status, 'readable');
    a = await f.service.update(a.id, { version: a.version, keyword: '新选题' });
    assert.equal(a.selectedTopic, undefined);
    assert.equal(a.steps.evidence, 'pending');
  } finally { await f.dispose(); }
});

test('failed regeneration preserves previous diagnosis and releases the running lock', async () => {
  let fail = false;
  const f = await fixture({ run: async () => { if (fail) throw new Error('upstream'); return { topics: [1,2,3].map(n => ({ id: `topic-${n}`, title: `方向${n}` })) }; } });
  try {
    let a = await f.service.create({ keyword: '项目变化' });
    a = await f.service.run(a.id, 'diagnose', a.version);
    fail = true;
    await assert.rejects(f.service.run(a.id, 'diagnose', a.version), /失败/);
    const result = await f.service.get(a.id);
    assert.equal(result.topics[0]?.title, '方向1');
    assert.equal(result.steps.diagnose, 'failed');
    assert.equal(result.running, undefined);
  } finally { await f.dispose(); }
});

test('concurrent generation locks saves; restart recovers interrupted runs without discarding content', async () => {
  let release!: () => void; let started!: () => void;
  const signal = new Promise<void>(resolve => {started=resolve;});
  const pending = new Promise<void>(resolve => {release=resolve;});
  const f = await fixture({run:async () => {started();await pending;return {topics:[]};}});
  try {
    const a = await f.service.create({keyword:'并发'}); const operation = f.service.run(a.id,'diagnose',a.version); await signal;
    await assert.rejects(f.service.update(a.id,{version:a.version,keyword:'覆盖'}),/正在处理/);
    await assert.rejects(f.service.remove(a.id,a.version),/正在处理/);
    const fresh = new ArticleService({storage:new LocalStorage(f.root),writer:{run:async () => ({})}});
    const recovered = await fresh.get(a.id);assert.equal(recovered.running,undefined);assert.equal(recovered.steps.diagnose,'failed');assert.match(recovered.error ?? '',/中断/);
    release();await operation;
  } finally {release();await f.dispose();}
});

test('corrupt article index is not replaced by a create attempt', async () => {
  const f = await fixture();
  try {
    const storage = new LocalStorage(f.root);await storage.writeJsonAtomic('cache/articles.json',{bad:{id:'other'}});
    await assert.rejects(f.service.create({keyword:'不得覆盖'}),/索引损坏/);
    assert.deepEqual(await storage.readJson('cache/articles.json'),{bad:{id:'other'}});
  } finally {await f.dispose();}
});

test('editing pasted material keeps its identity and invalidates downstream evidence',async () => {
  const f = await fixture();try {
    let a = await f.service.create({keyword:'材料修订'});
    a = await f.service.update(a.id,{version:a.version,addText:{title:'来源',text:'项目支持导出'}});
    const id = a.sources[0].id;
    a = await f.service.update(a.id,{version:a.version,editSourceText:{id,title:'来源更正',text:'项目尚未支持离线编辑'}});
    assert.equal(a.sources[0].id,id);assert.equal(a.sources[0].text,'项目尚未支持离线编辑');assert.equal(a.materialConfirmed,false);assert.equal(a.steps.evidence,'pending');
  }finally {await f.dispose();}
});

test('unsafe material URLs are a validation error without changing the saved article',async () => {
  const f = await fixture();try {const a = await f.service.create({keyword:'安全来源'});await assert.rejects(f.service.update(a.id,{version:a.version,addUrl:{url:'https://127.0.0.1/private'}}),(e:any) => e.status === 422);assert.equal((await f.service.get(a.id)).sources.length,0);}finally {await f.dispose();}
});

async function completedArticle(f:Awaited<ReturnType<typeof fixture>>) {
  let a = await f.service.create({keyword:'完整创作'});
  a = await f.service.run(a.id,'diagnose',a.version);a = await f.service.update(a.id,{version:a.version,selectedTopic:'topic-1',addText:{title:'资料',text:'项目支持导出'}});
  a = await f.service.run(a.id,'evidence',a.version);a = await f.service.update(a.id,{version:a.version,materialConfirmed:true});a = await f.service.run(a.id,'outline',a.version);a = await f.service.update(a.id,{version:a.version,outlineConfirmed:true});a = await f.service.run(a.id,'draft',a.version);return f.service.run(a.id,'review',a.version);
}
const fullWriter = {run:async (step:any,a:any) => {
  if(step === 'diagnose') return {topics:[{id:'topic-1',title:'方向'}]};
  if(step === 'evidence') return {facts:[{id:'fact-1',claim:'支持导出',sourceId:a.sources[0].id,quote:'项目支持导出'}],issues:[]};
  if(step === 'outline') return {thesis:'主张',opening:'开头',sections:[{heading:'章节',points:['论据'],factIds:['fact-1']}],gaps:[]};
  const draft = {title:'原稿',sections:[{heading:'章节',paragraphs:['项目支持导出'],factIds:['fact-1']}]};
  return step === 'draft' ? draft : {revision:{...draft,title:'修订稿'},notes:[]};
}};
test('editing the adopted revision preserves that choice and requires renewed review',async () => {
  const f = await fixture(fullWriter);try {let a = await completedArticle(f);assert.equal(a.adopted,'revision');a = await f.service.update(a.id,{version:a.version,revision:{...a.revision,title:'修改过的修订稿'}});assert.equal(a.adopted,'revision');assert.equal(a.reviewed,false);}finally {await f.dispose();}
});
test('regenerated evidence always needs a fresh material confirmation',async () => {
  const f = await fixture(fullWriter);try {let a = await completedArticle(f);assert.equal(a.materialConfirmed,true);a = await f.service.run(a.id,'evidence',a.version);assert.equal(a.materialConfirmed,false);await assert.rejects(f.service.run(a.id,'outline',a.version),/确认资料/);}finally {await f.dispose();}
});


test('package success has no fallible article write after the publishing transaction commits',async () => {
  const f = await fixture(fullWriter);try {
    let a = await completedArticle(f);a = await f.service.update(a.id,{version:a.version,reviewed:true,coverAssetId:'cover'});
    const file = path.join(f.root,'cover.png');await writeFile(file,'image');
    const deps = (f.service as any).deps;deps.resolveAsset=async () => ({path:file,record:{kind:'image'}});
    let committed = false;deps.createPackage=async () => {committed=true;return {package:{id:'created-package'}};};
    const write = deps.storage.writeJsonAtomic.bind(deps.storage);deps.storage.writeJsonAtomic=async (...args:any[]) => {if(committed) throw new Error('disk full');return write(...args);};
    const p = await f.service.preview(a.id,a.version);
    const result = await f.service.createPackage(a.id,a.version,p.previewRevision,{userId:'actor',displayName:'操作者',role:'admin'});
    assert.equal(result.package.id,'created-package');assert.equal((await f.service.get(a.id)).running,undefined);
  }finally {await f.dispose();}
});


test('layout defaults apply only to future articles; saved legacy choices never migrate implicitly',async t=>{
 const f=await fixture();t.after(f.dispose);
 const legacy=await f.service.create({keyword:'旧文章'});
 await f.service.update(legacy.id,{version:legacy.version,layoutTemplate:'minimal-read'});
 const old=await f.service.get(legacy.id);
 const defaults=await f.service.layoutDefaults();
 const saved=await f.service.saveLayoutDefaults({version:defaults.version,layoutTemplate:'deep-reading',layoutOptions:{fontSize:18,lineHeight:2,themeColor:'#555165'}});
 const next=await f.service.create({keyword:'新文章'});
 assert.equal(next.layoutTemplate,'deep-reading');assert.equal(next.layoutVersion,2);assert.equal(next.layoutOptions?.fontSize,18);
 assert.deepEqual(await f.service.get(old.id),old);
 await assert.rejects(f.service.saveLayoutDefaults({version:defaults.version,layoutTemplate:'tech-explainer',layoutOptions:{}}),/版本/);
 const reset=await f.service.saveLayoutDefaults({version:saved.version,reset:true});assert.equal(reset.layoutTemplate,'tech-explainer');
 const restored=new ArticleService({storage:new LocalStorage(f.root),writer:{run:async()=>({})}});
 assert.equal((await restored.layoutDefaults()).version,reset.version);
 await assert.rejects(f.service.update(next.id,{version:next.version,layoutOptions:{themeColor:'evil'}}),/主题色/);
});
