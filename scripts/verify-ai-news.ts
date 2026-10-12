/** Isolated acceptance: --serve provides synthetic UI; default checks real official RSS and original body import. */
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createExpressApp } from '../src/app.js';
import { LocalStorage } from '../src/lib/storage.js';
import { HotspotService } from '../src/lib/hotspots.js';
import { HOTSPOT_SOURCES, fetchHotspotSource } from '../src/lib/hotspot-sources.js';
import { ResearchService } from '../src/lib/research-service.js';
import { parseResearchContent } from '../src/lib/research-content.js';

const serve = process.argv.includes('--serve');
const root = await mkdtemp(path.join(tmpdir(), 'ai-news-qa-'));
const storage = new LocalStorage(root); const now = new Date().toISOString();
let close: (() => Promise<void>) | undefined;
try {
  for (const source of HOTSPOT_SOURCES) {
    const news = 'category' in source;
    const live = async () => {
      for (let attempt=1;;attempt++) try {return await fetchHotspotSource(source.id);} catch(error) {if(attempt===3)throw error;console.log(JSON.stringify({source:source.id,retry:attempt,error:(error as Error).message}));}
    };
    let error: string | undefined;
    const items = !serve && news ? await live().catch(reason=>{error=(reason as Error).message;return [];}) : Array.from({length:15}, (_,index) => ({
      sourceId:source.id,itemId:news?`${source.home}qa-${index}`:String(index),title:`隔离验收选题 ${index} · ${source.name}`,
      url:news?`${source.home}qa-${index}`:source.home,rank:index+1,summary:'隔离验收摘要，仅供参考，不能作为已读取正文。',
      ...(news?{publishedAt:'2026-10-10T10:00:00.000Z'}:{heat:'测试热度'}),
    }));
    await storage.writeJsonAtomic(`cache/hotspots/${source.id}.json`, {items,fetchedAt:now,checkedAt:now,...(error?{error}:{})});
    if (news) console.log(JSON.stringify({source:source.id,count:items.length,publishedAt:items[0]?.publishedAt,url:items[0]?.url,error}));
  }
  const hotspotService = new HotspotService(storage,{fetchSource:async source=>(await storage.readJson<{items:any[]}>(`cache/hotspots/${source}.json`)).items});
  const researchService = serve ? new ResearchService({validateUrl:async()=>{},readDirect:async url=>parseResearchContent({url,provider:'direct',format:'html',body:`<title>隔离验收官方正文</title><article><p>${'这是隔离验收正文。创作时需要核对具体来源，保留数据的条件和适用范围。摘要不能代替原文，公开材料也不能证明所有场景都适用。'.repeat(6)}</p></article>`})}) : new ResearchService();
  const app=await createExpressApp({rootDir:root,storagePath:root,hotspotService,researchService});
  const server=createServer(app); await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  close=async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));};
  const address=server.address();assert.ok(address&&typeof address==='object');
  const base=`http://127.0.0.1:${address.port}`;
  if (serve) {
    const uiRoot=path.join(root,'ui');await cp(path.resolve('dist-renderer'),uiRoot,{recursive:true});
    const index=await readFile(path.join(uiRoot,'index.html'),'utf8');
    const bridge=`<script>window.electron={getServerPort:async()=>${address.port},getConfig:async()=>({aiKeys:[],app:{theme:'dark'}}),getAppPaths:async()=>({})};</script>`;
    app.use(express.static(uiRoot,{index:false}));app.get('*',(_req,res)=>res.type('html').send(index.replace('<head>','<head>'+bridge)));
    console.log(`UI_READY ${base}/hotspots`);
    await new Promise<void>(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);});
  } else {
    let token='';
    const call=async(endpoint:string,data?:unknown)=>{const response=await fetch(base+endpoint,{method:data?'POST':'GET',headers:{'Content-Type':'application/json','X-Local-Session':token},...(data?{body:JSON.stringify(data)}:{})});const body=await response.json() as any;assert.ok(response.ok,JSON.stringify(body));return body;};
    token=(await call('/api/local-sessions/auto',{})).session.token;
    const boards=(await call('/api/hotspots')).boards;
    assert.equal(boards.filter((board:any)=>!board.source.category).length,5);
    assert.equal(boards.filter((board:any)=>board.source.category==='ai-tech').length,3);
    const item=boards.find((board:any)=>board.source.id==='microsoft-research').items[0];assert.ok(item,'Microsoft RSS is required for the real reading check');
    const saved=(await call('/api/hotspots/favorites',{sourceId:item.sourceId,itemId:item.itemId})).favorite;
    assert.equal(saved.publishedAt,item.publishedAt);
    const detail=(await call('/api/hotspots/detail',{sourceId:item.sourceId,itemId:item.itemId})).result;
    console.log(JSON.stringify({reader:detail.status,title:detail.title,chars:detail.text.length,provider:detail.provider,error:detail.error}));
    assert.equal(detail.status,'readable','Original article must be read, RSS summary is insufficient');
    const article=(await call('/api/articles',{hotspot:{sourceId:item.sourceId,itemId:item.itemId},researchSelections:[{readId:detail.readId,hash:detail.hash}]})).article;
    assert.equal(article.sources.length,1);assert.equal(article.sources[0].hash,detail.hash);assert.equal(article.sources[0].text,detail.text);
    console.log(JSON.stringify({ok:true,articleSource:article.sources[0].url,chars:article.sources[0].text.length,realPublishing:false}));
  }
} finally {await close?.();await rm(root,{recursive:true,force:true});}
