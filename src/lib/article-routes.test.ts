import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { createExpressApp } from '../app.js';
import { WechatMpClient } from './wechat-mp-client.js';
import type { ArticleRecord, ArticleStep } from './article-types.js';

export const fakeArticleWriter = { async run(step: ArticleStep,a: ArticleRecord): Promise<any> {
  if (step === 'diagnose') return {topics:[1,2,3].map(n => ({id:`topic-${n}`,title:`方向${n}`,audience:'产品用户',question:'如何使用',thesis:'变化与局限',hook:'周三新增导出',angle:'实用解释',researchQuestions:['离线支持情况']}))};
  if (step === 'evidence') return {facts:[{id:'fact-1',claim:'项目支持导出',sourceId:a.sources[0]!.id,quote:'项目支持导出'}],issues:['离线功能仍未开放']};
  if (step === 'outline') return {thesis:'解释变化',opening:'一次导出',sections:[{heading:'功能与边界',points:['导出开放'],factIds:['fact-1']}],gaps:[]};
  const draft = {title:'项目导出功能如何使用',sections:[{heading:'开放与局限',paragraphs:['项目支持导出，离线编辑仍未开放。'],factIds:['fact-1']}]};
  if (step === 'draft') return draft;
  if (step === 'review') return {revision:draft,notes:['保留离线功能的限制']};
  return {images:[{section:0,purpose:'封面',caption:'导出与离线',prompt:'简洁流程示意图'}]};
} };

