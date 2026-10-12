import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import type { Gallery } from '../../../src/lib/gallery-types';

// This browser check is opt-in so ordinary unit runs do not launch Chrome.
test('gallery text confirmation, 202 candidates/render, pause and return restore the same operation', { skip: process.env.RUN_GALLERY_PROGRESS_UI !== '1', timeout: 60_000 }, async () => {
  const image = { mainTime: 1, times: [1], bandTop: .8, bandBottom: .9, mainFraction: .5 };
  const gallery: Gallery = { id: 'g', sourceJobId: 'j', title: '原题', description: '', hashtags: [], images: [image], version: 1, status: 'draft', createdAt: '', updatedAt: '' };
  const textPlan = { id: 'text', transcriptHash: 't', sourceFingerprint: 's', targetLines: 8, estimatedImages: 36, method: 'manual', createdAt: '', items: [
    { id: 'a', segmentIndex: 0, text: '原句一', start: 0, end: 2, selected: true, reason: '' },
    { id: 'b', segmentIndex: 1, text: '原句二', start: 2, end: 4, selected: true, reason: '' },
    { id: 'c', segmentIndex: 2, text: '原句三', start: 4, end: 6, selected: true, reason: '' },
  ] };
  const url = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1440"><rect width="1080" height="1440" fill="green"/></svg>');
  const fixtureMiddleware: import('vite').Connect.NextHandleFunction = async (_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(await server.transformIndexHtml('/gallery-progress-test', `<html><body><div id="root"></div><script type="module">
import '/src/index.css';
import React from 'react';
import {createRoot} from 'react-dom/client';
import {createMemoryRouter,RouterProvider,Link} from 'react-router-dom';
import {GalleryWorkspace} from '/src/pages/GalleryDetailPage.tsx';
import {apiClient} from '/src/services/api.ts';
window.fixture={gallery:${JSON.stringify(gallery)}, calls:[], polls:0};
const f=window.fixture, snapshot=()=>structuredClone(f.gallery), imageUrl=${JSON.stringify(url)};
apiClient.getGallery=async()=>{f.polls++;return snapshot()};
apiClient.getGalleryPlanImageUrl=apiClient.getGalleryImageUrl=async()=>imageUrl;
apiClient.prepareGalleryContent=async()=>{f.gallery.contentPlan=${JSON.stringify(textPlan)};f.gallery.version++;return snapshot()};
apiClient.updateGalleryContent=async(id,version,planId,ids)=>{f.calls.push({kind:'save',ids});f.gallery.contentPlan.items.forEach(i=>i.selected=ids.includes(i.id));f.gallery.contentPlan.estimatedImages=1;f.gallery.version++;return snapshot()};
apiClient.startGalleryOperation=async(id,input)=>{f.calls.push(input);f.gallery.operation={id:'op-'+input.kind,kind:input.kind,status:'running',stage:input.kind==='candidates'?'ocr':input.kind,completed:1,total:3,startedAt:'',updatedAt:''};f.gallery.status='running';return snapshot()};
apiClient.pauseGalleryOperation=async(id,operationId)=>{f.calls.push({kind:'pause',operationId});f.gallery.operation.status='pausing';return snapshot()};
apiClient.resumeGalleryOperation=async(id,operationId)=>{f.calls.push({kind:'resume',operationId});f.gallery.operation.status='running';return snapshot()};
f.complete=()=>{const op=f.gallery.operation;op.status='completed';op.completed=3;f.gallery.version++;f.gallery.status='draft';if(op.kind==='content'){f.gallery.contentPlan.method='ai';f.gallery.contentPlan.items[2].selected=false;f.gallery.contentPlan.items[2].reason='重复建议';f.gallery.contentPlan.estimatedImages=1;}if(op.kind==='candidates'){f.gallery.plan={id:'plan',sourceFingerprint:'s',transcriptHash:'t',warnings:[],excluded:[],images:[{title:'候选',image:${JSON.stringify(image)},quotes:[{segmentIndex:0,text:'原句一',start:0,end:2}]}]};}if(op.kind==='render'){f.gallery.status='ready';f.gallery.generated={id:'generation',draftHash:'d',sourceFingerprint:'s',hashes:['h']};}};
function Screen(){return React.createElement(GalleryWorkspace,{initial:snapshot(),source:{width:320,height:480,duration:6},transcript:{transcript:'原句一原句二原句三',segments:f.gallery.contentPlan?.items??${JSON.stringify(textPlan.items)}}})}
const router=createMemoryRouter([{path:'/',element:React.createElement(Screen)},{path:'/galleries',element:React.createElement(Link,{to:'/'},'返回测试作品')}]);
createRoot(document.getElementById('root')).render(React.createElement(RouterProvider,{router}));
</script></body></html>`));
  };
  const server = await createServer({ plugins: [{ name: 'gallery-progress-test', configureServer(instance) { instance.middlewares.use('/gallery-progress-test', fixtureMiddleware); } }], server: { port: 3286, strictPort: false, host: '127.0.0.1' } });
  await server.listen();
  const address = server.httpServer!.address() as { port: number };
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const pageErrors: string[] = []; page.on('pageerror', e => pageErrors.push(e.message));
    await page.goto(`http://127.0.0.1:${address.port}/gallery-progress-test`);
    await page.getByRole('button', { name: '自动创作整套图文', exact: true }).click();
    const text = page.getByRole('region', { name: '图集文字方案' });
    await text.getByRole('alert').waitFor();
    assert.equal(await page.evaluate(() => (window as any).fixture.calls.length), 0);
    assert.equal(await text.getByRole('button', { name: '认可文字，生成候选' }).isDisabled(), true);
    await text.getByRole('button', { name: 'AI整理内容' }).click();
    await page.getByRole('button', { name: '暂停', exact: true }).waitFor();
    await page.evaluate(() => (window as any).fixture.complete());
    await text.getByText('建议理由：重复建议').waitFor();
    await text.getByRole('button', { name: '恢复全部内容' }).click();
    assert.equal(await page.getByRole('button', { name: '保存草稿', exact: true }).first().isDisabled(), true);
    await text.getByRole('button', { name: '保存内容选择' }).click();
    await page.waitForFunction(() => (window as any).fixture.calls.some((c: any) => c.kind === 'save' && c.ids.length === 3));
    await text.getByLabel('我已核对原句与时间，认可保留和剔除的内容。').check();
    await text.getByRole('button', { name: '认可文字，生成候选' }).click();
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await page.getByRole('heading', { name: /识别原视频字幕 · 暂停中/ }).waitFor();
    await page.evaluate(() => (window as any).fixture.gallery.operation.status = 'paused');
    await page.getByRole('button', { name: '继续', exact: true }).waitFor();
    await page.getByRole('link', { name: '← 图集创作', exact: true }).click();
    await page.getByRole('link', { name: '返回测试作品' }).click();
    await page.getByRole('button', { name: '继续', exact: true }).click();
    await page.getByRole('button', { name: '暂停', exact: true }).waitFor();
    await page.evaluate(() => (window as any).fixture.complete());
    await page.getByAltText('第1张候选字幕拼图').waitFor();
    await page.getByLabel('我已核对整套候选字幕，认可图片数量与内容安排。').check();
    await page.getByRole('button', { name: '按此方案生成整套图集' }).click();
    await page.getByRole('heading', { name: '生成成品图片 · 处理中', exact: true }).waitFor();
    await page.evaluate(() => (window as any).fixture.complete());
    await page.getByAltText('成品第1张').waitFor();
    const calls = await page.evaluate(() => (window as any).fixture.calls);
    assert.equal(calls.filter((c: any) => c.kind === 'candidates').length, 1);
    assert.equal(calls.find((c: any) => c.kind === 'candidates').contentConfirmed, true);
    assert.equal(calls.find((c: any) => c.kind === 'render').subtitlesConfirmed, true);
    assert.equal(calls.find((c: any) => c.kind === 'resume').operationId, 'op-candidates');
    await text.getByRole('checkbox').first().uncheck();
    assert.equal(await page.getByRole('button', { name: '按此方案生成整套图集' }).isDisabled(), true);
    const departureWarning = page.waitForEvent('dialog');
    page.once('dialog', async dialog => { await dialog.dismiss(); });
    await page.getByRole('link', { name: '← 图集创作', exact: true }).click();
    assert.match((await departureWarning).message(), /未保存/);
    await text.getByRole('button', { name: '保存内容选择' }).waitFor();
    assert.deepEqual(pageErrors, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  } finally { await browser.close(); await server.close(); }
});
