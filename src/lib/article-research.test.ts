import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ArticleService } from './articles.js';
import { LocalStorage } from './storage.js';
import { ResearchService } from './research-service.js';
import { parseResearchContent } from './research-content.js';
test('research import is atomic, preserves original body and rejects stale versions/duplicates',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'article-research-'));const storage=new LocalStorage(root);
  const research=new ResearchService({validateUrl:async()=>{},readDirect:async url=>parseResearchContent({url,provider:'direct',format:'html',body:`<title>报道</title><article><p>${'研究介绍了功能范围和实际约束。'.repeat(20)}</p></article>`})});
  const deps={storage,writer:{run:async()=>({})},resolveResearchSelections:(actor:string,s:unknown)=>research.resolveSelections(actor,s)};
  const service=new ArticleService(deps);
  try{
    const read=await research.read('u',{url:'https://news.example.com/article/1'});const selections=[{readId:read.readId,hash:read.hash}];
    const a=await service.create({keyword:'选题'});
    await assert.rejects(service.importResearchSources(a.id,a.version,[...selections,{readId:'expired',hash:'x'}],'u'),(e:any)=>e.status===410);
    assert.equal((await service.get(a.id)).sources.length,0);
    const added=await service.importResearchSources(a.id,a.version,selections,'u');assert.equal(added.sources[0].text,read.text);assert.equal(added.sources[0].hash,read.hash);assert.equal(added.materialConfirmed,false);
    await assert.rejects(service.importResearchSources(a.id,a.version,selections,'u'),(e:any)=>e.status===409);
    await assert.rejects(service.importResearchSources(a.id,added.version,selections,'u'),(e:any)=>e.status===422);
    const created=await service.create({keyword:'带资料创建',researchSelections:selections},'u');assert.equal(created.sources.length,1);
    const fresh=new ArticleService(deps);assert.equal((await fresh.get(created.id)).sources[0].text,read.text);
    await assert.rejects(service.create({keyword:'失败创建',researchSelections:[{readId:'gone',hash:'x'}]},'u'),(e:any)=>e.status===410);
    assert.equal((await service.list()).length,2);
    const fromSameSource=new ArticleService({...deps,resolveHotspot:async()=>({sourceId:'toutiao',itemId:'1',title:'选题',url:read.url})});
    const same=await fromSameSource.create({hotspot:{sourceId:'toutiao',itemId:'1'},researchSelections:selections},'u');assert.equal(same.sources.length,1);assert.equal(same.sources[0].status,'readable');
  }finally{await rm(root,{recursive:true,force:true});}
});
test('version is rechecked after asynchronous snapshot resolution',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'article-research-race-'));let release!:(value:any[])=>void;
  const service=new ArticleService({storage:new LocalStorage(root),writer:{run:async()=>({})},resolveResearchSelections:()=>new Promise(r=>{release=r;})});
  try{
    const a=await service.create({keyword:'并发编辑'});const pending=service.importResearchSources(a.id,a.version,[{readId:'id',hash:'h'}],'u');
    await new Promise(r=>setImmediate(r));await service.update(a.id,{version:a.version,keyword:'新编辑'});
    release([]);await assert.rejects(pending,(e:any)=>e.status===409);assert.equal((await service.get(a.id)).keyword,'新编辑');
  }finally{await rm(root,{recursive:true,force:true});}
});
