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
const out=path.join(repo,'output/article-research-qa-2026-10-10');await mkdir(out,{recursive:true});
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
 const waitStatus=async(id,status)=>{await page.waitForFunction(async({base,id,status})=>(await(await fetch(base+'/api/articles/'+id)).json()).article.automation?.status===status,{base,id,status},{timeout:45000});await page.getByRole('button',{name:'停止创作',exact:true}).waitFor({state:'hidden'});return record(id);};
 const idea=await start('想写一篇关于导出的文章');const a=await waitStatus(idea,'ready');assert.equal(a.sources.length,2);assert.ok(a.sources.every(s=>s.text&&!s.text.includes('不能作为证据')));assert.equal(a.reviewed,false);assert.equal(a.wechatDelivery,undefined);
 await page.getByText('公开资料检索 · 2份正文',{exact:true}).click();await page.getByText(/搜索报告日期：2026-09-01/).first().waitFor();await page.getByText(/正文发布日期：未知/).first().waitFor();await page.frameLocator('iframe[title="自动创作文章预览"]').getByText('功能与边界',{exact:true}).waitFor();await page.screenshot({path:path.join(out,'search-preview-desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.locator('iframe[title="自动创作文章预览"]').scrollIntoViewIfNeeded();await page.frameLocator('iframe[title="自动创作文章预览"]').getByText('功能与边界',{exact:true}).waitFor();await page.screenshot({path:path.join(out,'search-preview-mobile.png'),fullPage:true});await page.locator('iframe[title="自动创作文章预览"]').screenshot({path:path.join(out,'search-article-mobile.png')});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.setViewportSize({width:1440,height:1050});
 const prior=queries.length;const pasted=await start(body+'私人全文无需进入搜索');await waitStatus(pasted,'ready');assert.equal(queries.length,prior);
 const opted=await start(body+'私人全文只作为本地文章输入','公开补充主题');await waitStatus(opted,'ready');assert.equal(queries.at(-1),'公开补充主题');assert.ok(queries.every(q=>!q.includes('私人全文')));
 const limited=await start('想写一篇限流测试文章');await waitStatus(limited,'needs_input');await page.getByLabel('补充正文',{exact:true}).fill(body);const beforeResume=queries.length;await page.getByRole('button',{name:'以补充正文继续',exact:true}).click();await waitStatus(limited,'ready');assert.equal(queries.length,beforeResume);
 const cancel=await start('想写一篇取消搜索测试文章');const searchDeadline=Date.now()+10000;while(!queries.some(q=>q.includes('取消'))){if(Date.now()>searchDeadline)throw Error('cancel fixture search did not start');await new Promise(r=>setTimeout(r,50));}await page.getByRole('button',{name:'停止创作',exact:true}).click();const stopped=await waitStatus(cancel,'cancelled');assert.equal(stopped.sources.length,0);assert.ok(searchAborts>0);
 config.exaEnabled=false;const disabled=await start('想写一篇尚未启用搜索的文章');await waitStatus(disabled,'needs_input');await page.getByText(/资料搜索尚未启用/).first().waitFor();await page.screenshot({path:path.join(out,'search-disabled-recovery.png'),fullPage:true});
 assert.equal(errors.length,0,errors.join('\n'));assert.equal(wechatWrites,0);
 const evidence={browser:await browser.version(),isolatedStorage:true,externalNetworkRequests:0,realAiRequests:0,wechatWrites,queries,reads,searchAborts,pageErrors:errors,articleIds:{idea,pasted,opted,limited,cancel,disabled},checks:['idea full-body sources and citations','published versus fetched dates','URL and reprint dedup','desktop/mobile no overflow','pasted body privacy','explicit public search opt-in','rate limit supplemental recovery','cancel abort','disabled configuration needs input']};
 await writeFile(path.join(out,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
}catch(error){console.error(error);throw error;}finally{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
