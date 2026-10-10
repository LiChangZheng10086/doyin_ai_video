// npm run build, then node scripts/verify-article-auto-research-ui.mjs.
// Temporary storage/browser context; mocked public research and AI; no WeChat writes.
import assert from 'node:assert/strict';
import express from 'express';
import {mkdtemp,rm,mkdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {createExpressApp} from '../dist/app.js';
import {ResearchService} from '../dist/lib/research-service.js';
import {ResearchError} from '../dist/lib/research-types.js';
import {parseResearchContent} from '../dist/lib/research-content.js';
import {resolveToutiaoBrowser} from '../dist/lib/toutiao-browser.js';
const repo=process.cwd(),root=await mkdtemp(path.join(tmpdir(),'article-research-ui-'));
const out=path.join(repo,'output/article-input-recovery-qa-2026-10-10');await mkdir(out,{recursive:true});
const queries=[],reads=[],steps=[],errors=[];let wechatWrites=0,searchAborts=0;
const config={exaEnabled:true,jinaEnabled:false};
const body='项目支持导出，离线编辑仍未开放。'.repeat(20);
const research=new ResearchService({resolveConfig:async()=>config,validateUrl:async()=>{},
 providers:{search:async(query,signal)=>{queries.push(query);if(query.includes('限流'))throw new ResearchError(429,'rate_limited','模拟限流');if(query.includes('取消')){await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>{searchAborts++;reject(signal.reason);},{once:true});});}return ['https://developer.mozilla.org/docs/test','https://docs.python.org/3/test','https://news.example.com/reprint'].map((url,n)=>({id:'candidate-'+n,url,domain:new URL(url).hostname,title:n===0?'官方文档示例':n===1?'另一份原始文档':'重复转载',provider:'exa',publishedAt:'2026-09-01T08:00:00Z',snippet:'不能作为证据的搜索摘要'}));},readJina:async()=>{throw Error('unexpected Jina');}},
 readDirect:async(url)=>{reads.push(url);return parseResearchContent({url,provider:'direct',format:'html',body:`<title>隔离公开资料</title><article><p>${body}${url.includes('python')?'另一份公开文档说明其条件。'.repeat(30):''}</p></article>`});},
});
const writer={async run(step,a){steps.push({id:a.id,step});if(step==='diagnose')return{topics:[1,2,3].map(n=>({title:'隔离方向'+n,audience:'测试读者',question:'如何理解',thesis:'说明边界',hook:'导出',angle:'解释',researchQuestions:[]}))};if(step==='evidence')return{facts:[{claim:'支持导出',quote:'项目支持导出',sourceId:a.sources.find(s=>s.included&&s.status==='readable').id}],issues:['模拟资料与正文不证明真实产品功能']};if(step==='outline')return{thesis:'说明边界',opening:'基本概念',sections:[{heading:'功能与边界',points:['说明用途'],factIds:['fact-1']}],gaps:[]};const draft={title:'隔离测试：公开资料与文章创作',sections:[{heading:'功能与边界',paragraphs:['本篇仅用于隔离验收。项目支持导出，离线编辑仍未开放。搜索摘要没有进入事实资料，也不会向真实公众号提交这篇文章。'],factIds:['fact-1']}]};if(step==='draft')return draft;if(step==='review')return{revision:draft,notes:['模拟来源，仍需人工核对']};return{images:[{section:0,purpose:'封面',caption:'测试示意',prompt:'本地文字示意'},{section:1,purpose:'正文图',caption:'测试流程',prompt:'公开资料流程'}]};}};
const app=await createExpressApp({rootDir:repo,storagePath:root,articleWriter:writer,researchService:research});
app.use(express.static(path.join(repo,'dist-renderer')));const entry=(await readFile(path.join(repo,'dist-renderer/index.html'),'utf8')).replace('<head>','<head><base href="/">');app.get('*',(_req,res)=>res.type('html').send(entry));
const server=app.listen(0);await new Promise(r=>server.once('listening',r));const port=server.address().port,base='http://localhost:'+port;let browser;
try{
 const target=resolveToutiaoBrowser({repoRoot:repo,env:{},allowSystemChrome:false}).target;if(!target||target.kind==='channel')throw Error('项目隔离浏览器不可用');
 browser=await chromium.launch({...(target.kind==='executablePath'?{executablePath:target.path}:{}),headless:true});const context=await browser.newContext({viewport:{width:1440,height:1050}});
 await context.addInitScript(p=>{window.electron={getServerPort:async()=>p};},port);
 await context.route('**/*',route=>route.request().url().startsWith(base)||/^(blob:|data:)/.test(route.request().url())?route.continue():route.abort());
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/wechat-drafts/.test(r.url()))wechatWrites++;});
 const record=async id=>(await(await fetch(base+'/api/articles/'+id)).json()).article;
 const start=async(input,query)=>{await page.goto(base+'/articles');await page.getByLabel('灵感、资料或公开链接',{exact:true}).fill(input);if(query){await page.getByText('补充公开资料（可选）',{exact:true}).click();await page.getByLabel('补充搜索词',{exact:true}).fill(query);}await page.getByRole('button',{name:'自动创作',exact:true}).click();await page.waitForURL(/\/articles\/[a-z0-9-]+$/);return page.url().split('/').at(-1);};
 // Async predicates are immediately truthy in this Playwright build; await API polling explicitly.
 const waitRecord=async(base,id,status)=>{const deadline=Date.now()+45000;while(Date.now()<deadline){const a=(await(await fetch(base+'/api/articles/'+id)).json()).article;if(a.automation?.status===status)return a;if(a.automation?.status==='failed'&&status!=='failed')throw Error('fixture failed: '+a.automation.error?.code);await new Promise(r=>setTimeout(r,100));}throw Error('fixture timed out waiting for '+status);};
 const waitStatus=async(id,status)=>{const a=await waitRecord(base,id,status);await page.getByRole('button',{name:'停止创作',exact:true}).waitFor({state:'hidden'});return a;};
 const beforeQuestion=queries.length,beforeWriting=steps.length;
 const question=await start('什么是skills？ 如何创造skills？ 如何使用skills');let waiting=await waitStatus(question,'needs_input');
 assert.equal(waiting.automation.error.code,'needs_public_query');assert.equal(queries.length,beforeQuestion);assert.equal(steps.length,beforeWriting);
 const recover=page.getByRole('button',{name:'按所选类型继续创作',exact:true});assert.equal(await recover.isEnabled(),false);
 await page.getByLabel('恢复公开搜索关键词',{exact:true}).fill('Agent Skills 官方规范');assert.equal(await recover.isEnabled(),false);
 await page.getByLabel('确认公开搜索词',{exact:true}).check();await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(out,'question-confirm-mobile.png'),fullPage:true});
 await recover.click();const recovered=await waitStatus(question,'ready');assert.equal(recovered.input.kind,'idea');assert.equal(queries.at(-1),'Agent Skills 官方规范');assert.ok(queries.every(q=>!q.includes('什么是skills')));await page.setViewportSize({width:1440,height:1050});
 // Read-only-style legacy fixture is synthesized exclusively in temporary storage.
 const legacy=structuredClone(recovered);legacy.id='legacy-question';legacy.version=14;legacy.input={kind:'text',raw:'什么是skills？ 如何创造skills？ 如何使用skills',hash:'fixture'};legacy.keyword=legacy.input.raw;
 legacy.sources=[{id:'original',kind:'text',depth:0,title:'旧输入',text:legacy.input.raw,url:'',status:'readable',included:true,hash:'fixture',readAt:'2026-10-10T11:46:36Z',links:[],truncated:false}];
 legacy.facts=[];for(const key of ['outline','draft','revision','wechatDelivery'])delete legacy[key];legacy.steps={diagnose:'succeeded',evidence:'failed',outline:'pending',draft:'pending',review:'pending',illustrations:'pending'};legacy.automation={...legacy.automation,status:'failed',stage:'evidence',checkpoints:{diagnose:{status:'succeeded',updatedAt:'2026-10-10T11:46:42Z'}},error:{code:'ai_output_invalid',message:'旧校验失败',retryable:true}};delete legacy.automation.research;
 // API service has already loaded its index, so install fixture through a separate
 // ArticleService instance into the app only for this isolated browser check.
 const {LocalStorage}=await import('../dist/lib/storage.js');
 const storage=new LocalStorage(root),index=await storage.readJson('cache/articles.json');await storage.writeJsonAtomic('cache/articles.json',{...index,[legacy.id]:legacy});
 // Fresh app is required to read persisted legacy state without touching a live cache.
 const legacyApp=await createExpressApp({rootDir:repo,storagePath:root,articleWriter:writer,researchService:research});
 legacyApp.use(express.static(path.join(repo,'dist-renderer')));legacyApp.get('*',(_req,res)=>res.type('html').send(entry));const legacyServer=legacyApp.listen(0);await new Promise(r=>legacyServer.once('listening',r));
 try{
  const legacyBase='http://localhost:'+legacyServer.address().port;await context.unroute('**/*');await context.route('**/*',route=>route.request().url().startsWith(base)||route.request().url().startsWith(legacyBase)||/^(blob:|data:)/.test(route.request().url())?route.continue():route.abort());
  const legacyPage=await context.newPage();await legacyPage.addInitScript(p=>{window.electron={getServerPort:async()=>p};},legacyServer.address().port);legacyPage.on('pageerror',e=>errors.push(e.message));legacyPage.on('request',r=>{if(/wechat-drafts/.test(r.url()))wechatWrites++;});await legacyPage.goto(legacyBase+'/articles/'+legacy.id);
  await legacyPage.getByLabel('恢复公开搜索关键词',{exact:true}).fill('Skills 公开创建教程');await legacyPage.getByLabel('确认公开搜索词',{exact:true}).check();await legacyPage.screenshot({path:path.join(out,'legacy-recovery-desktop.png'),fullPage:true});await legacyPage.getByRole('button',{name:'按所选类型继续创作',exact:true}).click();
  const repaired=await waitRecord(legacyBase,legacy.id,'ready');assert.equal(repaired.sources[0].included,false);assert.equal(repaired.sources[0].text,legacy.input.raw);assert.equal(repaired.input.kind,'idea');assert.equal(repaired.input.searchQuery,'Skills 公开创建教程');assert.equal(repaired.automation.research?.query,'Skills 公开创建教程');assert.equal(queries.at(-1),'Skills 公开创建教程',JSON.stringify({input:repaired.input,research:repaired.automation.research,queries}));await legacyPage.close();
 }finally{legacyServer.closeAllConnections();await new Promise(r=>legacyServer.close(r));}
 const idea=await start('想写一篇关于导出的文章');const a=await waitStatus(idea,'ready');assert.equal(a.sources.length,2);assert.ok(a.sources.every(s=>s.text&&!s.text.includes('不能作为证据')));assert.equal(a.reviewed,false);assert.equal(a.wechatDelivery,undefined);
 await page.getByText('公开资料检索 · 2份正文',{exact:true}).click();await page.getByText(/搜索报告日期：2026-09-01/).first().waitFor();await page.getByText(/正文发布日期：未知/).first().waitFor();await page.frameLocator('iframe[title="自动创作文章预览"]').getByText('功能与边界',{exact:true}).waitFor();await page.screenshot({path:path.join(out,'search-preview-desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.locator('iframe[title="自动创作文章预览"]').scrollIntoViewIfNeeded();await page.frameLocator('iframe[title="自动创作文章预览"]').getByText('功能与边界',{exact:true}).waitFor();await page.screenshot({path:path.join(out,'search-preview-mobile.png'),fullPage:true});await page.locator('iframe[title="自动创作文章预览"]').screenshot({path:path.join(out,'search-article-mobile.png')});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.setViewportSize({width:1440,height:1050});
 const prior=queries.length;const pasted=await start(body+'私人全文无需进入搜索');await waitStatus(pasted,'ready');assert.equal(queries.length,prior);
 const opted=await start(body+'私人全文只作为本地文章输入','公开补充主题');await waitStatus(opted,'ready');assert.equal(queries.at(-1),'公开补充主题');assert.ok(queries.every(q=>!q.includes('私人全文')));
 const limited=await start('想写一篇限流测试文章');await waitStatus(limited,'needs_input');await page.getByLabel('补充正文',{exact:true}).fill(body);const beforeResume=queries.length;await page.getByRole('button',{name:'以补充正文继续',exact:true}).click();await waitStatus(limited,'ready');assert.equal(queries.length,beforeResume);
 const cancel=await start('想写一篇取消搜索测试文章');const searchDeadline=Date.now()+10000;while(!queries.some(q=>q.includes('取消'))){if(Date.now()>searchDeadline)throw Error('cancel fixture search did not start');await new Promise(r=>setTimeout(r,50));}await page.getByRole('button',{name:'停止创作',exact:true}).click();const stopped=await waitStatus(cancel,'cancelled');assert.equal(stopped.sources.length,0);assert.ok(searchAborts>0);
 config.exaEnabled=false;const disabled=await start('想写一篇尚未启用搜索的文章');await waitStatus(disabled,'needs_input');await page.getByText(/资料搜索尚未启用/).first().waitFor();await page.screenshot({path:path.join(out,'search-disabled-recovery.png'),fullPage:true});
 assert.equal(errors.length,0,errors.join('\n'));assert.equal(wechatWrites,0);
 const evidence={browser:await browser.version(),isolatedStorage:true,externalNetworkRequests:0,realAiRequests:0,wechatWrites,queries,reads,searchAborts,pageErrors:errors,articleIds:{question,legacy:legacy.id,idea,pasted,opted,limited,cancel,disabled},checks:['question confirmation without automatic transmission','legacy persisted task recovery','idea full-body sources and citations','published versus fetched dates','URL and reprint dedup','desktop/mobile no overflow','pasted body privacy','explicit public search opt-in','rate limit supplemental recovery','cancel abort','disabled configuration needs input']};
 await writeFile(path.join(out,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
}catch(error){console.error(error);throw error;}finally{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
