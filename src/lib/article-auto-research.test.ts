import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ArticleService} from './articles.js';
import {LocalStorage} from './storage.js';
import {ResearchError} from './research-types.js';
import {articleResearchCandidates,researchUrlKey,sameResearchText} from './article-auto-research.js';
import type {ArticleRecord,ArticleStep} from './article-types.js';
const body='项目支持导出，离线编辑仍未开放。'.repeat(20);
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const candidate=(url='https://developer.mozilla.org/docs/guide',title='官方说明')=>({url,title,id:url,domain:new URL(url).hostname,provider:'exa' as const,publishedAt:'2026-09-10T08:00:00.000Z',snippet:'摘要中的未核实说法'});
const read=(url:string,text=body)=>({url,text,title:'正文说明',status:'readable' as const,sourceKind:'article' as const,readAt:'2026-10-10T09:00:00.000Z',publishedAt:'2026-09-11T08:00:00.000Z',hash:hash(text),truncated:false,links:[]});
function writer(){return {async run(step:ArticleStep,a:ArticleRecord){
 if(step==='diagnose')return{topics:[1,2,3].map(n=>({id:'topic-'+n,title:'方向'+n,audience:'读者',question:'如何理解',thesis:'说明边界',hook:'导出',angle:'解释',researchQuestions:[]}))};
 if(step==='evidence')return{facts:[{id:'fact-1',claim:'支持导出',quote:'项目支持导出',sourceId:a.sources.find(s=>s.included&&s.status==='readable')!.id}],issues:[]};
 if(step==='outline')return{thesis:'说明导出',opening:'基本概念',sections:[{heading:'功能与边界',points:['说明条件'],factIds:['fact-1']}],gaps:[]};
 const draft={title:'隔离测试：导出与边界',sections:[{heading:'功能与边界',paragraphs:['项目支持导出，离线编辑仍未开放。'],factIds:['fact-1']}]};
 if(step==='draft')return draft;if(step==='review')return{revision:draft,notes:[]};return{images:[{section:0,purpose:'封面',caption:'示意',prompt:'导出流程'}]};
}};}
async function fixture(overrides:any={}){
 const root=await mkdtemp(path.join(tmpdir(),'article-search-'));const queries:string[]=[],reads:string[]=[],steps:string[]=[];
 const deps={storage:new LocalStorage(root),checkAi:async()=>true,writer:{run:async(step:ArticleStep,a:ArticleRecord)=>{steps.push(step);return writer().run(step,a);}},
  searchResearch:async(_actor:string,query:string)=>{queries.push(query);return{searchId:'search',query,fetchedAt:'2026-10-10T08:00:00.000Z',expiresAt:'2026-10-10T08:10:00.000Z',cached:false,candidates:[candidate()]};},
  readResearchSource:async(_actor:string,url:string)=>{reads.push(url);return read(url);},illustrate:async()=>({coverAssetId:'cover',bodyImageAssetIds:['image']}),...overrides};
 return {s:new ArticleService(deps),deps,root,queries,reads,steps,close:()=>rm(root,{recursive:true,force:true})};
}
async function settled(s:ArticleService,id:string){for(let i=0;i<500;i++){const a=await s.get(id);if(a.automation&&!['queued','running','cancelling'].includes(a.automation.status))return a;await new Promise(r=>setTimeout(r,5));}throw Error('did not settle');}
test('idea searches and reads full bodies, preserves distinct source dates, and produces source-bearing HTML',async t=>{
 const f=await fixture();t.after(f.close);const a=await f.s.createAuto({input:'想写一篇关于导出的文章',requestId:'idea'},'actor');const done=await settled(f.s,a.id);
 assert.equal(done.automation?.status,'ready');assert.equal(f.queries.length,1);assert.match(f.queries[0],/导出/);assert.equal(f.reads.length,1);
 const s=done.sources[0]!;assert.equal(s.text,body);assert.equal(s.publishedAt,'2026-09-11T08:00:00.000Z');assert.equal(s.discovery?.reportedPublishedAt,'2026-09-10T08:00:00.000Z');assert.equal(s.discovery?.fetchedAt,'2026-10-10T08:00:00.000Z');assert.equal(s.readAt,'2026-10-10T09:00:00.000Z');
 assert.ok(!s.text.includes('摘要'));assert.equal(done.materialConfirmed,false);assert.equal(done.reviewed,false);
 const html=(await f.s.previewLayout(a.id,{version:done.version})).html;assert.match(html,/developer.mozilla.org/);assert.match(html,/正文读取/);
 assert.equal((await f.s.createAuto({input:'想写一篇关于导出的文章',requestId:'idea'},'actor')).id,a.id);assert.equal(f.queries.length,1);
});
test('pasted body and successfully read original links bypass search; failed mixed links cannot leak private text',async t=>{
 const f=await fixture({readSource:async(url:string)=>url.includes('blocked')?{...read(url,''),status:'needs_material',sourceKind:'unreadable'}:read(url)});t.after(f.close);
 for(const [id,input] of [['text',body],['url','https://example.com/article'],['mixed',body+'\nhttps://example.com/article'],['private',body+'私人客户资料\nhttps://example.com/blocked?secret=private-query']]){
  const a=await f.s.createAuto({input,requestId:id},'actor');const done=await settled(f.s,a.id);assert.equal(done.automation?.status,'ready');
 }
 // Mixed input has enough body: no expansion is needed even though its link failed.
 assert.deepEqual(f.queries,[]);
});
test('explicit supplemental search sends only supplied public keywords and changing them rejects duplicate request IDs',async t=>{
 const f=await fixture();t.after(f.close);const input={input:body+'私人资料不进入搜索',searchQuery:'公开导出文档',requestId:'opt-in'};
 const a=await f.s.createAuto(input,'actor');const done=await settled(f.s,a.id);assert.equal(done.automation?.status,'ready');assert.deepEqual(f.queries,['公开导出文档']);assert.equal(done.sources[0].text,input.input);
 await assert.rejects(f.s.createAuto({...input,searchQuery:'另一个公开主题'},'actor'),/重复请求/);
 await assert.rejects(f.s.createAuto({...input,searchQuery:'x'.repeat(401),requestId:'too-long'},'actor'),/超限/);
});
for(const code of ['disabled','rate_limited','timeout','upstream'] as const)test(`search ${code} degrades with material, requests input without it, and resumes after supplemental text`,async t=>{
 let calls=0;const f=await fixture({searchResearch:async()=>{calls++;throw new ResearchError(code==='rate_limited'?429:422,code,'provider detail');}});t.after(f.close);
 const withText=await f.s.createAuto({input:body,searchQuery:'公开背景',requestId:'with-text'},'actor');const ready=await settled(f.s,withText.id);assert.equal(ready.automation?.status,'ready');assert.equal(ready.automation?.research?.status,'failed');
 const idea=await f.s.createAuto({input:'想写一篇关于导出的文章',requestId:'no-text'},'actor');let missing=await settled(f.s,idea.id);assert.equal(missing.automation?.status,'needs_input');assert.equal(missing.draft,undefined);
 const count=calls;missing=await f.s.update(idea.id,{version:missing.version,addText:{title:'补充正文',text:body}});await f.s.resumeAuto(idea.id,missing.version,'actor');assert.equal((await settled(f.s,idea.id)).automation?.status,'ready');assert.equal(calls,count);
});
test('failed original link triggers bounded public-link search and remains excluded reference after recovery',async t=>{
 const queries:string[]=[];const f=await fixture({readSource:async(url:string)=>({...read(url,''),status:'needs_material',sourceKind:'unreadable'}),searchResearch:async(_actor:string,query:string)=>{queries.push(query);return{query,fetchedAt:'2026-10-10T08:00:00Z',candidates:[candidate('https://example.com/blocked')]};}});t.after(f.close);
 const a=await f.s.createAuto({input:'https://example.com/blocked?secret=private-query',requestId:'recover-link'},'actor');const done=await settled(f.s,a.id);
 assert.equal(done.automation?.status,'ready');assert.equal(queries.length,1);assert.ok(!queries[0].includes('private-query'));assert.match(queries[0],/example.com/);assert.equal(done.sources[0].included,false);assert.equal(done.sources[1].included,true);
});
test('topics, blocked bodies, invalid hashes and search snippets never become facts',async t=>{
 for(const mode of ['topic','blocked','hash','snippet']){
  const f=await fixture({readResearchSource:async(_actor:string,url:string)=>({...read(url),...(mode==='topic'?{sourceKind:'topic'}:mode==='blocked'?{status:'needs_material',text:''}:mode==='hash'?{hash:'wrong'}:{text:'摘要中的未核实说法',hash:hash('摘要中的未核实说法')})})});t.after(f.close);
  const a=await f.s.createAuto({input:'想写一篇导出文章',requestId:mode},'actor');const done=await settled(f.s,a.id);assert.equal(done.automation?.status,'needs_input');assert.equal(done.sources.length,0);assert.equal(f.steps.length,0);
 }
});
test('candidate ordering prefers primary/documentation hosts, URL/body dedup and successful-source cap apply',async t=>{
 assert.equal(researchUrlKey('https://example.com/a?utm_source=x&b=2&a=1#top'),'https://example.com/a?a=1&b=2');
 assert.equal(sameResearchText(body,' \n'+body.split('').join(' ')),true);
 assert.equal(sameResearchText(body,body.replace('支持导出','不支持导出')),false);
 assert.equal(sameResearchText(body+'版本2',body+'版本3'),false);
 const items=[candidate('https://news.example.com/story'),candidate(),candidate('https://developer.mozilla.org/docs/guide?utm_source=copy'),candidate('https://docs.python.org/3/tutorial/'),candidate('https://w3.org/spec')];
 const ranked=articleResearchCandidates(items);assert.equal(ranked.length,4);assert.equal(ranked[0].domain,'developer.mozilla.org');
 const reads:string[]=[];const f=await fixture({searchResearch:async()=>({query:'x',fetchedAt:'2026-10-10T08:00:00Z',candidates:items}),readResearchSource:async(_actor:string,url:string)=>{reads.push(url);return read(url,body+(url.includes('news')?'':url.repeat(20)));}});t.after(f.close);
 const a=await f.s.createAuto({input:'想写一篇导出文章',requestId:'cap'},'actor');const done=await settled(f.s,a.id);assert.equal(done.automation?.status,'ready');assert.equal(done.sources.length,3);assert.equal(reads.length,3);assert.ok(reads.every(url=>!url.includes('news.example.com')));
 const duplicates=await fixture({searchResearch:async()=>({query:'x',fetchedAt:'2026-10-10T08:00:00Z',candidates:[candidate(),candidate('https://other.example.com/reprint')]} )});t.after(duplicates.close);
 const dup=await duplicates.s.createAuto({input:'想写一篇导出文章',requestId:'dup-body'},'actor');const one=await settled(duplicates.s,dup.id);assert.equal(one.sources.length,1);assert.equal(one.automation?.research?.candidates[1].status,'skipped');
});
test('cancel during search aborts immediately and rejects late results, duplicate clicks do not reserve a second run',async t=>{
 let entered!:()=>void,release!:(x:any)=>void;const started=new Promise<void>(r=>entered=r);let networkSignal:AbortSignal|undefined,calls=0;
 const f=await fixture({searchResearch:async(_actor:string,query:string,signal:AbortSignal)=>{calls++;networkSignal=signal;entered();return new Promise(r=>release=r);}});t.after(f.close);
 const input={input:'想写一篇导出文章',requestId:'cancel-search'};const a=await f.s.createAuto(input,'actor');await started;assert.equal((await f.s.createAuto(input,'actor')).id,a.id);assert.equal(calls,1);
 await assert.rejects(f.s.cancelAuto(a.id,a.automation!.runId,'other'),/自己的/);await f.s.cancelAuto(a.id,a.automation!.runId,'actor');const stopped=await settled(f.s,a.id);assert.equal(stopped.automation?.status,'cancelled');assert.equal(networkSignal?.aborted,true);
 release({query:'x',fetchedAt:'2026-10-10T08:00:00Z',candidates:[candidate()]});await new Promise(r=>setImmediate(r));assert.equal((await f.s.get(a.id)).sources.length,0);assert.equal(f.steps.length,0);
});
test('cancel during reading persists selected candidates; a new service resumes without transient search snapshots',async t=>{
 let entered!:()=>void,release!:(x:any)=>void;const started=new Promise<void>(r=>entered=r);const f=await fixture({readResearchSource:async()=>{entered();return new Promise(r=>release=r);}});t.after(f.close);
 const a=await f.s.createAuto({input:'想写一篇导出文章',requestId:'restart-read'},'actor');await started;await f.s.cancelAuto(a.id,a.automation!.runId,'actor');const stopped=await settled(f.s,a.id);assert.equal(stopped.automation?.research?.candidates.length,1);assert.equal(stopped.sources.length,0);
 release(read(candidate().url));await new Promise(r=>setImmediate(r));assert.equal((await f.s.get(a.id)).sources.length,0);
 const index=await f.deps.storage.readJson<Record<string,ArticleRecord>>('cache/articles.json');index[a.id].automation!.status='running';await f.deps.storage.writeJsonAtomic('cache/articles.json',index);
 const fresh=new ArticleService({...f.deps,searchResearch:async()=>{throw Error('must reuse saved candidates');},readResearchSource:async(_actor:string,url:string)=>read(url)});
 const recovered=await fresh.get(a.id);assert.equal(recovered.automation?.status,'interrupted');await fresh.resumeAuto(a.id,recovered.version,'actor');const done=await settled(fresh,a.id);assert.equal(done.automation?.status,'ready');assert.equal(done.sources[0].url,candidate().url);
});
test('later failure/resume retains searched material and never repeats successful research or overwrites saved draft',async t=>{
 let fail=true;const f=await fixture({illustrate:async()=>{if(fail)throw Error('images unavailable');return{coverAssetId:'cover',bodyImageAssetIds:['image']};}});t.after(f.close);
 const a=await f.s.createAuto({input:'想写一篇导出文章',requestId:'resume-assets'},'actor');const failed=await settled(f.s,a.id);assert.equal(failed.automation?.status,'failed');assert.ok(failed.draft);fail=false;
 await f.s.resumeAuto(a.id,failed.version,'actor');const done=await settled(f.s,a.id);assert.equal(done.automation?.status,'ready');assert.deepEqual(done.draft,failed.draft);assert.equal(f.queries.length,1);assert.equal(f.reads.length,1);
});
test('existing exact-quote validation rejects a fact fabricated from a search summary',async t=>{
 const f=await fixture({writer:{run:async(step:ArticleStep,a:ArticleRecord)=>step==='evidence'?{facts:[{claim:'未核实说法',sourceId:a.sources[0].id,quote:'摘要中的未核实说法'}],issues:[]}:writer().run(step,a)}});t.after(f.close);
 const a=await f.s.createAuto({input:'想写一篇导出文章',requestId:'quote'},'actor');const done=await settled(f.s,a.id);assert.equal(done.automation?.error?.code,'ai_output_invalid');assert.equal(done.facts.length,0);assert.equal(done.draft,undefined);
});
test('empty search results can be searched again on resume instead of remaining permanently stuck',async t=>{
 let searches=0;const f=await fixture({searchResearch:async()=>({query:'public topic',fetchedAt:'2026-10-10T08:00:00Z',candidates:++searches===1?[]:[candidate()]})});t.after(f.close);
 const a=await f.s.createAuto({input:'想写一篇导出文章',requestId:'empty-retry'},'actor');const missing=await settled(f.s,a.id);assert.equal(missing.automation?.status,'needs_input');assert.equal(missing.automation?.research?.candidates.length,0);
 await f.s.resumeAuto(a.id,missing.version,'actor');const done=await settled(f.s,a.id);assert.equal(done.automation?.status,'ready');assert.equal(searches,2);
});