export async function articleFixture(options:any={}) {
  const root = await mkdtemp(path.join(tmpdir(),'article-http-')); const calls: string[] = [];
  const app = await createExpressApp({rootDir:process.cwd(),storagePath:root,articleWriter:fakeArticleWriter,
    readArticleSource:async url => ({url,title:'资料',text:'项目支持导出，离线编辑仍未开放。',status:'readable',readAt:new Date().toISOString(),hash:'fake',links:[],truncated:false}),
    wechatClient:new WechatMpClient({appId:'test-app-id',appSecret:'fake-secret',fetchImpl:async url => {
      const p = new URL(url).pathname; calls.push(p);
      return new Response(JSON.stringify(p.endsWith('stable_token') ? {access_token:'example-token',expires_in:7200} : p.endsWith('draft/count') ? {total_count:0} : p.endsWith('add_material') ? {media_id:'cover-id'} : p.endsWith('uploadimg') ? {url:'https://mmbiz.qpic.cn/fake/body.jpg'} : p === '/cgi-bin/draft/update' ? {errcode:0,errmsg:'ok'} : {media_id:'draft-id'}));
    }}),wechatMedia:{prepareCoverImage:async src => ({path:src,bytes:8}),prepareContentImage:async src => ({path:src,bytes:8})},...options,
  });
  const server = createServer(app); await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const session = await (await fetch(`${base}/api/local-sessions/auto`,{method:'POST'})).json() as any;
  const token = session.session?.token ?? session.token;
  const request = async (route: string, method = 'GET', body?: unknown, authorized = true) => {
    const response = await fetch(base+route,{method,headers:{'Content-Type':'application/json',...(authorized ? {'X-Local-Session':token} : {})},...(body === undefined ? {} : {body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json() as any};
  };
  const upload = async () => { const form = new FormData(); form.append('files',new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII=','base64')],{type:'image/png'}),'cover.png'); const res = await fetch(base+'/api/assets/images',{method:'POST',headers:{'X-Local-Session':token},body:form}); const data = await res.json() as any; assert.equal(res.status,201,JSON.stringify(data)); return data.assets[0].id as string; };
  return {root,base,request,upload,calls,token,close:async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root,{recursive:true,force:true}); }};
}

test('independent article HTTP workflow builds an immutable package and submits only a WeChat draft',async () => {
  const f = await articleFixture();
  try {
    assert.equal((await f.request('/api/articles','POST',{keyword:'导出'},false)).status,401);
    let response = await f.request('/api/articles','POST',{keyword:'导出'}); assert.equal(response.status,201,JSON.stringify(response.body)); let a = response.body.article as ArticleRecord;
    const patch = async (p: any) => { const r = await f.request(`/api/articles/${a.id}`,'PATCH',{version:a.version,...p}); assert.equal(r.status,200,JSON.stringify(r.body)); a = r.body.article; };
    const run = async (step: ArticleStep) => { const r = await f.request(`/api/articles/${a.id}/steps/${step}`,'POST',{version:a.version}); assert.equal(r.status,200,JSON.stringify(r.body)); a = r.body.article; };
    const old = a.version; await run('diagnose');
    assert.equal((await f.request(`/api/articles/${a.id}`,'PATCH',{version:old,keyword:'旧版本'})).status,409);
    await patch({selectedTopic:'topic-1'});
    assert.equal((await f.request(`/api/articles/${a.id}/steps/evidence`,'POST',{version:a.version})).status,422);
    await patch({addText:{title:'项目说明',text:'项目支持导出，离线编辑仍未开放。'}});
    await run('evidence'); await patch({materialConfirmed:true}); await run('outline'); await patch({outlineConfirmed:true}); await run('draft'); await run('review'); await patch({reviewed:true}); await run('illustrations');
    const image = await f.upload(); await patch({coverAssetId:image,bodyImageAssetIds:[image]});
    let preview = await f.request(`/api/articles/${a.id}/publishing/preview`,'POST',{version:a.version}); assert.equal(preview.status,200,JSON.stringify(preview.body));
    const revision = preview.body.preview.previewRevision;
    await patch({author:'作者'});
    assert.equal((await f.request(`/api/articles/${a.id}/publishing/packages`,'POST',{version:a.version,previewRevision:revision})).status,409);
    preview = await f.request(`/api/articles/${a.id}/publishing/preview`,'POST',{version:a.version});
    const beforeLayout = preview.body.preview.previewRevision;
    await patch({layoutTemplate:'business-brief'});
    assert.equal((await f.request(`/api/articles/${a.id}/publishing/packages`,'POST',{version:a.version,previewRevision:beforeLayout})).status,409);
    preview = await f.request(`/api/articles/${a.id}/publishing/preview`,'POST',{version:a.version});
    assert.ok(preview.body.preview.html.includes('background-color:#1e40af'));
    const pkg = await f.request(`/api/articles/${a.id}/publishing/packages`,'POST',{version:a.version,previewRevision:preview.body.preview.previewRevision});
    assert.equal(pkg.status,201,JSON.stringify(pkg.body)); const detail = pkg.body.detail;
    assert.equal(detail.package.sourceKind,'article'); assert.equal(detail.package.sourceArticleId,a.id); assert.equal(detail.package.videoPath,undefined); assert.equal(detail.package.imagePaths.length,1);
    a = (await f.request(`/api/articles/${a.id}`)).body.article;
    assert.equal((await f.request(`/api/articles/${a.id}`,'DELETE',{version:a.version})).status,200);
    const pp = await f.request(`/api/publishing/packages/${detail.package.id}/preview`); assert.equal(pp.status,200);
    assert.equal((await fetch(f.base+`/api/publishing/packages/${detail.package.id}/article`,{headers:{'X-Local-Session':f.token}})).status,200);
    const submitted = await f.request(`/api/publishing/tasks/${detail.tasks[0].id}/auto-publish`,'POST',{previewRevision:pp.body.preview.previewRevision}); assert.equal(submitted.status,200,JSON.stringify(submitted.body));
    assert.ok(f.calls.includes('/cgi-bin/draft/add')); assert.ok(!f.calls.some(p => /freepublish|mass/.test(p)));
    assert.equal((await f.request('/api/jobs')).body.jobs.length,0);
  } finally { await f.close(); }
});

test('automatic HTTP creation stops at an editable illustrated preview; only explicit confirmation saves one WeChat draft',async t=>{
 let image='';const f=await articleFixture({articleIllustrator:{generate:async()=>({coverAssetId:image,bodyImageAssetIds:[image],bodyImagePlacements:[{section:0,caption:'隔离示意图'}]})}});t.after(f.close);image=await f.upload();
 assert.equal((await f.request('/api/articles/auto','POST',{input:'资料',requestId:'no-auth'},false)).status,401);
 assert.equal((await f.request('/api/articles/capabilities')).body.aiReady,true);
 const input={input:'项目支持导出，离线编辑仍未开放。'.repeat(10),requestId:'auto-http-1'};
 const start=await f.request('/api/articles/auto','POST',input);assert.equal(start.status,202,JSON.stringify(start.body));let a=start.body.article;
 for(let i=0;i<200;i++){a=(await f.request(`/api/articles/${a.id}`)).body.article;if(!['queued','running','cancelling'].includes(a.automation.status))break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(a.automation.status,'ready',JSON.stringify(a));assert.equal(a.reviewed,false);assert.equal(a.bodyImageAssetIds.length,1);assert.equal(f.calls.length,0);
 assert.equal((await f.request('/api/articles/auto','POST',input)).body.article.id,a.id);
 const layout=await f.request(`/api/articles/${a.id}/layout-preview`,'POST',{version:a.version});assert.equal(layout.status,200);
 a=(await f.request(`/api/articles/${a.id}`,'PATCH',{version:a.version,materialConfirmed:true,outlineConfirmed:true,reviewed:true})).body.article;
 const preview=(await f.request(`/api/articles/${a.id}/publishing/preview`,'POST',{version:a.version})).body.preview;
 const endpoint=`/api/articles/${a.id}/wechat-drafts`;
 assert.equal((await f.request(endpoint,'POST',{version:a.version,previewRevision:preview.previewRevision,confirmed:false})).status,400);assert.equal(f.calls.length,0);
 assert.equal((await f.request(endpoint,'POST',{version:a.version,previewRevision:preview.previewRevision,confirmed:true},false)).status,401);
 const result=await f.request(endpoint,'POST',{version:a.version,previewRevision:preview.previewRevision,confirmed:true});assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.article.wechatDelivery.state,'succeeded');assert.equal(result.body.task.publishedAt,undefined);
 a=result.body.article;const current=(await f.request(`/api/articles/${a.id}/publishing/preview`,'POST',{version:a.version})).body.preview;
 assert.equal((await f.request(endpoint,'POST',{version:a.version,previewRevision:current.previewRevision,confirmed:true})).status,200);
 assert.equal(f.calls.filter(p=>p==='/cgi-bin/draft/add').length,1);assert.ok(f.calls.every(p=>!/mass|freepublish|draft\/update/.test(p)));
});

test('benchmark routes require sessions and only qualified references enter an independent article',async t=>{
  const f=await articleFixture();t.after(f.close);
  const input={name:'用户自由选择的领域',audience:'用户定义的读者',keywords:['教程'],minReads:1000};
  assert.equal((await f.request('/api/wechat-benchmarks','POST',input,false)).status,401);
  assert.equal((await f.request('/api/wechat-benchmarks/search','POST',{keyword:'教程'},false)).status,401);
  const created=await f.request('/api/wechat-benchmarks','POST',input);assert.equal(created.status,201);let g=created.body.group;
  assert.equal((await f.request('/api/articles','POST',{keyword:'自己的选题',benchmarkId:g.id})).status,422);
  for(let i=0;i<10;i++){
    const updated=await f.request(`/api/wechat-benchmarks/${g.id}`,'PATCH',{version:g.version,addAccount:{name:`示例账号${i}`,identity:`verified-${i}`,identityConfirmed:true,relevant:true,selected:true,notes:'先说明问题再给步骤',samples:[{title:'教程标题',url:`https://mp.weixin.qq.com/s/example-${i}`,dateText:'',reads:1500,lowerBound:false,metricSource:'用户提供的文章阅读记录',measuredAt:'2026-09-30T01:00:00Z'}]}});
    assert.equal(updated.status,200,JSON.stringify(updated.body));g=updated.body.group;
  }
  assert.equal(g.assessment.qualifiedCount,10);
  const article=await f.request('/api/articles','POST',{keyword:'自己的选题',benchmarkId:g.id});assert.equal(article.status,201,JSON.stringify(article.body));
  assert.equal(article.body.article.requirements.domain,input.name);assert.equal(article.body.article.sources.length,0);assert.ok(article.body.article.requirements.styleSample.includes('示例账号9'));
  assert.equal((await f.request(`/api/wechat-benchmarks/${g.id}`,'DELETE',{version:g.version-1})).status,409);
  assert.equal((await f.request(`/api/wechat-benchmarks/${g.id}`,'DELETE',{version:g.version})).status,200);
  assert.equal((await f.request('/api/wechat-benchmarks')).body.groups.length,0);
});


test('existing draft update route requires auth and current article preview, preserves original package and media ID',async t=>{
  const f=await articleFixture();t.after(f.close);
  let a=(await f.request('/api/articles','POST',{keyword:'测试稿'})).body.article;
  const patch=async(p:any)=>{const r=await f.request(`/api/articles/${a.id}`,'PATCH',{version:a.version,...p});assert.equal(r.status,200,JSON.stringify(r.body));a=r.body.article;};
  const run=async(step:string)=>{const r=await f.request(`/api/articles/${a.id}/steps/${step}`,'POST',{version:a.version});assert.equal(r.status,200,JSON.stringify(r.body));a=r.body.article;};
  await run('diagnose');await patch({selectedTopic:'topic-1',addText:{title:'说明',text:'项目支持导出，离线编辑仍未开放。'}});
  await run('evidence');await patch({materialConfirmed:true});await run('outline');await patch({outlineConfirmed:true});await run('draft');await run('review');await patch({reviewed:true});await run('illustrations');
  const image=await f.upload();await patch({coverAssetId:image,bodyImageAssetIds:[image]});
  const p=(await f.request(`/api/articles/${a.id}/publishing/preview`,'POST',{version:a.version})).body.preview;
  const detail=(await f.request(`/api/articles/${a.id}/publishing/packages`,'POST',{version:a.version,previewRevision:p.previewRevision})).body.detail;
  const taskId=detail.tasks[0].id;
  const pp=(await f.request(`/api/publishing/packages/${detail.package.id}/preview`)).body.preview;
  assert.equal((await f.request(`/api/publishing/tasks/${taskId}/auto-publish`,'POST',{previewRevision:pp.previewRevision})).status,200);
  a=(await f.request(`/api/articles/${a.id}`)).body.article;
  await patch({layoutTemplate:'business-brief',bodyImagePlacements:[{section:0,caption:'功能示意'}]});
  const endpoint=`/api/articles/${a.id}/wechat-drafts/${taskId}`;
  assert.equal((await f.request(endpoint+'/preview','POST',{version:a.version},false)).status,401);
  const preview=await f.request(endpoint+'/preview','POST',{version:a.version});assert.equal(preview.status,200,JSON.stringify(preview.body));
  assert.equal(preview.body.preview.mediaId,'draft-id');assert.ok(preview.body.preview.html.includes('font-size:13px'));
  assert.equal((await f.request(endpoint+'/update','POST',{version:a.version,previewRevision:preview.body.preview.previewRevision},false)).status,401);
  assert.equal((await f.request(endpoint+'/update','POST',{version:a.version-1,previewRevision:preview.body.preview.previewRevision})).status,409);
  assert.equal((await f.request(endpoint+'/update','POST',{version:a.version})).status,400);
  assert.equal((await f.request(endpoint+'/update','POST',{version:a.version,previewRevision:'old'})).status,409);
  await patch({digest:'新摘要'});
  assert.equal((await f.request(endpoint+'/update','POST',{version:a.version,previewRevision:preview.body.preview.previewRevision})).status,409);
  const fresh=(await f.request(endpoint+'/preview','POST',{version:a.version})).body.preview;
  const result=await f.request(endpoint+'/update','POST',{version:a.version,previewRevision:fresh.previewRevision});
  assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.task.wechatDraftUpdate.status,'succeeded');assert.equal(result.body.task.autoPublish.draftMediaId,'draft-id');
  assert.equal(result.body.task.publishedAt,undefined);
  assert.equal((await f.request(endpoint+'/update','POST',{version:a.version,previewRevision:fresh.previewRevision})).status,409);
  assert.equal(f.calls.filter(p=>p==='/cgi-bin/draft/add').length,1);assert.equal(f.calls.filter(p=>p==='/cgi-bin/draft/update').length,1);assert.ok(f.calls.every(p=>!/freepublish|mass/.test(p)));
  assert.equal((await f.request(`/api/publishing/packages/${detail.package.id}/preview`)).body.preview.previewRevision,pp.previewRevision);
});


test('layout preview is read-only and defaults affect only future articles with guarded settings',async t=>{
 const f=await articleFixture();t.after(f.close);
 assert.equal((await f.request('/api/articles/layout-defaults','GET',undefined,false)).status,401);
 const defaults=(await f.request('/api/articles/layout-defaults')).body.defaults;
 let a=(await f.request('/api/articles','POST',{keyword:'真实文章预览'})).body.article;
 const patch=async(p:any)=>{const r=await f.request(`/api/articles/${a.id}`,'PATCH',{version:a.version,...p});assert.equal(r.status,200,JSON.stringify(r.body));a=r.body.article;};
 const run=async(step:string)=>{const r=await f.request(`/api/articles/${a.id}/steps/${step}`,'POST',{version:a.version});assert.equal(r.status,200,JSON.stringify(r.body));a=r.body.article;};
 await run('diagnose');await patch({selectedTopic:'topic-1',addText:{title:'资料',text:'项目支持导出，离线编辑仍未开放。'}});await run('evidence');await patch({materialConfirmed:true});await run('outline');await patch({outlineConfirmed:true});await run('draft');
 await patch({layoutTemplate:'minimal-read'});assert.equal(a.layoutVersion,undefined);
 const before=structuredClone(a);
 const endpoint=`/api/articles/${a.id}/layout-preview`;
 const preview=await f.request(endpoint,'POST',{version:a.version,layoutTemplate:'practical-guide',layoutVersion:2,layoutOptions:{fontSize:18,lineHeight:2,themeColor:'#087f72'}});
 assert.equal(preview.status,200,JSON.stringify(preview.body));assert.ok(preview.body.preview.html.includes('项目支持导出'));assert.ok(preview.body.preview.html.includes('font-size:18px'));
 assert.deepEqual((await f.request(`/api/articles/${a.id}`)).body.article,before);assert.equal(f.calls.length,0);
 assert.equal((await f.request(endpoint,'POST',{version:a.version-1,layoutTemplate:'tech-explainer'})).status,409);
 assert.equal((await f.request(endpoint,'POST',{version:a.version,layoutTemplate:'tech-explainer',layoutOptions:{themeColor:'evil'}})).status,422);
 assert.equal((await f.request('/api/articles/layout-defaults','PUT',{version:defaults.version,layoutTemplate:'deep-reading',layoutOptions:{fontSize:17}},false)).status,401);
 const saved=await f.request('/api/articles/layout-defaults','PUT',{version:defaults.version,layoutTemplate:'deep-reading',layoutOptions:{fontSize:17}});assert.equal(saved.status,200);
 const next=(await f.request('/api/articles','POST',{keyword:'新文章'})).body.article;assert.equal(next.layoutTemplate,'deep-reading');assert.equal(next.layoutVersion,2);
 assert.deepEqual((await f.request(`/api/articles/${a.id}`)).body.article,before);
 assert.equal((await f.request('/api/articles/layout-defaults','PUT',{version:defaults.version,reset:true})).status,409);
 const reset=await f.request('/api/articles/layout-defaults','PUT',{version:saved.body.defaults.version,reset:true});assert.equal(reset.body.defaults.layoutTemplate,'tech-explainer');
 assert.equal(f.calls.length,0);
});
