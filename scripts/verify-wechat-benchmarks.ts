/** --live: one public keyword search. Otherwise serves isolated UI fixtures on 3100. */
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createExpressApp } from '../src/app.js';
import { LocalStorage } from '../src/lib/storage.js';
import { WechatBenchmarkService } from '../src/lib/wechat-benchmarks.js';
import { ArticleService } from '../src/lib/articles.js';
import { searchWechatArticles } from '../src/lib/wechat-search.js';
import { ARTICLE_STEPS } from '../src/lib/article-types.js';

if(process.argv.includes('--live')){
  const items=await searchWechatArticles(process.argv[process.argv.indexOf('--live')+1]??'人工智能');
  console.log(JSON.stringify({count:items.length,articles:items.slice(0,3).map(({title,accountName,dateText})=>({title,accountName,dateText})),trafficAvailable:false}));
}else{
  const root=await mkdtemp(path.join(tmpdir(),'wechat-benchmarks-ui-'));const storage=new LocalStorage(root);await storage.ensureBaseDirs();
  const benchmarks=new WechatBenchmarkService(storage);
  let group=await benchmarks.create({name:'验收：用户自选领域',audience:'用户自定读者',keywords:['实用教程'],minReads:1000});
  for(let i=1;i<=10;i++)group=await benchmarks.update(group.id,{version:group.version,addAccount:{name:i===10?'待核验示例号':`验收对标${i}`,identity:`fixture-account-${i}`,identityConfirmed:i!==10,relevant:true,selected:true,notes:'短段落，先说明适用条件',samples:[{title:`教程标题${i}`,url:`https://mp.weixin.qq.com/s/fixture-${i}`,dateText:'2026-09-29',reads:i===1?100000:1200+i*100,lowerBound:i===1,metricSource:'隔离验收数据（非真实流量）',measuredAt:new Date().toISOString()}]}});
  const writer={run:async()=>{throw new Error('隔离验收环境不调用真实 AI');}};
  const ownArticles=new ArticleService({storage,writer});let article=await ownArticles.create({keyword:'模板与图片验收'});
  const draft={title:'模板与正文图片验收',sections:[{heading:'具体步骤与依据',paragraphs:['这是一篇隔离验收文章。用于检查排版选择、图片预览与版本变化。'],factIds:['fact-1']}]};
  Object.assign(article,{steps:Object.fromEntries(ARTICLE_STEPS.map(s=>[s,'succeeded'])),topics:[{id:'topic-1',title:'验收方向',audience:'用户',question:'如何检查',thesis:'检查排版',hook:'样式变化',angle:'教程',researchQuestions:[]}],selectedTopic:'topic-1',sources:[{id:'source-1',title:'用户提供的验收材料',url:'',text:'这是一篇隔离验收文章。',status:'readable',readAt:new Date().toISOString(),hash:'fixture',links:[],truncated:false,included:true,kind:'text',depth:0}],facts:[{id:'fact-1',claim:'文章用于验收',sourceId:'source-1',quote:'这是一篇隔离验收文章。'}],outline:{thesis:'排版验收',opening:'样式变化',sections:[{heading:'具体步骤',points:['检查模板'],factIds:['fact-1']}],gaps:[]},draft,revision:draft,adopted:'revision',reviewed:true,materialConfirmed:true,outlineConfirmed:true});
  const app=await createExpressApp({rootDir:root,storagePath:root,articleWriter:writer});let failSave=true;
  const server=createServer((req,res)=>{
    if(req.method==='GET'&&req.url==='/api/_verify/wechat-benchmarks'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({isolated:true}));return;}
    if(req.method==='POST'&&req.url==='/api/wechat-benchmarks/search'){
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({result:{keyword:'实用教程',fetchedAt:new Date().toISOString(),cached:false,articles:[{id:'fixture-search',title:'检索线索：适用条件与步骤',url:'https://mp.weixin.qq.com/s/search-fixture',accountName:'搜索候选示例号',summary:'这是线索，不包含阅读量。',dateText:'2026-09-30'}]}}));return;
    }
    if(failSave&&req.method==='PATCH'&&req.url?.startsWith('/api/wechat-benchmarks/')){failSave=false;res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({message:'模拟保存失败：输入应保留'}));return;}
    if(req.method==='POST'&&req.url?.includes('/api/publishing/')&&req.url!=='/api/publishing/due/check'){res.writeHead(403,{'Content-Type':'application/json'});res.end(JSON.stringify({message:'隔离验收禁止真实发布或连接平台账号'}));return;}
    app(req,res);
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(3100,'127.0.0.1',resolve);});
  const session=await(await fetch('http://127.0.0.1:3100/api/local-sessions/auto',{method:'POST'})).json() as any;
  const token=session.session?.token??session.token;
  const form=new FormData();form.append('files',new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII=','base64')],{type:'image/png'}),'fixture.png');
  const uploaded=await(await fetch('http://127.0.0.1:3100/api/assets/images',{method:'POST',headers:{'X-Local-Session':token},body:form})).json() as any;
  article.coverAssetId=uploaded.assets[0].id;article.bodyImageAssetIds=[article.coverAssetId];
  await storage.writeJsonAtomic('cache/articles.json',{[article.id]:article});
  console.log(JSON.stringify({message:'Isolated UI fixture on 3100; first benchmark save fails; no real account calls',benchmarkPage:'http://localhost:5173/articles/benchmarks',templatePage:`http://localhost:5173/articles/${article.id}`}));
  let closing=false;const close=()=>{if(closing)return;closing=true;server.closeAllConnections();server.close(()=>{void rm(root,{recursive:true,force:true}).then(()=>process.exit(0));});};
  process.on('SIGINT',close);process.on('SIGTERM',close);
}
