import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { _electron as electron, chromium } from 'playwright';
import { createExpressApp } from '../dist/app.js';
import { inspectTranscriptQuality } from '../dist/lib/transcript-quality.js';
import { createHash, randomUUID } from 'node:crypto';
import { AsrService } from '../dist/lib/asr.js';
import { MediaService } from '../dist/lib/media.js';
import { LocalStorage } from '../dist/lib/storage.js';

// Uses live YouTube, the active desktop AI configuration, real yt-dlp/ASR/FFmpeg and Chromium.
// Never prints or saves credentials; all works and browser login state are isolated.
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const sourceUrl = option('url') ?? 'https://www.youtube.com/watch?v=fOxC44g8vig';
const root = option('storage') ?? await mkdtemp(path.join(tmpdir(), 'youtube-workflow-'));
const repo = path.resolve(import.meta.dirname, '..');
const runtimeRepo = option('runtime') ?? repo;
await mkdir(root, { recursive: true });
await mkdir(path.join(root, 'profile'), { recursive: true });
console.log('LIVE_QA_ROOT', root);
let config;
const desktop = await chromium.connectOverCDP(option('desktop') ?? 'http://localhost:9336');
try {
  const page = desktop.contexts()[0].pages().find(page => page.url().startsWith('http://localhost:5173') || page.url().startsWith('file:'));
  assert.ok(page, 'Open the desktop project before running live verification');
  config = await page.evaluate(async () => {
    const key = (await window.electron.getConfig()).aiKeys.find(key => key.isActive);
    return key ? { provider: key.provider, model: key.model, apiKey: key.apiKey, baseURL: key.baseURL, maxOutputTokens: key.maxOutputTokens } : null;
  });
} finally { await desktop.close(); }
assert.ok(config?.apiKey && config.model, 'An active desktop AI key is required');
console.log('AI runtime', { provider: config.provider, model: config.model });
const desktopAccessToken=randomUUID();
const app = await createExpressApp({ desktopAccessToken, rootDir: repo, storagePath: path.join(root, 'storage'), resolveAiConfig: async () => config,
  ytDlpBinary: path.join(runtimeRepo, 'vendor/package-assets/bin/yt-dlp'), ytDlpJsRuntime: process.execPath,
  whisperCliPath: path.join(runtimeRepo, 'vendor/whisper/whisper-cli'), whisperModelPath: path.join(runtimeRepo, 'vendor/whisper/models/ggml-small.bin'),
});
const server = createServer(app);await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
const session = await (await fetch(base + '/api/local-sessions/auto', { method: 'POST' })).json();
const request = async (url, body, method = body === undefined ? 'GET' : 'POST') => {
  const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Local-Session': session.session.token, 'X-Desktop-Access': desktopAccessToken }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();assert.ok(response.ok, `${response.status}: ${data.message ?? data.code}`);return data;
};
const entry = path.join(root, 'main.cjs');
await writeFile(entry, `
const {app,BrowserWindow,WebContentsView,ipcMain}=require('electron');
const {pathToFileURL}=require('node:url');
const {YoutubeBrowser,registerYoutubeBrowserHandlers}=require(${JSON.stringify(path.join(repo, 'dist-electron/youtube-browser.js'))});
app.setPath('userData',${JSON.stringify(path.join(root, 'profile'))});
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1300,height:950,webPreferences:{preload:${JSON.stringify(path.join(repo,'dist-electron/preload.js'))},contextIsolation:true,nodeIntegration:false,sandbox:false}});
 ipcMain.handle('get-server-port',()=>${port});
 ipcMain.handle('get-config',()=>({aiKeys:[],app:{theme:'dark',themeConfigured:true,firstRun:false}}));
 ipcMain.handle('save-config',()=>{});ipcMain.handle('get-version',()=> 'live-qa');
 const browser=new YoutubeBrowser(win,()=>new WebContentsView({webPreferences:{partition:'persist:youtube-browser',nodeIntegration:false,contextIsolation:true,sandbox:true}}));
 globalThis.__workflowQA={win,browser};
 const rendererUrl=pathToFileURL(${JSON.stringify(path.join(repo,'dist-renderer/index.html'))}).href;
 win.webContents.session.webRequest.onBeforeSendHeaders({urls:['http://localhost:${port}/*']},(details,callback)=>{
  const headers={...details.requestHeaders};
  if(details.webContentsId===win.webContents.id && details.frame?.url.split('#')[0]===rendererUrl)headers['X-Desktop-Access']=process.env.WORKFLOW_QA_ACCESS_TOKEN;
  callback({requestHeaders:headers});
 });
 const dispose=registerYoutubeBrowserHandlers(ipcMain,win,browser,pathToFileURL(${JSON.stringify(path.join(repo,'dist-renderer/index.html'))}).href);win.on('closed',dispose);
 await win.loadFile(${JSON.stringify(path.join(repo,'dist-renderer/index.html'))},{hash:'/youtube'});
});app.on('window-all-closed',()=>app.quit());
`);
let application, page, jobId, gallery, manualEditCount = 0;
try {
  application = await electron.launch({ executablePath: path.join(runtimeRepo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [entry], env: {...process.env, WORKFLOW_QA_ACCESS_TOKEN:desktopAccessToken}, timeout: 20000 });
  page = await application.firstWindow();page.setDefaultTimeout(30000);
  await page.getByRole('heading', {name:'油管',level:1,exact:true}).waitFor();
  const existing = (await request('/api/jobs')).jobs.find(job => job.sourceUrl === sourceUrl);
  if(existing){jobId=existing.id;await page.evaluate(id=>location.hash=`/jobs/${id}`,jobId);console.log('Resume isolated work',jobId);}
  else {
    await page.getByLabel('搜索视频或粘贴油管链接').fill(sourceUrl);await page.getByRole('button',{name:'搜索',exact:true}).click();
    await page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='采集当前视频')?.disabled);
    await page.getByRole('button',{name:'采集当前视频',exact:true}).click();await page.waitForURL(/\/jobs\//);
    jobId=new URL(page.url()).hash.split('/').at(-1);
    console.log('Captured live video',jobId);
  }
  let job=(await request(`/api/jobs/${jobId}`)).job;
  assert.equal(job.sourceUrl,sourceUrl);assert.equal(job.workflowMode,'manual');
  if(job.steps.transcribe.status!=='succeeded'){
    console.log('Transcribing complete source video');
    const done=page.waitForResponse(response=>response.url().endsWith(`/api/jobs/${jobId}/steps/transcribe`) && response.request().method()==='POST',{timeout:900000});
    await page.locator('[data-primary-action]').click();const response=await done;const data=await response.json();assert.ok(response.ok(),data.message ?? data.error ?? `transcribe HTTP ${response.status()}`);
    job=(await request(`/api/jobs/${jobId}`)).job;
  }
  assert.equal(job.steps.transcribe.status,'succeeded');
  const transcript=(await request(`/api/jobs/${jobId}/raw-transcript`)).rawTranscript;
  assert.ok(transcript.segments?.length>0);assert.deepEqual(inspectTranscriptQuality({text:transcript.transcript,segments:transcript.segments,duration:transcript.duration}),[]);
  console.log('Transcript ready',{provider:transcript.provider,language:transcript.language,segments:transcript.segments.length,duration:transcript.duration});
  gallery=(await request('/api/galleries')).galleries.find(g=>g.sourceJobId===jobId);
  if(gallery)await page.evaluate(id=>location.hash=`/galleries/${id}`,gallery.id);
  else{
    await page.getByRole('link',{name:'制作字幕图集',exact:true}).click();
    await page.getByRole('button',{name:'新建字幕图集',exact:true}).click();await page.waitForURL(/\/galleries\/[^/?]+$/);
    const id=new URL(page.url()).hash.split('/').at(-1);gallery=(await request(`/api/galleries/${id}`)).gallery;
  }
  assert.equal(gallery.mode,'translated');
  const url=`/api/galleries/${gallery.id}`;
  const source=(await request(url+'/source')).source;
  if(!gallery.translation || process.argv.includes('--retranslate')){
    console.log('Translating complete source',{duration:source.duration,segments:transcript.segments.length});
    const done=page.waitForResponse(response=>response.url().endsWith(url+'/translate') && response.request().method()==='POST',{timeout:900000});
    await page.getByRole('button',{name:'翻译完整视频',exact:true}).click();
    if(gallery.translation)await page.getByRole('dialog').getByRole('button',{name:'重新翻译',exact:true}).click();
    const response=await done;const data=await response.json();assert.ok(response.ok(),data.message);gallery=data.gallery;
  }
  if(option('review')){
    const reviewed=JSON.parse(await readFile(option('review'),'utf8'));
    let edits=0;
    for(const item of reviewed){
      const index=gallery.translation.cues.findIndex(cue=>cue.segmentIndex===item.segmentIndex);
      assert.ok(index>=0 && typeof item.text==='string','review must refer to existing source cues');
      if(gallery.translation.cues[index].text!==item.text){await page.getByLabel(`中文译文 ${index+1}`,{exact:true}).fill(item.text);edits++;}
    }
    if(edits){
      await page.getByRole('button',{name:'保存草稿 *',exact:true}).first().click();
      await page.getByRole('button',{name:'保存草稿',exact:true}).first().waitFor();
      gallery=(await request(url)).gallery;assert.equal(gallery.status,'draft');assert.equal(gallery.plan,undefined);
      manualEditCount=edits;console.log('Saved manually reviewed translations',edits);
    }
  }
  assert.equal(gallery.translation.start,0);assert.equal(gallery.translation.end,source.duration);
  const segments=transcript.segments.map((segment,segmentIndex)=>({...segment,segmentIndex})).filter(segment=>segment.text.trim());
  assert.deepEqual(gallery.translation.cues.map(c=>[c.segmentIndex,c.original,c.start,c.end]),segments.map(s=>[s.segmentIndex,s.text,s.start,Math.min(s.end,source.duration)]));
  assert.ok(gallery.translation.cues.every(cue=>/\p{Script=Han}/u.test(cue.text)));
  await writeFile(path.join(root,'translation-review.json'),JSON.stringify(gallery.translation.cues,null,2));
  console.log('Complete real translation',gallery.translation.cues.length);
  if(sourceUrl==='https://www.youtube.com/watch?v=fOxC44g8vig'){
    const texts=new Map(gallery.translation.cues.map(cue=>[cue.segmentIndex,cue.text]));
    assert.match(texts.get(73)+texts.get(74),/工作流.*可.*能力/, 'workflow phrase must remain in the corresponding adjacent fragments');
    assert.match(texts.get(74),/可复用.*能力/, 'reusable capability must remain at its original cue');
    assert.match(texts.get(77),/PR.*安全/, 'PR security meaning must stay at its original cue');
    assert.doesNotMatch(texts.get(74),/入职|新员工/, 'next cue must not be pulled into current timing');
  }
  if(!gallery.plan){
    await page.getByRole('button',{name:'自动创作整套图文',exact:true}).click();
    await page.getByRole('region',{name:'图集文字方案'}).waitFor({timeout:60000});
    await page.getByLabel('我已核对原句与时间，认可保留和剔除的内容。').check();
    const started=page.waitForResponse(response=>response.url().endsWith(url+'/operation') && response.request().method()==='POST');
    await page.getByRole('button',{name:'认可文字，生成候选',exact:true}).click();assert.equal((await started).status(),202);
    for(let n=0;n<600;n++){
      gallery=(await request(url)).gallery;
      if(gallery.operation?.status==='failed')throw new Error(gallery.operation.error);
      if(gallery.operation?.kind==='candidates'&&gallery.operation.status==='completed'&&gallery.plan)break;
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
  }
  assert.ok(gallery.plan?.images.length>0,'candidate operation did not complete');
  assert.deepEqual(gallery.plan.images.flatMap(image=>image.quotes.map(q=>q.segmentIndex)),gallery.translation.cues.map(cue=>cue.segmentIndex));
  assert.equal(gallery.plan.excluded.length,0);assert.equal(gallery.plan.scope,'full');
  console.log('Candidates complete',{pages:gallery.plan.images.length,copyError:gallery.copyError??null});
  const proposal=page.getByRole('region',{name:'自动图集方案'});
  await proposal.waitFor({timeout:30000});
  await page.getByLabel('我已核对整套候选字幕，认可图片数量与内容安排。').check();
  const started=page.waitForResponse(response=>response.url().endsWith(url+'/operation') && response.request().method()==='POST');
  await page.getByRole('button',{name:'按此方案生成整套图集',exact:true}).click();assert.equal((await started).status(),202);
  for(let n=0;n<600;n++){
    gallery=(await request(url)).gallery;
    if(gallery.operation?.status==='failed')throw new Error(gallery.operation.error);
    if(gallery.operation?.kind==='render'&&gallery.operation.status==='completed'&&gallery.status==='ready'&&gallery.generated)break;
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  assert.equal(gallery.status,'ready');assert.ok(gallery.generated);assert.deepEqual(gallery.generated.hashes,gallery.plan.previewHashes);
  await mkdir(path.join(root,'images'),{recursive:true});
  for(let index=0;index<gallery.images.length;index++){
    const response=await fetch(`${base}${url}/images/${index}?generation=${gallery.generated.id}`);assert.equal(response.status,200);
    const png=Buffer.from(await response.arrayBuffer());assert.equal(png.readUInt32BE(16),1080);assert.equal(png.readUInt32BE(20),1440);
    assert.equal(createHash('sha256').update(png).digest('hex'),gallery.generated.hashes[index]);
    await writeFile(path.join(root,'images',`${index+1}.png`),png);
  }
  let asr;
  if(process.argv.includes('--asr')){
    const asrPath=path.join(root,`${jobId}.asr-review.json`);
    try{asr=JSON.parse(await readFile(asrPath,'utf8'));}
    catch(error){
      if(error.code!=='ENOENT')throw error;
      console.log('Verifying complete local audio transcription');
      const audio=await new MediaService(new LocalStorage(path.join(root,'storage'))).extractAudio(job.videoPath,jobId);
      asr=await new AsrService({whisperCliPath:path.join(runtimeRepo,'vendor/whisper/whisper-cli'),whisperModelPath:path.join(runtimeRepo,'vendor/whisper/models/ggml-small.bin')}).transcribe(audio.audioPath,'auto');
      await writeFile(asrPath,JSON.stringify(asr,null,2));
    }
    assert.equal(asr.provider,'whisper.cpp');assert.equal(asr.language,'en');
    assert.ok(Math.abs(asr.duration-source.duration)<.5);assert.deepEqual(inspectTranscriptQuality(asr),[]);
    assert.match(asr.text,/skills/i);assert.ok(asr.segments.at(-1).end>source.duration-10);
    console.log('Local ASR ready',{provider:asr.provider,language:asr.language,segments:asr.segments.length,duration:asr.duration});
  }
  if(gallery.copyError){
    await page.reload();
    const done=page.waitForResponse(response=>response.url().endsWith(url+'/copy') && response.request().method()==='POST',{timeout:180000});
    await page.getByRole('button',{name:'重新生成文案',exact:true}).click();
    await page.getByRole('dialog').getByRole('button',{name:'重新生成并替换',exact:true}).click();
    const response=await done;assert.ok(response.ok(),(await response.json()).message);
    gallery=(await request(url)).gallery;assert.equal(gallery.copyError,undefined);
  }
  await page.reload();await page.getByRole('heading',{name:'中文译文图集工作台',exact:true}).waitFor();
  await page.screenshot({path:path.join(root,'workbench.png'),fullPage:true});
  const report={sourceUrl,jobId,galleryId:gallery.id,duration:source.duration,provider:transcript.provider,language:transcript.language,segments:segments.length,translated:gallery.translation.cues.length,pages:gallery.images.length,model:config.model,copyError:gallery.copyError??null,allPreviewHashesMatch:true,manualReviewApplied:!!option('review'),manualEditCount,...(asr?{localAsr:{provider:asr.provider,language:asr.language,segments:asr.segments.length,duration:asr.duration}}:{}),root};
  await writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
} catch(error){
  console.error('Workflow failure',error.message);
  if(jobId){const job=(await request(`/api/jobs/${jobId}`)).job;console.error({jobId,stage:job.stage,error:job.steps.transcribe.lastError});}
  if(page){await page.screenshot({path:path.join(root,'failure.png'),fullPage:true}).catch(()=>{});}
  throw error;
} finally {
  config=null;
  // The isolated QA child is disposable; bypass its unsaved-change guard during cleanup.
  if(application){application.process().kill('SIGKILL');await application.close().catch(()=>{});}server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  await rm(path.join(root,'profile'),{recursive:true,force:true});
}
