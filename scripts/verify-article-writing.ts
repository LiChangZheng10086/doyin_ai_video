/** Default: isolated UI fixture. --live: read one current public hotspot URL per source. */
import { createServer } from 'node:http';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createExpressApp } from '../src/app.js';
import { readArticleSource } from '../src/lib/article-sources.js';
import { HOTSPOT_SOURCES, fetchHotspotSource } from '../src/lib/hotspot-sources.js';
import { LocalStorage } from '../src/lib/storage.js';
import type { ArticleStep, ArticleRecord } from '../src/lib/article-types.js';

if (process.argv.includes('--live')) {
  await Promise.all(HOTSPOT_SOURCES.map(async source => {
    try { const item = (await fetchHotspotSource(source.id))[0]; if (!item) throw new Error('榜单为空'); const result = await readArticleSource(item.url); console.log(JSON.stringify({source:source.name,url:item.url,status:result.status,characters:result.text.length,candidates:result.links.length,error:result.error})); }
    catch (e) { console.log(JSON.stringify({source:source.name,status:'unavailable',error:(e as Error).message})); }
  }));
} else {
  const root = await mkdtemp(path.join(tmpdir(),'article-ui-')); const storage = new LocalStorage(root);
  const writer = { async run(step:ArticleStep,a:ArticleRecord):Promise<any> {
    if (step === 'diagnose') return {topics:[1,2,3].map(n => ({id:`topic-${n}`,title:`导出功能的第${n}种写法`,audience:'产品用户',question:'更新解决了哪些问题？',thesis:'理解功能边界',hook:'周三新增导出',angle:'实际影响',researchQuestions:['是否支持离线编辑？']}))};
    if (step === 'evidence') return {facts:[{id:'fact-1',claim:'项目支持导出',sourceId:a.sources[0].id,quote:'项目支持导出'}],issues:['离线编辑仍未开放']};
    if (step === 'outline') return {thesis:'导出与离线的边界',opening:'先看一次导出',sections:[{heading:'新增能力',points:['支持导出','离线编辑仍未开放'],factIds:['fact-1']}],gaps:[]};
    const draft = {title:'导出功能来了，离线编辑还要等',sections:[{heading:'开放与局限',paragraphs:['项目支持导出，离线编辑仍未开放。','这次更新方便了文件交付。离线场景仍需要其他方案。'],factIds:['fact-1']}]};
    if (step === 'draft') return draft;
    if (step === 'review') return {revision:{...draft,sections:[{...draft.sections[0],paragraphs:['项目支持导出，离线编辑仍未开放。','如果你需要离线编辑，这次更新还不能解决这个问题。']}]},notes:['删去笼统表达，保留离线编辑的限制。']};
    return {images:[{section:0,purpose:'解释功能边界',caption:'支持导出，尚未支持离线编辑',prompt:'绘制两个并列功能格：导出可用、离线编辑待开放。简洁图标，无虚构现场。'}]};
  }};
  const now = new Date().toISOString();
  for (const source of HOTSPOT_SOURCES) await storage.writeJsonAtomic(`cache/hotspots/${source.id}.json`,{items:[{sourceId:source.id,itemId:'fixture',title:'导出功能正式开放',url:source.home,rank:1}],fetchedAt:now,checkedAt:now});
  const app = await createExpressApp({rootDir:process.cwd(),storagePath:root,articleWriter:writer,
    readArticleSource:async url => ({url,title:'公开功能说明',text:'项目支持导出，离线编辑仍未开放。',status:'readable',readAt:now,hash:'fixture',links:[],truncated:false}),
    wechatMedia:{prepareCoverImage:async src => ({path:src,bytes:8}),prepareContentImage:async src => ({path:src,bytes:8})},
  });
  const imageDir = storage.resolve('assets/images'); await mkdir(imageDir,{recursive:true});
  await writeFile(path.join(imageDir,'fixture.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII=','base64'));
  await storage.writeJsonAtomic('cache/assets-index.json',{schemaVersion:1,assets:{'fixture-image':{id:'fixture-image',kind:'image',filename:'fixture.png',originalName:'验收封面.png',bytes:68,width:1,height:1,createdAt:now,version:1}}});
  const index = (await readFile(path.resolve('dist-renderer/index.html'),'utf8')).replace('<head>', '<head><base href="/"><script>window.electron={getServerPort:async()=>3100};</script>');
  app.use(express.static(path.resolve('dist-renderer'),{index:false})); app.get('*',(_req,res) => res.type('html').send(index));
  let failSave = true;
  const server = createServer((req,res) => {
    if (failSave && req.method === 'PATCH' && /^\/api\/articles\/[^/]+$/.test(req.url ?? '')) {failSave=false;res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({code:'qa_failure',message:'模拟保存失败：输入应继续保留'}));return;}
    app(req,res);
  });
  server.listen(3100,'127.0.0.1',() => console.log('Isolated article UI on http://127.0.0.1:3100 — fake AI/material/media, first save 503, no real WeChat calls.'));
  let closing = false; const close = () => {if (closing) return;closing=true;server.closeAllConnections();server.close(() => {void rm(root,{recursive:true,force:true}).then(() => process.exit(0));});};
  process.on('SIGINT',close);process.on('SIGTERM',close);
}
