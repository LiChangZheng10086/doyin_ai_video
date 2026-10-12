import assert from 'node:assert/strict';
import { test } from 'node:test';
import { articleFixture, fakeArticleWriter } from './article-routes.test.js';

test('default automatic articles wait for external images and resume without rewriting a cover-only article',async t=>{
  const f=await articleFixture();t.after(f.close);
  const first=await f.request('/api/articles/auto','POST',{input:'项目支持导出，离线编辑仍未开放。'.repeat(15),requestId:'external-images'});
  let a=first.body.article;
  const settle=async()=>{for(let i=0;i<300;i++){a=(await f.request(`/api/articles/${a.id}`)).body.article;if(!['queued','running','cancelling'].includes(a.automation.status))return;await new Promise(r=>setTimeout(r,5));}throw new Error('automatic run did not settle');};
  await settle();assert.equal(a.automation.status,'needs_input');assert.equal(a.automation.error.code,'images_required');assert.ok(a.revision);assert.equal(a.coverAssetId,'');
  assert.equal((await f.request('/api/assets?kind=image')).body.assets.length,0);
  const savedRevision=structuredClone(a.revision),runId=a.automation.runId;
  const assetId=await f.upload();
  a=(await f.request(`/api/articles/${a.id}`,'PATCH',{version:a.version,coverAssetId:assetId})).body.article;
  assert.equal((await f.request(`/api/articles/${a.id}/automation/resume`,'POST',{version:a.version})).status,202);
  await settle();assert.equal(a.automation.status,'ready');assert.notEqual(a.automation.runId,runId);assert.deepEqual(a.revision,savedRevision);assert.deepEqual(a.bodyImageAssetIds,[]);assert.equal(f.calls.length,0);
});

test('article prompts accept uploaded snapshots at their planned positions and reject stale or mismatched bindings', async t => {
  const f = await articleFixture({ articleWriter: { run: async (step: any, a: any) => step === 'illustrations'
    ? { images: [{section:0,purpose:'封面',caption:'封面',prompt:'路灯与空街'}, {section:1,purpose:'正文',caption:'街道示意',prompt:'雨中的街道'}, {section:1,purpose:'正文细节',caption:'路面示意',prompt:'路面的雨水'}] }
    : fakeArticleWriter.run(step,a) } });
  t.after(f.close);
  let a = (await f.request('/api/articles','POST',{keyword:'导出'})).body.article;
  a = (await f.request(`/api/articles/${a.id}`,'PATCH',{version:a.version,addText:{title:'资料',text:'项目支持导出，离线编辑仍未开放。'}})).body.article;
  for (const step of ['diagnose','evidence','outline','draft','review','illustrations']) {
    a = (await f.request(`/api/articles/${a.id}/steps/${step}`,'POST',{version:a.version})).body.article;
    if (step==='diagnose') a = (await f.request(`/api/articles/${a.id}`,'PATCH',{version:a.version,selectedTopic:a.topics[0].id})).body.article;
    if (step==='evidence'||step==='outline'||step==='review') a = (await f.request(`/api/articles/${a.id}`,'PATCH',{version:a.version,[step==='evidence'?'materialConfirmed':step==='outline'?'outlineConfirmed':'reviewed']:true})).body.article;
  }
  const upload = async (prompt:string) => {
    const form = new FormData();
    form.append('files',new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII=','base64')],{type:'image/png'}),'街道.png');
    form.append('metadata',JSON.stringify([{description:'真实上传的街道插画',generationPrompt:prompt,tags:['街道']}]));
    const response = await fetch(f.base+'/api/assets/images',{method:'POST',headers:{'X-Local-Session':f.token},body:form});
    assert.equal(response.status,201);return (await response.json() as any).assets[0];
  };
  const cover = await upload('路灯与空街'), body = await upload('雨中的街道');
  const bind = (index:number,assetId:string,version=a.version,auth=true) => f.request(`/api/articles/${a.id}/illustrations/${index}/asset`,'POST',{version,assetId},auth);
  assert.equal((await bind(0,cover.id,a.version,false)).status,401);
  assert.equal((await bind(0,body.id)).status,422);
  const first = await bind(0,cover.id);assert.equal(first.status,200,JSON.stringify(first.body));a=first.body.article;
  assert.equal(a.coverAssetId,cover.id);assert.equal(a.illustrations[0].assetId,cover.id);
  assert.equal((await bind(1,body.id,a.version-1)).status,409);
  a=(await bind(1,body.id)).body.article;
  assert.deepEqual(a.bodyImageAssetIds,[body.id]);assert.deepEqual(a.bodyImagePlacements,[{section:0,caption:'街道示意'}]);
  const replacement=await upload('雨中的街道');a=(await bind(1,replacement.id)).body.article;
  assert.deepEqual(a.bodyImageAssetIds,[replacement.id]);
  assert.equal((await f.request('/api/assets?kind=image')).body.assets.length,3);
  assert.equal((await f.request(`/api/articles/${a.id}/publishing/preview`,'POST',{version:a.version})).status,422);
  const detail=await upload('路面的雨水');a=(await bind(2,detail.id)).body.article;
  const preview=await f.request(`/api/articles/${a.id}/publishing/preview`,'POST',{version:a.version});assert.equal(preview.status,200);assert.ok(preview.body.preview.html.includes('{{wechat-image-1}}'));
  a=(await f.request(`/api/articles/${a.id}`,'PATCH',{version:a.version,revision:a.revision})).body.article;
  assert.equal(a.coverAssetId,'');assert.deepEqual(a.bodyImageAssetIds,[]);
  assert.equal((await f.request('/api/assets?kind=image')).body.assets.length,4);
  assert.equal((await bind(1,replacement.id)).status,422);
  assert.equal(f.calls.length,0);
});
