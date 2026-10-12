/** Isolated real-video OCR/FFmpeg pause check; never changes source data or publishes. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { createExpressApp } from '../src/app.js';
import { GalleryMedia } from '../src/lib/gallery-media.js';
import { LocalStorage } from '../src/lib/storage.js';
import { resolveToutiaoBrowser } from '../src/lib/toutiao-browser.js';
import type { Gallery } from '../src/lib/gallery-types.js';

const args = new Map(process.argv.slice(2).map(arg => { const i = arg.indexOf('='); return [arg.slice(0, i), arg.slice(i + 1)]; }));
const sourceStorage = args.get('--storage'); const sourceId = args.get('--job');
assert.ok(sourceStorage && sourceId, 'Use --storage=/absolute/storage --job=existing-job-id');
const out = path.resolve(args.get('--out') ?? 'output/playwright/gallery-operations');
const root = await mkdtemp(path.join(tmpdir(), 'gallery-operations-'));
const storage = new LocalStorage(root);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const originalJobs = await readFile(path.join(sourceStorage, 'cache/jobs-index.json'));
const originalGalleries = await readFile(path.join(sourceStorage, 'cache/galleries.json'));
const transcriptBytes = await readFile(path.join(sourceStorage, 'raw/transcripts', `${sourceId}.json`));
const job = JSON.parse(originalJobs.toString())[sourceId]; assert.ok(job?.videoPath);
const trace: { kind: string; at: number; output?: string }[] = [];
const exec = promisify(execFile);
const ocrProcesses = new Set<string>();
let monitoring = true;
const monitor = (async () => {
  while (monitoring) {
    const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,command=']);
    for (const line of stdout.split('\n')) {
      const found = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
      if (found && Number(found[2]) === process.pid && found[3]!.includes('subtitle-ocr ')) ocrProcesses.add(found[1]!);
    }
    await sleep(80);
  }
})();
const originalSuggest = GalleryMedia.prototype.suggestSubtitles;
const originalRender = GalleryMedia.prototype.render;
GalleryMedia.prototype.suggestSubtitles = async function (...input) {
  trace.push({ kind: 'ocr-window', at: Date.now() }); return originalSuggest.apply(this, input);
};
GalleryMedia.prototype.render = async function (...input) {
  trace.push({ kind: 'render', at: Date.now(), output: input[2] }); return originalRender.apply(this, input);
};
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<express.Express['listen']> | undefined;
const results: Record<string, unknown> = {};
try {
  await storage.ensureBaseDirs(); await mkdir(out, { recursive: true });
  const videoPath = storage.resolve(`raw/videos/${sourceId}.mp4`);
  await copyFile(job.videoPath, videoPath);
  await storage.writeJson('cache/jobs-index.json', { [sourceId]: { ...job, videoPath, storagePath: `processed/scripts/${sourceId}.json` } });
  await writeFile(storage.resolve(`raw/transcripts/${sourceId}.json`), transcriptBytes);
  const app = await createExpressApp({ storagePath: root, rootDir: process.cwd(),
    galleryContentPlanner: { plan: async (items, control) => { await control?.checkpoint?.(); await control?.progress?.(1, 1); return items.map(item => ({ ...item, reason: '隔离交互夹具：保留原句' })); } },
    galleryCopyWriter: { write: async () => ({ title: '暂停验收', description: '真实视频隔离验收，不发布。', hashtags: [], notes: [] }) },
  });
  const html = await readFile(path.resolve('dist-renderer/index.html'), 'utf8');
  app.use(express.static(path.resolve('dist-renderer'), { index: false }));
  let port = 0;
  app.get('*', (req, res) => { if (req.path.startsWith('/api/')) { res.status(404).end(); return; }
    res.type('html').send(html.replaceAll('./assets/', '/assets/').replace('<head>', `<head><script>window.electron={getServerPort:async()=>${port},getConfig:async()=>({aiKeys:[],app:{theme:'light'}}),saveConfig:async()=>{}};</script>`)); });
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server!.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object'); port = address.port;
  const base = `http://127.0.0.1:${port}`;
  let token = '';
  const request = async (url: string, data?: unknown, method = data === undefined ? 'GET' : 'POST', expected = 200) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Local-Session': token }, body: data === undefined ? undefined : JSON.stringify(data) });
    const body = await response.json(); assert.equal(response.status, expected, JSON.stringify(body)); return body;
  };
  token = (await request('/api/local-sessions/auto', {}, 'POST', 201)).session.token;
  const get = async (id: string): Promise<Gallery> => (await request(`/api/galleries/${id}`)).gallery;
  const wait = async (id: string, predicate: (g: Gallery) => boolean, timeout = 180_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const gallery = await get(id); if (predicate(gallery)) return gallery; await sleep(50); }
    throw new Error(`Timed out: ${JSON.stringify((await get(id)).operation)}`);
  };
  let gallery: Gallery = (await request('/api/galleries', { sourceJobId: sourceId, mode: 'native' }, 'POST', 201)).gallery;
  const url = `/api/galleries/${gallery.id}`;
  const source = (await request(url + '/source')).source;
  gallery = (await request(url + '/content-plan', { version: gallery.version, targetLines: 8 })).gallery;
  assert.ok(gallery.contentPlan!.estimatedImages > 35, 'Fixture must be a real long video exceeding35');
  gallery = (await request(url + '/content-plan', { version: gallery.version, contentPlanId: gallery.contentPlan!.id, selectedIds: gallery.contentPlan!.items.map(item => item.id) }, 'PATCH')).gallery;
  const initialCalls = trace.length;
  const oversized = await request(url + '/operation', { version: gallery.version, kind: 'candidates', contentPlanId: gallery.contentPlan!.id, contentConfirmed: true }, 'POST', 422);
  assert.match(JSON.stringify(oversized), /35/);
  assert.equal(trace.length, initialCalls, 'Over35 must not start OCR or drawing');
  results.preflight = { duration: source.duration, segments: JSON.parse(transcriptBytes.toString()).segments.length, estimatedImages: gallery.contentPlan!.estimatedImages, mediaCalls: 0 };
  console.log(JSON.stringify({ phase: 'preflight passed', ...results.preflight as object }));
  gallery = (await request(url + '/content-plan', { version: gallery.version, targetLines: 3 })).gallery;
  const selectedIds = gallery.contentPlan!.items.slice(0, 12).map(item => item.id);
  gallery = (await request(url + '/content-plan', { version: gallery.version, contentPlanId: gallery.contentPlan!.id, selectedIds }, 'PATCH')).gallery;
  const target = resolveToutiaoBrowser({ repoRoot: process.cwd(), env: {}, allowSystemChrome: true }).target;
  assert.equal(target.kind, 'executablePath');
  browser = await chromium.launch({ executablePath: target.kind === 'executablePath' ? target.path : undefined, headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  context.on('response', response => {
    if (new URL(response.url()).pathname === '/api/local-sessions/auto' && response.status() === 201) {
      void response.json().then(body => { token = body.session.token; });
    }
  });
  const page = await context.newPage(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + `/galleries/${gallery.id}`);
  await page.getByRole('heading', { name: '字幕图集工作台', exact: true }).waitFor();
  const start = Date.now();
  gallery = (await request(url + '/operation', { version: gallery.version, kind: 'candidates', contentPlanId: gallery.contentPlan!.id, contentConfirmed: true, targetLines: 3 }, 'POST', 202)).gallery;
  results.startMs = Date.now() - start;
  await wait(gallery.id, () => ocrProcesses.size >= 2, 30_000);
  gallery = (await request(url + '/operation/pause', { operationId: gallery.operation!.id })).gallery;
  gallery = await wait(gallery.id, g => g.operation?.status === 'paused', 30_000);
  const paused = { ...gallery.operation! }; const callCount = trace.length;
  const ocrPaused = ocrProcesses.size;
  await sleep(2100); assert.equal(trace.length, callCount); assert.deepEqual((await get(gallery.id)).operation, paused);
  assert.equal(ocrProcesses.size, ocrPaused, 'No further real OCR processes while paused');
  console.log(JSON.stringify({ phase: 'OCR pause passed', operation: paused }));
  await page.reload(); await page.getByRole('progressbar').waitFor();
  await page.getByRole('button', { name: '继续', exact: true }).waitFor();
  await page.screenshot({ path: path.join(out, 'candidate-paused-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(out, 'candidate-paused-mobile.png'), fullPage: true });
  let other: Gallery = (await request('/api/galleries', { sourceJobId: sourceId, mode: 'native' }, 'POST', 201)).gallery;
  const concurrentStart = Date.now();
  other = (await request(`/api/galleries/${other.id}`, { ...other, title: '并发修改成功' }, 'PATCH')).gallery;
  await Promise.all(Array.from({ length: 12 }, () => request('/api/galleries')));
  results.concurrentMs = Date.now() - concurrentStart;
  assert.ok(Number(results.concurrentMs) < 2000);
  await page.getByRole('button', { name: '继续', exact: true }).click();
  gallery = await wait(gallery.id, g => ['completed', 'failed'].includes(g.operation?.status ?? ''));
  assert.equal(gallery.operation!.status, 'completed', JSON.stringify(gallery.operation));
  results.candidates = { paused, final: gallery.operation, images: gallery.plan!.images.length, blockedReason: gallery.plan!.blockedReason, ocrWindows: trace.filter(x => x.kind === 'ocr-window').length };
  assert.equal(trace.filter(x => x.kind === 'ocr-window').length, 12, 'Resume must not redo completed windows');
  assert.ok(ocrProcesses.size > 0, 'Real Apple Vision OCR subprocesses must have run');
  results.ocrProcesses = ocrProcesses.size;
  console.log(JSON.stringify({ phase: 'candidate resume passed', ...results.candidates as object }));
  other = (await request(`/api/galleries/${other.id}`, { ...other, images: Array.from({ length: 8 }, (_, i) => ({ mainTime: 5 + i * 3, times: [5 + i * 3, 7 + i * 3], bandTop: .78, bandBottom: .96, mainFraction: .7 })) }, 'PATCH')).gallery;
  const renderBefore = trace.filter(x => x.kind === 'render').length;
  other = (await request(`/api/galleries/${other.id}/operation`, { version: other.version, kind: 'render' }, 'POST', 202)).gallery;
  await wait(other.id, g => (g.operation?.completed ?? 0) >= 1);
  await request(`/api/galleries/${other.id}/operation/pause`, { operationId: other.operation!.id });
  other = await wait(other.id, g => g.operation?.status === 'paused', 30_000);
  const finalPaused = { ...other.operation! }; const rendersPaused = trace.filter(x => x.kind === 'render').length;
  await sleep(2100); assert.equal(trace.filter(x => x.kind === 'render').length, rendersPaused);
  console.log(JSON.stringify({ phase: 'final pause passed', operation: finalPaused }));
  await page.goto(base + `/galleries/${other.id}`); await page.getByRole('progressbar').waitFor();
  await page.screenshot({ path: path.join(out, 'final-paused-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: '继续', exact: true }).click();
  other = await wait(other.id, g => ['completed', 'failed'].includes(g.operation?.status ?? ''));
  assert.equal(other.operation!.status, 'completed', JSON.stringify(other.operation)); assert.equal(other.status, 'ready');
  assert.equal(trace.filter(x => x.kind === 'render').length - renderBefore, 8);
  assert.equal(other.generated!.hashes.length, 8);
  results.render = { paused: finalPaused, final: other.operation, imageCount: other.generated!.hashes.length, renderCalls: 8 };
  assert.deepEqual(errors, []);
  assert.deepEqual(await readFile(path.join(sourceStorage, 'cache/jobs-index.json')), originalJobs);
  assert.deepEqual(await readFile(path.join(sourceStorage, 'cache/galleries.json')), originalGalleries);
  assert.deepEqual(await readFile(path.join(sourceStorage, 'raw/transcripts', `${sourceId}.json`)), transcriptBytes);
  results.boundary = 'Real original video copy, production FFmpeg/Apple Vision, live API/UI. AI selection and copy are deterministic fixtures; no semantic AI acceptance or platform publishing.';
  results.transcriptHash = sha(transcriptBytes); results.passed = true;
  await writeFile(path.join(out, 'result.json'), JSON.stringify({ ...results, trace }, null, 2));
  console.log(JSON.stringify(results));
} finally {
  monitoring = false; await monitor;
  GalleryMedia.prototype.suggestSubtitles = originalSuggest; GalleryMedia.prototype.render = originalRender;
  await browser?.close(); if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
  await rm(root, { recursive: true, force: true });
}
