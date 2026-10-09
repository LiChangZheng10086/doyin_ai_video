/** Isolated real FFmpeg/API check; --serve opens the same synthetic UI fixture, never real data or publishing. */
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, rm, readFile, writeFile, chmod } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createExpressApp } from '../src/app.js';
import { LocalStorage } from '../src/lib/storage.js';
import { GalleryMedia } from '../src/lib/gallery-media.js';
import { runCommand } from '../src/lib/command.js';

const translatedMode = process.argv.includes('--translated');
const root = await mkdtemp(path.join(tmpdir(), 'subtitle-gallery-ui-'));
const storage = new LocalStorage(root);
await storage.ensureBaseDirs();
const now = new Date().toISOString();
const videoPath = storage.resolve('raw/videos/gallery-demo.mp4');
const pixels = Buffer.alloc(320 * 480 * 3);
const glyphs = ['10001', '11001', '10101', '10011', '10001', '10001', '10001'];
for (let char = 0; char < 20; char++) for (let y = 0; y < 7; y++) for (let x = 0; x < 5; x++) {
  if (glyphs[y]![x] !== '1') continue;
  for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    const at = ((400 + y * 2 + dy) * 320 + 40 + char * 12 + x * 2 + dx) * 3;
    pixels.fill(255, at, at + 3);
  }
}
const raster = path.join(root, 'caption.ppm');
await writeFile(raster, Buffer.concat([Buffer.from('P6\n320 480\n255\n'), pixels]));
await runCommand('ffmpeg', ['-y', '-loop', '1', '-i', raster, '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '64', '-r', '5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', videoPath], { captureStderr: true });
const segments = Array.from({ length: 32 }, (_, i) => ({ start: i * 2, end: (i + 1) * 2, text: translatedMode ? `Sentence ${i + 1}. Keep going.` : `第${i + 1}段合成验收标记。` }));
await storage.writeJson('cache/jobs-index.json', { 'gallery-demo': {
  id: 'gallery-demo', topic: '图集自动规划验收（合成画面）', sourceUrl: translatedMode ? 'https://www.youtube.com/watch?v=synthetic-demo' : 'https://example.com/demo', videoPath,
  status: 'queued', stage: 'transcribed', workflowMode: 'manual',
  steps: { transcribe: { status: 'succeeded', attempts: 1 }, clean: { status: 'pending', attempts: 0 }, generate_video_prompts: { status: 'pending', attempts: 0 }, generate_video: { status: 'pending', attempts: 0 } },
  storagePath: 'processed/scripts/gallery-demo.json', createdAt: now, updatedAt: now,
} });
await storage.writeJson('raw/transcripts/gallery-demo.json', {
  transcript: segments.map(s => s.text).join('\n'), segments, duration: 64, provider: 'whisper.cpp', model: 'test-fixture',
});
// A command double makes historical repair reproducible; synthetic audio is not evidence of ASR accuracy.
const cli = path.join(root, 'whisper-fixture.mjs');
await writeFile(cli, `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';const args=process.argv;writeFileSync(args[args.indexOf('-of')+1]+'.json',JSON.stringify(${JSON.stringify({ transcription: segments.map(s => ({ offsets: { from: s.start * 1000, to: s.end * 1000 }, text: s.text })) })}));\n`);
await chmod(cli, 0o755);
const model = path.join(root, 'model.bin'); await writeFile(model, 'command fixture');
// Raster markers deliberately exercise only the pixel path; real OCR has its own fixed-source regression.
const originalSuggest = GalleryMedia.prototype.suggestSubtitle;
GalleryMedia.prototype.suggestSubtitle = function (video, quote, region) { return originalSuggest.call(this, video, { start: quote.start, end: quote.end }, region); };
GalleryMedia.prototype.suggestSubtitles = async function (video, quote, region) {
  const result = await this.suggestSubtitle(video, quote, region);
  return result ? [result] : [];
};
let copyRuns = 0;
const app = await createExpressApp({ storagePath: root, rootDir: root, whisperCliPath: cli, whisperModelPath: model,
  galleryTranslator: { translate: async cues => cues.map(c => ({ ...c, text: `第${c.segmentIndex + 1}段译文：坚持前行。` })) },
  galleryCopyWriter: { write: async input => {
    assert.match(input.transcript, translatedMode ? /Sentence 32/ : /第32段合成验收标记/);
    return { title: '合成图文验收', description: `这是隔离测试生成的配套文案（第${++copyRuns}次）。\n1. 按完整内容组织核心观点。\n2. 保留最后一段的信息。\n你想先调整哪一点？`, hashtags: ['合成验收'], notes: ['测试夹具不证明真实文案语义准确'] };
  } } });
const serve = process.argv.includes('--serve');
const port = serve ? Number(process.env.SUBTITLE_GALLERY_PORT ?? 3183) : 0;
if (serve) {
  const renderer = path.resolve('dist-renderer');
  const html = await readFile(path.join(renderer, 'index.html'), 'utf8');
  app.use(express.static(renderer, { index: false }));
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) { res.status(404).end(); return; }
    res.type('html').send(html.replaceAll('./assets/', '/assets/').replace('<head>', `<head><script>window.electron={getServerPort:async()=>${port},getConfig:async()=>({aiKeys:[],app:{theme:'dark'}}),saveConfig:async()=>{}};</script>`));
  });
}
const server = createServer(app);
await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
let closing = false;
const close = async () => {
  if (closing) return; closing = true; server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
};
process.on('SIGINT', () => { void close().then(() => process.exit(0)); });
process.on('SIGTERM', () => { void close().then(() => process.exit(0)); });
const address = server.address(); assert.ok(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}`;
if (serve) console.log(`Isolated synthetic ${translatedMode ? 'translated' : 'native'} gallery UI: ${base}/galleries?sourceJobId=gallery-demo (no live publishing; raster markers are not real dialogue)`);
else try {
  const session = await fetch(base + '/api/local-sessions/auto', { method: 'POST' });
  const token = (await session.json()).session.token;
  const request = async (url: string, data: unknown) => {
    const res = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Session': token }, body: JSON.stringify(data) });
    const body = await res.json(); assert.equal(res.status, 200, JSON.stringify(body)); return body;
  };
  const created = await fetch(base + '/api/galleries', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Session': token }, body: JSON.stringify({ sourceJobId: 'gallery-demo' }) });
  assert.equal(created.status, 201); const gallery = (await created.json()).gallery;
  const url = `/api/galleries/${gallery.id}`;
  const sourceGallery = translatedMode ? (await request(url + '/translate', { version: gallery.version, start: 0, end: 64 })).gallery : gallery;
  const planned = (await request(url + '/plan', { version: sourceGallery.version, targetLines: 8 })).gallery;
  assert.deepEqual(planned.plan.images.map((i: any) => i.quotes.length), [8, 8, 8, 8]);
  assert.match(planned.description, /核心观点/);
  assert.ok(planned.copyReference);
  const candidate = await fetch(base + url + `/plan/images/0?planId=${planned.plan.id}&version=${planned.version}`);
  assert.equal(candidate.status, 200); assert.equal(Buffer.from(await candidate.arrayBuffer()).readUInt32BE(20), 1440);
  const rendered = (await request(url + '/plan/render', { version: planned.version, planId: planned.plan.id, subtitlesConfirmed: true })).gallery;
  assert.equal(rendered.status, 'ready'); assert.equal(rendered.generated.hashes.length, 4);
  const recopy = (await request(url + '/copy', { version: rendered.version })).gallery;
  assert.equal(recopy.status, 'ready'); assert.deepEqual(recopy.generated, rendered.generated); assert.equal(recopy.plan.id, rendered.plan.id);
  assert.match(recopy.description, /第2次/);
  assert.equal((await request(url + '/publishing/preview', { version: recopy.version })).preview.imageCount, 4);
  assert.equal((await request('/api/jobs/gallery-demo/retranscribe', {})).job.steps.clean.status, 'pending');
  const stale = await fetch(base + url + '/publishing/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: recopy.version }) });
  assert.equal(stale.status, 409);
  console.log('PASS: isolated full transcript → four image previews + copy → confirm/render → regenerate copy preserves pixels → publish preview → retranscribe rejects stale copy/images. No real data or publishing writes.');
} finally { await close(); }
