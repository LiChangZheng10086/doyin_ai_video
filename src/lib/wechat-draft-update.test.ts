import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PublishingService } from './publishing-service.js';
import { PublishingStore } from './publishing-store.js';
import { PublishingAssetService } from './publishing-assets.js';
import { LocalStorage } from './storage.js';
import { WechatMpClient } from './wechat-mp-client.js';
import type { ArticlePackageInput } from './articles.js';
import type { ArticleRecord } from './article-types.js';
import type { DeliveryPackage, PublishTask } from '../types.js';
const actor={userId:'actor',displayName:'操作者',role:'admin' as const};
async function fixture(mode='ok') {
  const root=await mkdtemp(path.join(tmpdir(),'wechat-update-'));const storage=new LocalStorage(root);
  const store=new PublishingStore(storage);await store.init();
  const cover=path.join(root,'cover.jpg');await writeFile(cover,'cover');
  const pkg:DeliveryPackage={id:'pkg',sourceJobId:'article-article',sourceKind:'article',sourceArticleId:'article',version:1,state:'active',title:'原稿',packagePath:root,videoSha256:'empty',videoSize:0,videoMethod:'copy',contentType:'article',assetHealth:'healthy',createdBy:actor,createdAt:'2026-10-10',updatedAt:'2026-10-10'};
  const task:PublishTask={id:'task',packageId:'pkg',platform:'wechat_mp',title:'原稿',description:'',hashtags:[],copySource:'user_edited',status:'ready',contentRevision:1,createdAt:'2026-10-10',updatedAt:'2026-10-10',autoPublish:{status:'succeeded',startedAt:'2026-10-10',attemptId:'created',draftOnly:true,draftMediaId:'original-draft'}};
  await store.reserveVersion(pkg.sourceJobId,actor);await store.commitPackage({package:pkg,tasks:[task]},actor);
  const calls:string[]=[];let submitted:any;let release!:()=>void;let started!:()=>void;
  const signal=new Promise<void>(r=>started=r),waiting=new Promise<void>(r=>release=r);
  const client=new WechatMpClient({appId:'test-app-id',appSecret:'test-secret',fetchImpl:async(url,init)=>{
    const endpoint=new URL(url).pathname;calls.push(endpoint);
    if(endpoint==='/cgi-bin/stable_token')return Response.json({access_token:'test-token',expires_in:7200});
    if(endpoint==='/cgi-bin/material/add_material')return Response.json({media_id:'cover'});
    if(endpoint==='/cgi-bin/draft/update') {submitted=JSON.parse(String(init?.body));started();if(mode==='wait')await waiting;if(mode==='timeout')throw Error('network');return Response.json(mode==='permission'?{errcode:48001,errmsg:'unauthorized'}:{errcode:0,errmsg:'ok'});}
    throw Error('unexpected endpoint');
  }});
  const service=new PublishingService({storageRoot:root,store,jobs:{get:async()=>null},copy:{previewAll:async()=>({copies:{}})} as any,assets:new PublishingAssetService({storageRoot:root}),wechat:async()=>client,wechatMedia:{prepareCoverImage:async(src:string)=>({path:src,bytes:5}),prepareContentImage:async(src:string)=>({path:src,bytes:5})} as any});
  const input:ArticlePackageInput={article:{id:'article',version:3} as ArticleRecord,draft:{title:'新排版',sections:[{heading:'概念',paragraphs:['原事实'],factIds:[]}]},html:'<section><p>原事实</p></section>',cover:{path:cover,record:{kind:'image'}} as any,images:[],hashes:[''],actor};
  const {createHash}=await import('node:crypto');input.hashes=[createHash('sha256').update('cover').digest('hex')];
  return {root,store,service,input,calls,submitted:()=>submitted,signal,release:()=>release()};
}
test('updates existing draft with durable snapshot; stale preview and wrong binding never submit',async t=>{
  const f=await fixture();t.after(()=>rm(f.root,{recursive:true,force:true}));
  const p=await f.service.previewWechatDraftUpdate('task',f.input,'article-preview');
  await assert.rejects(f.service.updateWechatDraft('task',f.input,'article-preview','stale'),/预览/);
  await assert.rejects(f.service.previewWechatDraftUpdate('task',{...f.input,article:{...f.input.article,id:'other'}},'article-preview'),/原文章/);
  assert.equal(f.calls.length,0);
  const result=await f.service.updateWechatDraft('task',f.input,'article-preview',p.previewRevision);
  assert.equal(result.wechatDraftUpdate?.status,'succeeded');assert.equal(result.autoPublish?.draftMediaId,'original-draft');
  assert.equal(result.publishedAt,undefined);assert.equal(f.submitted().media_id,'original-draft');assert.equal(f.submitted().index,0);
  assert.deepEqual(f.calls,['/cgi-bin/stable_token','/cgi-bin/material/add_material','/cgi-bin/draft/update']);
  assert.ok((await readFile(path.join(f.root,result.wechatDraftUpdate!.snapshotPath,'article.html'),'utf8')).includes('原事实'));
  await assert.rejects(f.service.updateWechatDraft('task',f.input,'article-preview',p.previewRevision),/预览/);
  assert.equal((await f.store.getPackage('pkg'))?.package.title,'原稿');
});
test('network uncertainty blocks retries and keeps original draft creation evidence',async t=>{
  const f=await fixture('timeout');t.after(()=>rm(f.root,{recursive:true,force:true}));
  const p=await f.service.previewWechatDraftUpdate('task',f.input,'p');const result=await f.service.updateWechatDraft('task',f.input,'p',p.previewRevision);
  assert.equal(result.wechatDraftUpdate?.status,'failed');assert.equal(result.wechatDraftUpdate?.outcomeUncertain,true);assert.equal(result.autoPublish?.draftMediaId,'original-draft');
  await assert.rejects(f.service.previewWechatDraftUpdate('task',f.input,'p'),/核实/);assert.equal(f.calls.filter(p=>p==='/cgi-bin/draft/update').length,1);
});
test('in-flight updates exclude concurrent submissions and local task mutations',async t=>{
  const f=await fixture('wait');t.after(()=>rm(f.root,{recursive:true,force:true}));
  const p=await f.service.previewWechatDraftUpdate('task',f.input,'p');const operation=f.service.updateWechatDraft('task',f.input,'p',p.previewRevision);await f.signal;
  try {await assert.rejects(f.service.updateWechatDraft('task',f.input,'p',p.previewRevision),/进行/);await assert.rejects(f.store.cancel('task',actor),/进行/);} finally {f.release();await operation;}
  assert.equal(f.calls.filter(p=>p==='/cgi-bin/draft/update').length,1);
});


test('definite API rejection is retryable and a changed image stops before any upload',async t=>{
  const f=await fixture('permission');t.after(()=>rm(f.root,{recursive:true,force:true}));
  const p=await f.service.previewWechatDraftUpdate('task',f.input,'p');
  await assert.rejects(f.service.updateWechatDraft('task',f.input,'p',undefined),/previewRevision/);
  const denied=await f.service.updateWechatDraft('task',f.input,'p',p.previewRevision);
  assert.equal(denied.wechatDraftUpdate?.outcomeUncertain,false);assert.equal(denied.wechatDraftUpdate?.status,'failed');
  const fresh=await f.service.previewWechatDraftUpdate('task',f.input,'p');
  await writeFile(f.input.cover.path,'changed');const before=f.calls.length;
  const failed=await f.service.updateWechatDraft('task',f.input,'p',fresh.previewRevision);
  assert.equal(failed.wechatDraftUpdate?.status,'failed');assert.equal(failed.wechatDraftUpdate?.outcomeUncertain,false);assert.equal(f.calls.length,before);
  assert.equal(failed.autoPublish?.draftMediaId,'original-draft');
});
