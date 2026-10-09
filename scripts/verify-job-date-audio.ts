import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { createExpressApp } from '../src/app.js';
import { LocalStorage } from '../src/lib/storage.js';
import { AssetStore } from '../src/lib/assets-store.js';
import { runCommand } from '../src/lib/command.js';
import type { JobRecord } from '../src/types.js';

// Isolated API/UI fixtures. A missing CLI deliberately tests failed-generation recovery;
// actual speech/render verification lives in hyperframes-video.integration.test.ts.
const root = await mkdtemp(path.join(tmpdir(), 'job-date-audio-qa-'));
const storage = new LocalStorage(root); await storage.ensureBaseDirs();
const dates = ['2026-10-08T23:59:59.999Z', '2026-10-09T00:00:00.000Z', '2026-10-09T23:59:59.999Z', '2026-10-10T00:00:00.000Z'];
const ids = ['prior', 'start', 'end', 'next'];
const index: Record<string, JobRecord> = {};
for (let n = 0; n < dates.length; n++) {
  const id = ids[n]!;
  const record: JobRecord = { id, sourceUrl: `https://example.com/video/${id}`, topic: `日期作品-${id}`,
    status: n === 2 ? 'failed' : 'queued', stage: n === 2 ? 'failed' : 'scripted', workflowMode: 'manual', storagePath: `processed/scripts/${id}.json`,
    createdAt: dates[n]!, updatedAt: dates[n]!, steps: {
      transcribe: { status: 'succeeded', attempts: 1 }, clean: { status: 'succeeded', attempts: 1 }, generate_video_prompts: { status: 'succeeded', attempts: 1 },
      generate_video: { status: n === 2 ? 'failed' : 'pending', attempts: n === 2 ? 1 : 0 }
    } };
  index[id] = record;
  const script = { sourceUrl: record.sourceUrl, topic: record.topic, title: record.topic, rawText: '完整中文转录', cleanScript: '完整洗稿内容', status: 'ready', videoPrompts: ['中文分镜'] };
  await storage.writeJson(record.storagePath, script);
  await storage.writeJson(`processed/cleaned/${id}.json`, { output: script });
  await storage.writeJson(`raw/transcripts/${id}.json`, { transcript: '完整中文转录', text: '完整中文转录', segments: [] });
}
await storage.writeJson('cache/jobs-index.json', index);
const musicPath = path.join(root, 'test.wav');
await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=1', musicPath], { captureStderr: true });
const asset = await new AssetStore(storage).add('audio', { originalName: '本机测试音乐.wav', data: await readFile(musicPath) });
const app = await createExpressApp({ rootDir: root, storagePath: root, hyperframesNpxBinary: path.join(root, 'deliberately-missing-cli') });
app.use(express.static(path.resolve('dist-renderer')));
// Production uses Electron file/hash routing; supply a base for this HTTP fixture's deep links.
const rendererHtml = (await readFile(path.resolve('dist-renderer/index.html'), 'utf8')).replace('<head>', '<head><base href="/">');
app.get('*', (_req, res) => res.type('html').send(rendererHtml));
const server = createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;
const browser = await chromium.launch({ executablePath: process.env.QA_BROWSER_BINARY ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const context = await browser.newContext({ timezoneId: 'UTC', viewport: { width: 1440, height: 1000 } });
await context.addInitScript({ content: `window.electron = { getServerPort: async () => ${port} };` });
const page = await context.newPage();
// ActiveJobStrip deliberately shows the current job independently of list filters.
const list = page.locator('div.divide-y.divide-line');
const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(`http://localhost:${port}/`);
  await list.getByRole('heading', { name: '日期作品-start', exact: true }).waitFor();
  await page.getByLabel('创建日期从').fill('2026-10-09'); await page.getByLabel('至', { exact: true }).fill('2026-10-09');
  await list.getByRole('heading', { name: '日期作品-start', exact: true }).waitFor();
  assert.equal(await list.getByRole('heading', { name: '日期作品-end', exact: true }).count(), 1);
  await list.getByRole('heading', { name: '日期作品-prior', exact: true }).waitFor({ state: 'hidden' });
  await list.getByRole('heading', { name: '日期作品-next', exact: true }).waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '失败', exact: true }).click();
  await list.getByRole('heading', { name: '日期作品-end', exact: true }).waitFor();
  await list.getByRole('heading', { name: '日期作品-start', exact: true }).waitFor({ state: 'hidden' });
  await page.getByPlaceholder('搜索标题、来源或摘要').fill('start');
  await page.getByText('没有匹配的作品', { exact: true }).waitFor();
  await page.getByRole('button', { name: '清空筛选条件' }).click();
  assert.equal(await page.getByLabel('创建日期从').inputValue(), '');
  assert.equal(await page.getByPlaceholder('搜索标题、来源或摘要').inputValue(), '');
  await list.getByRole('heading', { name: '日期作品-prior', exact: true }).waitFor();
  await page.getByLabel('创建日期从').fill('2026-10-10'); await page.getByLabel('至', { exact: true }).fill('2026-10-09');
  await page.getByText('创建日期范围有误', { exact: true }).waitFor();
  await page.getByRole('button', { name: '清除日期', exact: true }).click();
  await page.getByRole('button', { name: '卡片视图', exact: true }).click();
  await page.setViewportSize({ width: 760, height: 1000 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'date toolbar must not overflow');
  await page.screenshot({ path: path.join(root, 'date-filter-ui.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`http://localhost:${port}/jobs/start`);
  await page.getByText('成片配音与音乐', { exact: true }).click();
  await page.getByLabel('生成中文配音与同步字幕').waitFor({ state: 'visible' });
  await page.getByLabel('生成中文配音与同步字幕').check();
  await page.getByRole('combobox', { name: /^配音速度/ }).selectOption('240');
  await page.getByRole('combobox', { name: /^背景音乐/ }).selectOption(asset.id);
  await page.screenshot({ path: path.join(root, 'video-audio-ui.png'), fullPage: true });
  const request = page.waitForRequest(req => req.url().endsWith('/steps/generate-video') && req.method() === 'POST');
  await page.locator('[data-primary-action]').click();
  const sent = (await request).postDataJSON();
  assert.deepEqual(sent.audio, { voiceover: true, rate: 240, backgroundAssetId: asset.id });
  await page.getByText(/HyperFrames 本地视频生成环境不可用/).first().waitFor({ timeout: 30_000 });
  const after = await storage.readJson<Record<string, JobRecord>>('cache/jobs-index.json');
  assert.deepEqual(after.start!.videoAudio, sent.audio);
  await page.reload(); await page.getByText(/成片配音与音乐/).first().click();
  assert.equal(await page.getByLabel('生成中文配音与同步字幕').isChecked(), true);
  assert.equal(await page.getByRole('combobox', { name: /^背景音乐/ }).inputValue(), asset.id);
  const invalid = await fetch(`http://127.0.0.1:${port}/api/jobs/start/steps/generate-video`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ audio: { backgroundAssetId: '../../private' } }) });
  assert.equal(invalid.status, 400);
  const record = after.start!; record.status = 'done'; record.steps!.generate_video.status = 'succeeded';
  await storage.writeJson('cache/jobs-index.json', after);
  await page.reload(); await page.getByText(/成片配音与音乐/).first().click();
  await page.getByRole('button', { name: '按当前音频选项重新生成视频' }).waitFor();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ root, checks: ['same-day midnight boundaries', 'status+search+dates', 'empty reset', 'reversed range', 'card and narrow viewport', 'real local voice controls', 'audio request+persist+reload', 'invalid API options 400', 'regeneration control'], errors }, null, 2));
} catch (error) { console.error('UI error body:', await page.locator('body').innerText()); console.error('UI page errors:', errors); await page.screenshot({ path: path.join(root, 'failure.png'), fullPage: true }); console.error('QA root', root); throw error; } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
