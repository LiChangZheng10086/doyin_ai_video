import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { _electron as electron } from 'playwright';
import { createExpressApp } from '../dist/app.js';

// Temporary API and browser profile; synthetic HTTPS documents exercise the real native view.
const live = process.argv.includes('--live');
const root = await mkdtemp(path.join(tmpdir(), 'youtube-browser-qa-'));
await mkdir(path.join(root,'profile'));
const repo = path.resolve(import.meta.dirname, '..');
const backend = await createExpressApp({ rootDir: root, storagePath: path.join(root, 'storage') });
const server = createServer(backend);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const entry = path.join(root, 'main.cjs');
const fixtureHtml = `<html><head><title>{{title}}</title></head><body style="background:#111;color:white;font:20px sans-serif"><h1>{{title}}</h1><a id="video" href="/watch?v=M7lc1UVf-VE&list=ignored">Open video</a><button id="spa">Next video</button><a id="external" href="https://example.com/">External</a><script>document.querySelector('#spa').onclick=()=>{history.pushState({},'', '/shorts/dQw4w9WgXcQ');document.title='SPA video - YouTube';};</script></body></html>`;
await writeFile(entry, `
const {app,BrowserWindow,WebContentsView,ipcMain}=require('electron');
const {pathToFileURL}=require('node:url');
const {YoutubeBrowser,registerYoutubeBrowserHandlers}=require(${JSON.stringify(path.join(repo,'dist-electron/youtube-browser.js'))});
app.setPath('userData',${JSON.stringify(path.join(root,'profile'))});
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1200,height:800,webPreferences:{preload:${JSON.stringify(path.join(repo,'dist-electron/preload.js'))},contextIsolation:true,nodeIntegration:false,sandbox:false}});
 ipcMain.handle('get-server-port',()=>${port});
 ipcMain.handle('get-config',()=>({aiKeys:[],app:{theme:'dark',firstRun:false}}));
 ipcMain.handle('get-version',()=> 'qa');
 ipcMain.handle('save-config',()=>{});
 const browser=new YoutubeBrowser(win,()=>{
  const view=new WebContentsView({webPreferences:{partition:'persist:youtube-browser',nodeIntegration:false,contextIsolation:true,sandbox:true}});
  globalThis.__youtubeQA.view=view;
  if(!${live}){
   const debuggerApi=view.webContents.debugger;debuggerApi.attach('1.3');
   debuggerApi.on('message',async(_event,method,params)=>{
    if(method!=='Fetch.requestPaused')return;
    const url=new URL(params.request.url);
    const title=url.pathname==='/watch'?'Fixture video - YouTube':url.pathname==='/results'?'Search results':'YouTube';
    const html=${JSON.stringify(fixtureHtml)}.replaceAll('{{title}}',title);
    await debuggerApi.sendCommand('Fetch.fulfillRequest',{requestId:params.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'text/html'}],body:Buffer.from(html).toString('base64')}).catch(()=>{});
   });
   void debuggerApi.sendCommand('Fetch.enable',{patterns:[{urlPattern:'*',resourceType:'Document',requestStage:'Request'}]});
  }
  return view;
 });
 globalThis.__youtubeQA={win,browser,view:null};
 const dispose=registerYoutubeBrowserHandlers(ipcMain,win,browser,pathToFileURL(${JSON.stringify(path.join(repo,'dist-renderer/index.html'))}).href);
 win.on('closed',dispose);
 await win.loadFile(${JSON.stringify(path.join(repo,'dist-renderer/index.html'))},{hash:'/youtube'});
});
app.on('window-all-closed',()=>app.quit());
`);
const syntax=spawnSync(process.execPath,['--check',entry],{encoding:'utf8'});
assert.equal(syntax.status,0,syntax.stderr);
let application;
try {
  application = await electron.launch({ executablePath: path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [entry], timeout: 15000 });
  application.process().stderr.on('data', data => process.stderr.write(data));
  application.process().stdout.on('data', data => process.stdout.write(data));
  console.log('Native QA launched', root);
  const page = await application.firstWindow();
  console.log('Native QA window ready');
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: '油管', exact: true, level: 1 }).waitFor();
  console.log('Native QA renderer ready');
  const native = fn => application.evaluate(fn);
  await page.waitForFunction(() => !document.querySelector('[role="status"]')?.textContent?.includes('正在加载'));
  await native(() => { const {view,win}=globalThis.__youtubeQA; const prefs=view.webContents.getLastWebPreferences(); if(prefs.nodeIntegration || !prefs.contextIsolation || !prefs.sandbox || prefs.preload)throw Error('unsafe guest preferences'); if(view.webContents.session===win.webContents.session)throw Error('shared session'); });
  assert.deepEqual(await native(async()=>globalThis.__youtubeQA.view.webContents.executeJavaScript('[typeof window.electron,typeof require]')), ['undefined','undefined']);
  assert.equal(await page.getByRole('button',{name:'采集当前视频',exact:true}).isDisabled(),true);
  await page.getByLabel('搜索视频或粘贴油管链接').fill('AI skills');
  await page.getByRole('button',{name:'搜索',exact:true}).click();
  await page.waitForFunction(()=>document.body.textContent.includes('/results?search_query=AI+skills'));
  if (live) {
    const search=await native(async()=>{
      const wc=globalThis.__youtubeQA.view.webContents;const deadline=Date.now()+30000;let result;
      while(Date.now()<deadline){
        result=await wc.executeJavaScript(`({title:document.title,results:document.querySelectorAll('a[href^="/watch?v="]').length})`);
        if(wc.getURL().includes('/results?') && result.results>0)return result;
        await new Promise(resolve=>setTimeout(resolve,200));
      }
      return result;
    });
    await writeFile(path.join(root,'live-search.png'),await native(async()=> (await globalThis.__youtubeQA.view.webContents.capturePage()).toPNG()));
    await page.getByLabel('搜索视频或粘贴油管链接').fill('https://www.youtube.com/watch?v=M7lc1UVf-VE');
    await page.getByRole('button',{name:'搜索',exact:true}).click();
    await page.getByRole('button',{name:'采集当前视频',exact:true}).waitFor();
    await page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='采集当前视频')?.disabled && document.body.textContent.includes('watch?v=M7lc1UVf-VE'));
    await new Promise(resolve=>setTimeout(resolve,12000));
    const video=await native(async()=>globalThis.__youtubeQA.view.webContents.executeJavaScript('({title:document.title,video:!!document.querySelector("video"),time:document.querySelector("video")?.currentTime,paused:document.querySelector("video")?.paused,error:document.querySelector(".ytp-error-content-wrap")?.textContent})'));
    await writeFile(path.join(root,'live-video.png'),await native(async()=> (await globalThis.__youtubeQA.view.webContents.capturePage()).toPNG()));
    console.log(JSON.stringify({live:true,root,search,video,state:await native(()=>globalThis.__youtubeQA.browser.getState())},null,2));
    assert.ok(search.results>0,'real YouTube search did not return videos');
    assert.ok(video.video && video.time>0 && !video.error,'real YouTube playback did not start');
  } else {
    await native(()=>globalThis.__youtubeQA.view.webContents.executeJavaScript('document.querySelector("#video").click()',true));
    await page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='采集当前视频')?.disabled);
    await page.getByRole('button',{name:'后退',exact:true}).click();
    await page.waitForFunction(()=>document.body.textContent.includes('/results?search_query=AI+skills'));
    await page.getByRole('button',{name:'前进',exact:true}).click();
    await page.waitForFunction(()=>document.body.textContent.includes('watch?v=M7lc1UVf-VE'));
    await native(()=>globalThis.__youtubeQA.view.webContents.executeJavaScript('document.querySelector("#spa").click()'));
    await page.waitForFunction(()=>document.body.textContent.includes('/shorts/dQw4w9WgXcQ'));
    await page.evaluate(()=>document.getElementById('root').setAttribute('inert',''));
    await page.waitForTimeout(100);
    assert.equal(await native(()=>globalThis.__youtubeQA.view.getVisible()),false);
    await page.evaluate(()=>document.getElementById('root').removeAttribute('inert'));
    await page.waitForTimeout(100);
    assert.equal(await native(()=>globalThis.__youtubeQA.view.getVisible()),true);
    await native(()=>globalThis.__youtubeQA.win.setSize(800,600));
    await page.waitForTimeout(150);
    const rect=await page.getByTestId('youtube-viewport').boundingBox();
    const bounds=await native(()=>globalThis.__youtubeQA.view.getBounds());
    assert.ok(Math.abs(rect.x-bounds.x)<2 && Math.abs(rect.y-bounds.y)<2,'native view must match renderer viewport');
    assert.ok(bounds.x+bounds.width<=800 && bounds.y+bounds.height<=600);
    await native(()=>globalThis.__youtubeQA.view.webContents.executeJavaScript('document.querySelector("#external").click()'));
    await page.getByRole('alert').filter({hasText:'不属于油管浏览范围'}).waitFor();
    assert.equal(await native(()=>globalThis.__youtubeQA.view.getVisible()),false);
    await page.getByRole('button',{name:'刷新油管页面',exact:true}).click();
    await page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='采集当前视频')?.disabled);
    await writeFile(path.join(root,'desktop.png'),await native(async()=> (await globalThis.__youtubeQA.win.capturePage()).toPNG()));
    await writeFile(path.join(root,'native-video.png'),await native(async()=> (await globalThis.__youtubeQA.view.webContents.capturePage()).toPNG()));
    await native(()=>globalThis.__youtubeQA.win.setSize(390,800));
    await page.waitForTimeout(250);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.getByRole('button',{name:'更多',exact:true}).click();
    await page.getByRole('dialog').waitFor();
    await page.waitForTimeout(150);
    assert.equal(await native(()=>globalThis.__youtubeQA.view.getVisible()),false);
    await page.getByRole('dialog').getByRole('button',{name:'油管',exact:true}).click();
    await page.getByRole('dialog').waitFor({state:'hidden'});
    await page.waitForTimeout(150);
    assert.equal(await native(()=>globalThis.__youtubeQA.view.getVisible()),true);
    await page.screenshot({path:path.join(root,'mobile.png')});
    await native(()=>globalThis.__youtubeQA.win.setSize(1200,800));
    await page.waitForTimeout(150);
    let requests=0;
    await page.route('**/api/jobs', async route=>{if(route.request().method()==='POST'){requests++;if(requests===1)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'测试创建失败'})});await new Promise(resolve=>setTimeout(resolve,200));}await route.continue();});
    await page.getByRole('button',{name:'采集当前视频',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'测试创建失败'}).waitFor();
    await page.evaluate(()=>{const button=Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='采集当前视频');button.click();button.click();});
    await page.waitForURL(/\/jobs\//);
    assert.equal(requests,2,'failed attempt plus one successful capture despite double click');
    assert.equal(await native(()=>globalThis.__youtubeQA.view.getVisible()),false);
    assert.equal(await native(()=>globalThis.__youtubeQA.view.webContents.isAudioMuted()),true);
    const jobs=await (await fetch(`http://127.0.0.1:${port}/api/jobs`)).json();
    assert.equal(jobs.jobs.length,1);const job=jobs.jobs[0];
    assert.equal(job.sourceUrl,'https://www.youtube.com/watch?v=dQw4w9WgXcQ');assert.equal(job.workflowMode,'manual');assert.ok(Object.values(job.steps).every(step=>step.status==='pending'));assert.equal(job.videoPath,undefined);
    await page.evaluate(()=>location.hash='/youtube');
    await page.getByRole('button',{name:'采集当前视频',exact:true}).waitFor();
    await page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='采集当前视频')?.disabled);
    assert.equal(await native(()=>globalThis.__youtubeQA.win.contentView.children.length),1);
    await page.reload();await page.getByRole('heading',{name:'油管',exact:true,level:1}).waitFor();
    await page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='采集当前视频')?.disabled);
    assert.equal(await native(()=>globalThis.__youtubeQA.win.contentView.children.length),1);
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({root,checks:['isolated sandboxed guest without preload','search/history/SPA','modal hides native view','resize bounds','blocked external navigation and recovery','API failure and double-click guard','one manual job and detail navigation','unmount hides and mutes','return/reload preserves one native view'],errors},null,2));
  }
} catch(error) {
  if(application){console.error('Native QA failure',await application.evaluate(()=>globalThis.__youtubeQA.browser.getState()));const page=(await application.windows())[0];console.error(await page.locator('body').innerText());await page.screenshot({path:path.join(root,'failure.png')});}
  throw error;
} finally {
  if(application)await application.close();
  await new Promise(resolve=>server.close(resolve));
  // Keep screenshots/results only; delete isolated browsing and job data.
  await rm(path.join(root,'storage'),{recursive:true,force:true});
  await rm(path.join(root,'profile'),{recursive:true,force:true});
}
