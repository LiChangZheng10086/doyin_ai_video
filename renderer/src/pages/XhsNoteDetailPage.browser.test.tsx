import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';
import { chromium } from 'playwright';

test('Xhs editor preserves failed inputs, blocks stale copy and binds real PNG cards at the saved version',
  { skip: process.env.RUN_XHS_NOTES_UI !== '1', timeout: 60_000 }, async () => {
    const initial = { id: 'fixture', version: 1, sourceText: '原文收入 100 元，需要满足条件。', sourceAuthor: '', sourceUrl: '', audience: '', voiceSample: '', instructions: '',
      title: '已有笔记', description: '已有正文', hashtags: ['条件'], cards: [{ title: '中文封面 👨‍👩‍👧‍👦', body: '保留数字 100 元\n\n保留条件。' }], reviewNotes: [], imageMode: 'library', imageAssetIds: ['old'], contentSourceHash: 'valid', createdAt: '', updatedAt: '' };
    const server = await createServer({ plugins: [{ name: 'xhs-note-editor-test', configureServer(instance) {
      instance.middlewares.use('/xhs-editor-test', async (_req, res) => {
        res.setHeader('Content-Type', 'text/html');
        res.end(await instance.transformIndexHtml('/xhs-editor-test', `<html><body><div id="root"></div><script type="module">
import '/src/index.css';
import React from 'react';
import {createRoot} from 'react-dom/client';
import {createMemoryRouter,RouterProvider} from 'react-router-dom';
import {XhsNoteWorkspace} from '/src/pages/XhsNoteDetailPage.tsx';
import {XhsNotesPage} from '/src/pages/XhsNotesPage.tsx';
import {apiClient} from '/src/services/api.ts';
const f=window.fixture={note:${JSON.stringify(initial)},calls:[],failRewrite:true,failSave:false,partial:false,conflictUpload:false,pngs:[]};
const snapshot=()=>structuredClone(f.note);
apiClient.getAssets=async()=>[];
apiClient.getXhsNotes=async()=>[];
apiClient.createXhsNote=async()=>{f.calls.push({kind:'create'});return snapshot()};
apiClient.getAssetRawUrl=async(id)=>f.pngs.find(p=>p.id===id)?.url??'data:image/png;base64,';
apiClient.saveXhsNote=async(id,input)=>{f.calls.push({kind:'save',input:structuredClone(input)});if(f.failSave||input.version!==f.note.version)throw Object.assign(new Error('版本已变化'),{name:'PublishingApiError',status:409});
if(['sourceText','sourceAuthor','sourceUrl','audience','voiceSample','instructions'].some(k=>input[k]!==undefined&&input[k]!==f.note[k]))delete f.note.contentSourceHash;
if(input.cards)delete f.note.cardImageHash;
Object.assign(f.note,input,{version:f.note.version+1});if(input.imageAssetIds&&input.imageMode==='cards')f.note.cardImageHash='cards';return snapshot()};
apiClient.rewriteXhsNote=async(id,version)=>{f.calls.push({kind:'rewrite',version});if(f.failRewrite)throw new Error('AI 改写失败');f.note.contentSourceHash='current';f.note.version++;return snapshot()};
apiClient.uploadImageAssets=async(files)=>{const assets=[];for(const [index,file] of files.entries()){const bitmap=await createImageBitmap(file),id='card-'+index;f.pngs.push({id,type:file.type,width:bitmap.width,height:bitmap.height,url:URL.createObjectURL(file)});bitmap.close();assets.push({id})}if(f.conflictUpload)f.note.version++;return {assets,failures:f.partial?[{index:0,code:'failed',message:'模拟上传失败'}]:[]}};
apiClient.previewXhsNote=async(id,version)=>{f.calls.push({kind:'preview',version});return {note:snapshot(),previewRevision:'revision',imageAssetIds:f.note.imageAssetIds,imageHashes:['h'],imageLimit:18,copyLimits:{titleMax:20,descriptionMax:1000,hashtagMax:10,hashtagLengthMax:20}}};
const router=createMemoryRouter([{path:'/',element:React.createElement(XhsNoteWorkspace,{initial:snapshot()})},{path:'/xhs-notes',element:React.createElement(XhsNotesPage)}]);
createRoot(document.getElementById('root')).render(React.createElement(RouterProvider,{router}));
</script></body></html>`));
      });
    } }], server: { host: '127.0.0.1', port: 0 } });
    await server.listen();
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      const pageErrors: string[] = []; page.on('pageerror', error => pageErrors.push(error.message));
      await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/xhs-editor-test`);
      const original = '字'.repeat(40000) + '📝完整结尾';
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.evaluate(text => navigator.clipboard.writeText(text), original);
      await page.getByLabel('其他平台原文', { exact: true }).fill('');
      await page.getByLabel('其他平台原文', { exact: true }).press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
      await page.getByRole('alert').filter({ hasText: '原文超过 40000 字' }).waitFor();
      assert.equal(await page.getByLabel('其他平台原文', { exact: true }).inputValue(), original);
      assert.equal(await page.getByRole('button', { name: '改写成小红书笔记', exact: true }).isDisabled(), true);
      await page.getByLabel('其他平台原文', { exact: true }).fill('修改后的原文，含否定条件。');
      await page.getByLabel('笔记标题', { exact: true }).fill('手动改标题');
      await page.getByRole('button', { name: '改写成小红书笔记', exact: true }).click();
      await page.getByRole('button', { name: '确认重新改写', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'AI 改写失败' }).waitFor();
      assert.equal(await page.getByLabel('其他平台原文', { exact: true }).inputValue(), '修改后的原文，含否定条件。');
      assert.equal(await page.getByLabel('笔记标题', { exact: true }).inputValue(), '手动改标题');
      assert.equal(await page.getByLabel('笔记正文', { exact: true }).inputValue(), '已有正文');
      assert.equal(await page.getByRole('button', { name: '保存并预览笔记', exact: true }).isDisabled(), true);
      await page.getByLabel('笔记标题', { exact: true }).fill('再次仅改标题');
      await page.getByRole('button', { name: '保存草稿', exact: true }).click();
      await page.getByRole('status').filter({ hasText: '草稿已保存' }).waitFor();
      assert.equal(await page.evaluate(() => (window as any).fixture.note.contentSourceHash), undefined);
      assert.equal(await page.getByRole('button', { name: '保存并预览笔记', exact: true }).isDisabled(), true);
      await page.evaluate(() => { (window as any).fixture.failSave = true; });
      await page.getByLabel('笔记正文', { exact: true }).fill('发生冲突时保留这一段');
      await page.getByRole('button', { name: '保存草稿', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: '当前输入已保留' }).waitFor();
      assert.equal(await page.getByLabel('笔记正文', { exact: true }).inputValue(), '发生冲突时保留这一段');
      await page.evaluate(() => { (window as any).fixture.failSave = false; (window as any).fixture.failRewrite = false; });
      await page.getByRole('button', { name: '改写成小红书笔记', exact: true }).click();
      await page.getByRole('button', { name: '确认重新改写', exact: true }).click();
      await page.getByRole('status').filter({ hasText: '笔记已改写' }).waitFor();
      await page.getByRole('tab', { name: '文字图卡', exact: true }).click();
      await page.evaluate(() => { (window as any).fixture.partial = true; });
      await page.getByRole('button', { name: '保存并生成整套图卡', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: '图卡上传未全部成功' }).waitFor();
      assert.deepEqual(await page.evaluate(() => (window as any).fixture.note.imageAssetIds), ['old']);
      await page.evaluate(() => { (window as any).fixture.partial = false; (window as any).fixture.conflictUpload = true; });
      await page.getByRole('button', { name: '保存并生成整套图卡', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: '当前输入已保留' }).waitFor();
      const result = await page.evaluate(() => {
        const f = (window as any).fixture;
        return { png: f.pngs[0], last: f.calls.at(-1), version: f.note.version, ids: f.note.imageAssetIds };
      });
      assert.deepEqual({ type: result.png.type, width: result.png.width, height: result.png.height }, { type: 'image/png', width: 1080, height: 1440 });
      assert.equal(result.last.input.version, result.version - 1);
      assert.deepEqual(result.ids, ['old']);
      await page.getByRole('link', { name: '返回小红书创作', exact: true }).click();
      await page.getByLabel('其他平台原文', { exact: true }).click();
      await page.getByLabel('其他平台原文', { exact: true }).press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
      await page.getByRole('alert').filter({ hasText: '原文超过 40000 字' }).waitFor();
      assert.equal(await page.getByLabel('其他平台原文', { exact: true }).inputValue(), original);
      assert.equal(await page.getByRole('button', { name: '保存原文，开始创作', exact: true }).isDisabled(), true);
      assert.equal(await page.evaluate(() => (window as any).fixture.calls.filter((c: any) => c.kind === 'create').length), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(pageErrors, []);
    } finally { await browser.close(); await server.close(); }
  });
