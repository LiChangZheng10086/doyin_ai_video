/** Default: isolated API integration. --serve: isolated UI, --live: public services only. */
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createExpressApp } from '../src/app.js';
import { LocalStorage } from '../src/lib/storage.js';
import { ResearchService } from '../src/lib/research-service.js';
import { parseResearchContent } from '../src/lib/research-content.js';
import { createResearchProviders, providerFailure } from '../src/lib/research-providers.js';
import { HOTSPOT_SOURCES } from '../src/lib/hotspot-sources.js';
import { HotspotService } from '../src/lib/hotspots.js';
import { ArticleService } from '../src/lib/articles.js';
import { validateWritingResult } from '../src/lib/article-writing.js';

if(process.argv.includes('--live')){
  const providers=createResearchProviders();
  for(const query of ['新能源汽车 充电 基础设施 中国','人工智能 教育 应用 中国','国庆 旅游 消费 中国']){
    try{const rows=await providers.search(query,AbortSignal.timeout(30000));console.log(JSON.stringify({kind:'search',query,ok:true,candidates:rows.map(r=>({title:r.title,url:r.url,publishedAt:r.publishedAt}))}));}
    catch(e){console.log(JSON.stringify({kind:'search',query,ok:false,error:providerFailure(e).message}));}
  }
  for(const url of ['https://www.toutiao.com/trending/7694198156686344742/','https://www.zhihu.com/question/2091510176536687944','https://www.gov.cn/zhengce/zhengceku/202306/content_6887168.htm']){
    try{const read=await providers.readJina(url,AbortSignal.timeout(30000));console.log(JSON.stringify({kind:'read',url,status:read.status,sourceKind:read.kind,chars:read.text.length,candidates:read.candidates.length,error:read.error?.code}));}
    catch(e){console.log(JSON.stringify({kind:'read',url,ok:false,error:providerFailure(e).message}));}
  }
}else{
  const root=await mkdtemp(path.join(tmpdir(),'content-research-'));const storage=new LocalStorage(root);const now=new Date().toISOString();
  const prose='公开资料介绍新功能的使用条件、来源与适用范围。引用时需要保留这些条件，不能把讨论线索当成已经确认的事实。'.repeat(10);
  const url='https://news.example.com/article/1';
  const research=new ResearchService({resolveConfig:async()=>({jinaEnabled:true,exaEnabled:true}),validateUrl:async()=>{},
    readDirect:async input=>parseResearchContent({url:input,provider:'direct',format:'html',body:input.includes('/article/')?`<title>公开报道与来源条件</title><article><p>${prose}</p></article>`:`<title>验收热点</title><main>话题描述<a href="${url}">公开报道与来源条件</a></main>`}),
    providers:{search:async query=>[{id:'fixture',title:query+' · 公开报道',url,domain:'news.example.com',provider:'exa',snippet:'这是搜索摘录，读取后才能作为资料。'}],
      readJina:async input=>parseResearchContent({url:input,provider:'jina',format:'markdown',body:`Title: 验收话题\nMarkdown Content:\n## 事件详情\n这是话题描述。[公开报道与来源条件](${url})`})},
  });
  for(const source of HOTSPOT_SOURCES)await storage.writeJsonAtomic(`cache/hotspots/${source.id}.json`,{items:[{sourceId:source.id,itemId:'1',title:`验收热点 · ${source.name}`,url:source.id==='toutiao'?'https://www.toutiao.com/trending/1/':source.home,rank:1,summary:'已有榜单摘要，打开详情不需要联网。'}],fetchedAt:now,checkedAt:now});
  const hotspotService=new HotspotService(storage,{fetchSource:async sourceId=>(await storage.readJson<{items:any[]}>(`cache/hotspots/${sourceId}.json`)).items});
  const app=await createExpressApp({rootDir:root,storagePath:root,researchService:research,hotspotService});
  const serve=process.argv.includes('--serve');const port=serve?Number(process.env.CONTENT_RESEARCH_PORT??3180):0;
  if(serve){
    const publicRoot=path.resolve('dist-renderer');const index=await readFile(path.join(publicRoot,'index.html'),'utf8');
    const bridge=`<script>window.electron={getServerPort:async()=>${port},getConfig:async()=>({aiKeys:[],app:{theme:'dark'}}),getAppPaths:async()=>({}),setConfig:async()=>{},addApiKey:async()=>{},updateApiKey:async()=>{},removeApiKey:async()=>{},setActiveApiKey:async()=>{},testApiKey:async()=>({valid:false})};</script>`;
    app.use(express.static(publicRoot,{index:false}));app.get('*',(_req,res)=>res.type('html').send(index.replace('<head>','<head>'+bridge)));
  }
  const server=createServer((req,res)=>{
    // No simulated page action can reach the real configuration file.
    if(req.url?.startsWith('/api/config')){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({aiKeys:[]}));return;}
    app(req,res);
  });
  await new Promise<void>(r=>server.listen(port,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address==='object');
  const base=`http://127.0.0.1:${address.port}`;let token='';
  const call=async(endpoint:string,data?:unknown)=>{const response=await fetch(base+endpoint,{method:data?'POST':'GET',headers:{'Content-Type':'application/json','X-Local-Session':token},...(data?{body:JSON.stringify(data)}:{})});return {status:response.status,body:await response.json() as any};};
  if(serve){
    console.log(`Isolated content research UI on ${base}/hotspots; temporary storage ${root}`);
    let closing=false;const close=()=>{if(closing)return;closing=true;server.closeAllConnections();server.close(()=>{void rm(root,{recursive:true,force:true}).then(()=>process.exit(0));});};
    process.on('SIGINT',close);process.on('SIGTERM',close);
  }else{
    try{
      token=(await call('/api/local-sessions/auto',{})).body.session.token;
      const detail=await call('/api/hotspots/detail',{sourceId:'toutiao',itemId:'1'});assert.equal(detail.status,200);assert.equal(detail.body.result.kind,'topic');
      const search=(await call('/api/research/search',{query:'验收热点'})).body.result;
      const read=(await call('/api/research/read',{searchId:search.searchId,candidateId:search.candidates[0].id})).body.result;assert.equal(read.status,'readable');
      const selections=[{readId:read.readId,hash:read.hash}];
      const created=await call('/api/articles',{keyword:'来源取材验收',hotspot:{sourceId:'toutiao',itemId:'1'},researchSelections:selections});assert.equal(created.status,201);assert.equal(created.body.article.sources.length,2);assert.equal(created.body.article.sources[1].text,prose);
      assert.equal((await call(`/api/articles/${created.body.article.id}/sources/import`,{version:created.body.article.version,selections})).status,422);
      assert.equal((await call('/api/articles',{keyword:'失效不能建文章',researchSelections:[{readId:'missing',hash:'x'}]})).status,410);
      const quote='公开资料介绍新功能的使用条件、来源与适用范围。';
      const writer={run:async(step:any,article:any)=>{
        if(step==='diagnose')return {topics:[{id:'topic-1',title:'验收方向'}]};
        if(step==='evidence')return validateWritingResult('evidence',{facts:[{claim:'使用有条件',sourceId:article.sources[1].id,quote}],issues:[]},article);
        if(step==='outline')return {thesis:'使用条件',opening:'来源介绍',sections:[{heading:'范围',points:['使用条件'],factIds:[article.facts[0].id]}],gaps:[]};
        const draft={title:'资料引用验收',sections:[{heading:'范围',paragraphs:[quote],factIds:[article.facts[0].id]}]};
        return step==='draft'?draft:{revision:draft,notes:[]};
      }};
      const cover=path.join(root,'verification-cover.png');await writeFile(cover,'isolated preview hash fixture');
      const articles=new ArticleService({storage,writer,resolveAsset:async()=>({path:cover,record:{kind:'image'}} as any)});
      let article=await articles.run(created.body.article.id,'diagnose',created.body.article.version);
      article=await articles.update(article.id,{version:article.version,selectedTopic:'topic-1'});
      article=await articles.run(article.id,'evidence',article.version);assert.equal(article.facts[0].quote,quote);
      assert.throws(()=>validateWritingResult('evidence',{facts:[{claim:'伪造',sourceId:article.sources[1].id,quote:'来源不存在的事实'}],issues:[]},article),/不在对应来源/);
      article=await articles.update(article.id,{version:article.version,materialConfirmed:true});
      article=await articles.run(article.id,'outline',article.version);
      article=await articles.update(article.id,{version:article.version,outlineConfirmed:true});
      article=await articles.run(article.id,'draft',article.version);article=await articles.run(article.id,'review',article.version);
      article=await articles.update(article.id,{version:article.version,reviewed:true,coverAssetId:'isolated-cover'});
      const preview=await articles.preview(article.id,article.version);assert.ok(preview.html.includes(quote));assert.ok(preview.html.includes(url));
      console.log('PASS: isolated hotspot → search → body → atomic article creation → mock facts/draft → article preview; fabricated quotes, duplicates and stale snapshots rejected. No real data or publishing calls.');
    }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true});}
  }
}
