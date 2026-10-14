/** Isolated API/Chromium/Canvas acceptance. AI is deterministic; no user data or platform submission. */
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createExpressApp } from '../src/app.js';
import { LocalStorage } from '../src/lib/storage.js';

const root = await mkdtemp(path.join(tmpdir(), 'xhs-note-workspace-'));
const output = path.resolve('output/playwright/xhs-note-workspace-qa');
await mkdir(output, { recursive: true });
let failRewrite = false;
let rewrites = 0;
const content = {
  title: '整理资料先保留出处',
  description: '示例作者整理社团资料时，先记录原文作者与出处，再区分事实和个人判断。资料不完整时保留不确定性，不能把计划写成已完成。\n\n这份做法适合需要反复核对资料的同学。它没有给出节省时间的数据，也没有证明所有场景都适用。',
  hashtags: ['资料整理', '学习笔记'],
  cards: [
    { title: '整理资料先保留出处', body: '作者、出处、条件。\n先把这些信息保留下来，再调整表达。' },
    { title: '分清事实与判断', body: '资料写了什么，就保留什么。\n没有依据的效果不补写，计划不能写成已完成。' },
    { title: '不确定的地方仍然保留', body: '长中文句子与换行需要真实测量，不能为了把文字塞进一张图里就裁掉结尾。👩‍💻\n信息不完整时，先记下需要核对的部分。' },
  ],
  reviewNotes: ['合成验收文本，不证明模型写作质量。'],
};
const app = await createExpressApp({ rootDir: process.cwd(), storagePath: root,
  xhsNoteWriter: { rewrite: async () => { rewrites++; if (failRewrite) throw new Error('controlled AI failure'); return structuredClone(content); } },
});
app.use(express.static(path.resolve('dist-renderer')));
const html = (await readFile(path.resolve('dist-renderer/index.html'), 'utf8')).replace('<head>', '<head><base href="/">');
app.get('*', (_req, res) => res.type('html').send(html));
const server = createServer(app);
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;
const browser = await chromium.launch({ executablePath: process.env.QA_BROWSER_BINARY ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
await context.addInitScript({ content: `window.electron = { getServerPort: async () => ${port} };` });
const page = await context.newPage();
const errors: string[] = [];
page.on('pageerror', error => errors.push(error.message));
const storage = new LocalStorage(root);
let token = '';
const request = async (url: string, method = 'GET', body?: unknown) => {
  const perform = async () => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { 'Content-Type': 'application/json', 'X-Local-Session': token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  let result = await perform();
  if (result.status === 401 && result.body.code === 'local_session_required' && url !== '/api/local-sessions/auto') {
    const session = await fetch(`http://127.0.0.1:${port}/api/local-sessions/auto`, { method: 'POST' });
    token = (await session.json()).session.token;
    result = await perform();
  }
  return result;
};
try {
  token = (await request('/api/local-sessions/auto', 'POST', {})).body.session.token;
  await page.goto(`http://localhost:${port}/xhs-notes`);
  await page.getByLabel('其他平台原文', { exact: true }).fill('示例作者说：我整理社团资料时，先记录原文作者与出处，再区分事实和个人判断。资料不完整时保留不确定性，不把计划写成已经完成。没有给出节省时间的数据，也不能证明所有场景都适用。');
  await page.getByRole('button', { name: '保存原文，开始创作', exact: true }).click();
  await page.waitForURL('**/xhs-notes/*');
  const id = new URL(page.url()).pathname.split('/').at(-1)!;
  const url = `/api/xhs-notes/${id}`;
  await page.getByLabel('原作者', { exact: true }).fill('示例作者');
  await page.getByLabel('出处链接', { exact: true }).fill('https://example.com/original');
  await page.getByLabel('目标读者', { exact: true }).fill('需要整理资料的同学');
  await page.getByRole('button', { name: '改写成小红书笔记', exact: true }).click();
  await page.getByLabel('笔记标题', { exact: true }).evaluate((element, title) => { if ((element as HTMLInputElement).value !== title) throw new Error('rewrite not ready'); }, content.title).catch(async () => {
    await page.waitForFunction(title => (document.querySelector('[aria-label="笔记标题"]') as HTMLInputElement)?.value === title, content.title);
  });
  assert.equal(rewrites, 1);
  assert.equal(await page.getByLabel('笔记正文', { exact: true }).inputValue(), content.description);
  assert.equal((await request('/api/jobs')).body.jobs.length, 0, 'standalone notes must not fabricate jobs');
  await page.getByRole('tab', { name: '文字图卡', exact: true }).click();
  await page.getByRole('button', { name: /生成.*图卡/ }).click();
  await page.getByText('整套图卡已生成并绑定，可按下方顺序核对图片。', { exact: true }).waitFor();
  const generated = (await request(url)).body.note;
  assert.equal(generated.imageMode, 'cards'); assert.ok(generated.cardImageHash);
  assert.equal(generated.imageAssetIds.length, 3);
  const assets = (await request('/api/assets?kind=image')).body.assets;
  for (const id of generated.imageAssetIds) {
    const asset = assets.find((value: any) => value.id === id);
    assert.equal(asset.width, 1080); assert.equal(asset.height, 1440);
  }
  const first = assets.find((value: any) => value.id === generated.imageAssetIds[0]);
  await writeFile(path.join(output, 'text-card.png'), await readFile(storage.resolve('assets/images', first.filename)));
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(output, 'workspace-cards.png'), fullPage: true });
  await page.reload();
  await page.waitForFunction(title => (document.querySelector('[aria-label="笔记标题"]') as HTMLInputElement)?.value === title, content.title);
  assert.equal(await page.getByLabel('原作者').inputValue(), '示例作者');
  await page.getByRole('tab', { name: '上传 / 素材库', exact: true }).click();
  await page.getByLabel('上传图片', { exact: true }).setInputFiles({ name: '本机上传验收.png', mimeType: 'image/png', buffer: await readFile(path.join(output, 'text-card.png')) });
  await page.getByText('图片已加入选图，请保存草稿。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await page.getByText('草稿已保存', { exact: true }).last().waitFor();
  const selected = (await request(url)).body.note;
  assert.equal(selected.imageMode, 'library'); assert.equal(selected.imageAssetIds.length, 4);
  const previewResponse = await request(url + '/publishing/preview', 'POST', { version: selected.version });
  assert.equal(previewResponse.status, 200, JSON.stringify(previewResponse.body));
  const revision = previewResponse.body.preview.previewRevision;
  const moved = (await request(url, 'PATCH', { version: selected.version, imageAssetIds: [...selected.imageAssetIds].reverse() })).body.note;
  assert.equal((await request(url + '/publishing/packages', 'POST', { version: moved.version, previewRevision: revision, rightsConfirmed: true })).status, 409);
  await page.reload();
  await page.getByLabel('笔记标题', { exact: true }).waitFor();
  await page.getByRole('button', { name: /预览.*发布|发布.*预览|保存.*预览/ }).click();
  await page.getByRole('checkbox', { name: /确认拥有原文和素材的使用权/ }).check();
  await page.getByRole('button', { name: '创建小红书发布包', exact: true }).click();
  await page.waitForURL('**/publishing?**');
  const details = (await request('/api/publishing/packages?status=all')).body.packages;
  assert.equal(details.length, 1);
  const detail = details[0];
  assert.equal(detail.package.sourceKind, 'xhs_note'); assert.equal(detail.package.sourceNoteId, id);
  assert.deepEqual(detail.tasks.map((task: any) => task.platform), ['xiaohongshu']);
  assert.deepEqual(detail.package.xhsOptions, { aiDeclaration: true, submit: false });
  assert.equal(detail.package.imagePaths.length, 4);
  assert.ok(detail.tasks.every((task: any) => !task.autoPublish), 'creating a package cannot submit to a platform');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(output, 'publishing.png'), fullPage: true });
  failRewrite = true;
  const before = (await request(url)).body.note;
  assert.equal((await request(url + '/rewrite', 'POST', { version: before.version })).status >= 400, true);
  assert.deepEqual((await request(url)).body.note, before, 'AI failure must retain copy and images');
  await page.goto(`http://localhost:${port}/xhs-notes/${id}`);
  await page.getByLabel('笔记标题', { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'workspace must fit mobile width');
  await page.screenshot({ path: path.join(output, 'workspace-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  await request(url, 'DELETE', { version: before.version });
  assert.equal((await request('/api/publishing/packages?status=all')).body.packages.length, 1, 'deleting a draft must preserve self-contained delivery');
  console.log(JSON.stringify({ ok: true, images: 4, textCards: 3, canvas: '1080x1440', sourceIndependent: true, staleRevisionRejected: true, AI: 'deterministic fixture only', platformSubmitted: false, screenshots: output }));
} finally {
  await context.close(); await browser.close(); server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
