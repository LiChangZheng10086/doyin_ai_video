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

export async function articleFixture() {
  const root = await mkdtemp(path.join(tmpdir(),'article-http-')); const calls: string[] = [];
  const app = await createExpressApp({rootDir:process.cwd(),storagePath:root,articleWriter:fakeArticleWriter,
    readArticleSource:async url => ({url,title:'资料',text:'项目支持导出，离线编辑仍未开放。',status:'readable',readAt:new Date().toISOString(),hash:'fake',links:[],truncated:false}),
    wechatClient:new WechatMpClient({appId:'test-app-id',appSecret:'fake-secret',fetchImpl:async url => {
      const p = new URL(url).pathname; calls.push(p);
      return new Response(JSON.stringify(p.endsWith('stable_token') ? {access_token:'example-token',expires_in:7200} : p.endsWith('add_material') ? {media_id:'cover-id'} : p.endsWith('uploadimg') ? {url:'https://mmbiz.qpic.cn/fake/body.jpg'} : {media_id:'draft-id'}));
    }}),wechatMedia:{prepareCoverImage:async src => ({path:src,bytes:8}),prepareContentImage:async src => ({path:src,bytes:8})},
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
