import assert from 'node:assert/strict';import {test} from 'node:test';import {mkdtemp,rm,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {ArticleService} from './articles.js';import {LocalStorage} from './storage.js';import type {ArticleRecord,ArticleStep} from './article-types.js';
const body='项目支持导出，离线编辑仍未开放。'.repeat(20);
function writer(){return {async run(step:ArticleStep,a:ArticleRecord){if(step==='diagnose')return{topics:[1,2,3].map(n=>({id:'topic-'+n,title:'方向'+n,audience:'读者',question:'如何理解',thesis:'解释限制',hook:'导出功能',angle:'解释',researchQuestions:[]}))};if(step==='evidence')return{facts:[{id:'fact-1',claim:'支持导出',quote:'项目支持导出',sourceId:a.sources.find(s=>s.included&&s.status==='readable')!.id}],issues:['离线仍未开放']};if(step==='outline')return{thesis:'说明导出',opening:'概念与用途',sections:[{heading:'功能与限制',points:['保留限制'],factIds:['fact-1']}],gaps:[]};const draft={title:'导出功能与离线限制',sections:[{heading:'功能与限制',paragraphs:['项目支持导出，离线编辑仍未开放。'],factIds:['fact-1']}]};if(step==='draft')return draft;if(step==='review')return{revision:draft,notes:['保留限制']};return{images:[{section:0,purpose:'封面',caption:'示意图',prompt:'导出示意'}]};}};}
async function fixture(overrides:any={}){const root=await mkdtemp(path.join(tmpdir(),'article-auto-'));const calls:string[]=[];const s=new ArticleService({storage:new LocalStorage(root),writer:{run:async(...args:Parameters<ReturnType<typeof writer>['run']>)=>{calls.push(args[0]);return writer().run(...args);}},checkAi:async()=>true,illustrate:async()=>({coverAssetId:'cover',bodyImageAssetIds:['body'],bodyImagePlacements:[{section:0,caption:'示意图'}]}),...overrides});return{s,root,calls,close:()=>rm(root,{recursive:true,force:true})};}
async function settled(s:ArticleService,id:string){for(let i=0;i<300;i++){const a=await s.get(id);if(a.automation&&!['queued','running','cancelling'].includes(a.automation.status))return a;await new Promise(r=>setTimeout(r,5));}throw new Error('auto did not settle');}
test('automatic creation runs the workflow once, saves checkpoints and stops at preview without pretending human review',async t=>{
 const f=await fixture();t.after(f.close);const input={input:body,requestId:'request-1'};const a=await f.s.createAuto(input,'actor');const done=await settled(f.s,a.id);assert.equal(done.automation?.status,'ready');assert.ok(done.revision);assert.equal(done.reviewed,false);assert.equal(done.materialConfirmed,false);assert.equal(done.outlineConfirmed,false);assert.equal(done.coverAssetId,'cover');assert.equal(done.bodyImageAssetIds.length,1);assert.deepEqual(f.calls,['diagnose','evidence','outline','draft','review','illustrations']);
 const duplicate=await f.s.createAuto(input,'actor');assert.equal(duplicate.id,a.id);assert.equal(f.calls.length,6);
 await assert.rejects(f.s.createAuto({...input,input:'另一个资料'},'actor'),/重复|不同/);
});
test('failed automatic stage resumes without rerunning successful stages or losing the draft',async t=>{
 let fail=true;const calls:string[]=[];const f=await fixture({writer:{run:async(step:ArticleStep,a:ArticleRecord)=>{calls.push(step);if(step==='review'&&fail)throw new Error('upstream');return writer().run(step,a);}}});t.after(f.close);
 const a=await f.s.createAuto({input:body,requestId:'failure-1'},'actor');const failed=await settled(f.s,a.id);assert.equal(failed.automation?.status,'failed');assert.ok(failed.draft);fail=false;
 await f.s.resumeAuto(a.id,failed.version);const done=await settled(f.s,a.id);assert.equal(done.automation?.status,'ready');assert.equal(calls.filter(x=>x==='draft').length,1);assert.deepEqual(done.draft,failed.draft);
});
test('cancellation rejects concurrent operations and discards late AI results before permitting resume',async t=>{
 let release!:()=>void;let started!:()=>void;const entered=new Promise<void>(r=>started=r),pending=new Promise<void>(r=>release=r);let wait=true;
 const f=await fixture({writer:{run:async(step:ArticleStep,a:ArticleRecord)=>{if(step==='draft'&&wait){started();await pending;}return writer().run(step,a);}}});t.after(f.close);
 const a=await f.s.createAuto({input:body,requestId:'cancel-1'},'actor');await entered;const current=await f.s.get(a.id);
 await assert.rejects(f.s.update(a.id,{version:current.version,digest:'并发'}),/正在/);await assert.rejects(f.s.remove(a.id,current.version),/正在/);await assert.rejects(f.s.resumeAuto(a.id,current.version),/正在/);
 await assert.rejects(f.s.cancelAuto(a.id,'stale-run'),/变化|无效/);await f.s.cancelAuto(a.id,current.automation!.runId);assert.equal((await f.s.get(a.id)).automation?.status,'cancelling');release();const cancelled=await settled(f.s,a.id);assert.equal(cancelled.automation?.status,'cancelled');assert.equal(cancelled.draft,undefined);assert.ok(cancelled.outline);
 wait=false;await f.s.resumeAuto(a.id,cancelled.version);assert.equal((await settled(f.s,a.id)).automation?.status,'ready');
});
test('unreadable links and absent configuration stop with actionable errors without creating prose',async t=>{
 const f=await fixture({readSource:async(url:string)=>({url,title:'受限页面',text:'',status:'needs_material',hash:'',readAt:new Date().toISOString(),links:[],truncated:false,error:'需要登录，无法取得正文'})});t.after(f.close);
 const a=await f.s.createAuto({input:'https://example.com/restricted',requestId:'read-1'},'actor');const blocked=await settled(f.s,a.id);assert.equal(blocked.automation?.status,'needs_input');assert.ok(blocked.automation?.error?.message.includes('正文'));assert.equal(blocked.draft,undefined);assert.equal(f.calls.length,0);
 let fixed=await f.s.update(a.id,{version:blocked.version,sourceEdits:[{id:blocked.sources[0].id,included:false}],addText:{title:'补充正文',text:body}});await f.s.resumeAuto(a.id,fixed.version);assert.equal((await settled(f.s,a.id)).automation?.status,'ready');
 const no=await fixture({checkAi:async()=>false});t.after(no.close);const missing=await no.s.createAuto({input:body,requestId:'missing-1'},'actor');const m=await settled(no.s,missing.id);assert.equal(m.automation?.error?.code,'ai_missing');assert.equal(m.input?.raw,body);assert.equal(no.calls.length,0);
});
test('restart marks an automatic reservation interrupted and preserves complete input and previous content',async t=>{
 const f=await fixture();t.after(f.close);const a=await f.s.createAuto({input:body,requestId:'restart-1'},'actor');const done=await settled(f.s,a.id);
 const st=new LocalStorage(f.root);const index=await st.readJson<Record<string,ArticleRecord>>('cache/articles.json');index[a.id].automation!.status='running';index[a.id].running='review';await st.writeJsonAtomic('cache/articles.json',index);
 const fresh=new ArticleService({storage:st,writer:writer()});const recovered=await fresh.get(a.id);assert.equal(recovered.automation?.status,'interrupted');assert.deepEqual(recovered.revision,done.revision);assert.equal(recovered.input?.raw,body);
});

test('manual images recover failed automatic illustrations without invoking or replacing them',async t=>{
 let imageCalls=0;const f=await fixture({illustrate:async()=>{imageCalls++;throw new Error('renderer unavailable');},resolveAsset:async(id:string)=>({record:{id,kind:'image'},path:'/fixture/'+id})});t.after(f.close);
 const first=await f.s.createAuto({input:body,requestId:'manual-images'},'actor');const failed=await settled(f.s,first.id);assert.equal(failed.automation?.error?.code,'asset_failed');
 const selected=await f.s.update(first.id,{version:failed.version,coverAssetId:'manual-cover',bodyImageAssetIds:['manual-body']});await f.s.resumeAuto(first.id,selected.version);const done=await settled(f.s,first.id);assert.equal(done.automation?.status,'ready');assert.equal(imageCalls,1);assert.equal(done.coverAssetId,'manual-cover');assert.deepEqual(done.bodyImageAssetIds,['manual-body']);
});

test('automatic hotspot creation keeps the resolved source and reads it before writing',async t=>{
 const f=await fixture({resolveHotspot:async()=>({title:'公开热点',url:'https://example.com/story'}),readSource:async(url:string)=>({url,title:'热点正文',text:body,status:'readable',hash:'fixture',readAt:new Date().toISOString(),links:[],truncated:false})});t.after(f.close);
 const a=await f.s.createAuto({input:'公开热点',requestId:'hotspot-auto',hotspot:{sourceId:'fixture',itemId:'story'}},'actor');const done=await settled(f.s,a.id);assert.equal(done.automation?.status,'ready');assert.equal(done.hotspot?.title,'公开热点');assert.equal(done.sources[0].url,'https://example.com/story');
});

for(const mode of ['uncertain','preparing'] as const)test(`interrupted WeChat ${mode} never permits a duplicate draft request`,async t=>{
 let submissions=0,packages=0;const actor:any={id:'actor',name:'fixture',role:'admin'};
 const f=await fixture({verifyWechat:async()=>({ok:true}),getWechatTask:async()=>undefined,createPackage:async()=>{packages++;if(mode==='preparing')throw new Error('package interrupted');return{package:{id:'package'},tasks:[{id:'task',platform:'wechat_mp'}]};},submitWechat:async()=>{submissions++;throw new Error('connection interrupted');}});t.after(f.close);
 const img=path.join(f.root,'fixture.png');await writeFile(img,'fixture');(f.s as any).deps.resolveAsset=async()=>({path:img,record:{kind:'image'}});
 const initial=await f.s.createAuto({input:body,requestId:mode},'actor');let a=await settled(f.s,initial.id);a=await f.s.update(a.id,{version:a.version,materialConfirmed:true,outlineConfirmed:true,reviewed:true});let p=await f.s.preview(a.id,a.version);
 await assert.rejects(f.s.saveWechatDraft(a.id,a.version,p.previewRevision,true,actor),/interrupted/);a=await f.s.get(a.id);assert.equal(a.wechatDelivery?.state,mode);p=await f.s.preview(a.id,a.version);
 await assert.rejects(f.s.saveWechatDraft(a.id,a.version,p.previewRevision,true,actor),/核实|核对|重复/);assert.equal(packages,1);assert.equal(submissions,mode==='uncertain'?1:0);
});

test('cancellation after image creation cleans uncommitted generated assets and leaves prior content intact',async t=>{
 let service:ArticleService;const removed:string[][]=[];const f=await fixture({illustrate:async(a:ArticleRecord)=>{await service.cancelAuto(a.id,a.automation!.runId);return{coverAssetId:'uncommitted-cover',bodyImageAssetIds:['uncommitted-body']};},discardIllustrations:async(ids:string[])=>removed.push(ids)});service=f.s;t.after(f.close);
 const a=await service.createAuto({input:body,requestId:'cancel-images'},'actor');const stopped=await settled(service,a.id);assert.equal(stopped.automation?.status,'cancelled');assert.ok(stopped.revision);assert.equal(stopped.coverAssetId,'');assert.deepEqual(removed,[['uncommitted-cover','uncommitted-body']]);
});

test('deleted manually selected assets cannot turn a failed run into a misleading ready preview',async t=>{
 let valid=true;const f=await fixture({illustrate:async()=>{throw new Error('renderer unavailable');},resolveAsset:async(id:string)=>valid?{record:{id,kind:'image'},path:'/fixture/'+id}:null});t.after(f.close);
 const initial=await f.s.createAuto({input:body,requestId:'deleted-images'},'actor');const failed=await settled(f.s,initial.id);const chosen=await f.s.update(initial.id,{version:failed.version,coverAssetId:'selected-cover',bodyImageAssetIds:['selected-body']});valid=false;await f.s.resumeAuto(initial.id,chosen.version);const done=await settled(f.s,initial.id);assert.equal(done.automation?.status,'failed');assert.equal(done.automation?.error?.code,'asset_failed');assert.equal(done.coverAssetId,'selected-cover');assert.ok(done.revision);
});
