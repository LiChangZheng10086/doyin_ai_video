/** Isolated real HTTP assembly + local OpenAI-compatible fixture. No real credentials or platform submissions. */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createExpressApp } from '../src/app.js';
import { LocalStorage } from '../src/lib/storage.js';
import { AssetStore } from '../src/lib/assets-store.js';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'image-prompt-verify-')));
const rendererDir = process.env.IMAGE_PROMPT_VERIFY_RENDERER ?? path.join(process.cwd(), 'dist-renderer');
const storage = new LocalStorage(root); const now = new Date().toISOString();
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMioAAAAASUVORK5CYII=', 'base64');
const ai = createServer(async (req, res) => {
  let text = ''; for await (const chunk of req) text += chunk;
  try {
    const request = JSON.parse(text); const messages = request.messages;
    const images = messages[0]?.content.includes('prompts');
    const input = images ? JSON.parse(messages[1].content) : undefined;
    if (input?.referenceText?.includes('模拟上游失败')) { res.writeHead(503); res.end('fixture unavailable'); return; }
    const content = images ? input?.referenceText?.includes('模拟坏格式') ? '{invalid' : JSON.stringify({ prompts: Array.from({ length: input.count }, (_, i) => ({ title: `海边日落构图 ${i + 1}`, tags: ['海边', '日落'], prompt: input.mode === 'optimize' ? `${input.originalPrompt}。光线柔和；保留图中文字“你好”。` : '海边日落，暖色光线照亮海浪，远处有一只白色帆船，主体居中，不添加文字。' })) })
      : JSON.stringify({ title: '海边日落与生活记录', digest: '观察海边自然光线', sections: [{ heading: '海边观察', paragraphs: ['日落的光线映在海面上。我们观察风景，也记录生活。'] }], tags: ['海边'] });
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id: 'fixture-response', object: 'chat.completion', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] }));
  } catch { res.writeHead(400); res.end('fixture input invalid'); }
});
async function listen(server: Server, port = 0) { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); }); const address = server.address(); assert.ok(address && typeof address === 'object'); return address.port; }
let server: Server | undefined;
let closing = false;
async function close() { if (closing) return; closing = true; for (const current of [server, ai]) { if (current?.listening) { current.closeAllConnections(); await new Promise<void>(resolve => current.close(() => resolve())); } } await rm(root, { recursive: true, force: true }); }
try {
  const aiPort = await listen(ai);
  await storage.writeJsonAtomic('cache/jobs-index.json', { 'image-fixture': { id: 'image-fixture', sourceUrl: 'https://example.com/fixture', topic: '这是一个很长的中文标题用于验证默认展示全部素材而不是自动将标题作为搜索条件', status: 'done', stage: 'cleaned', workflowMode: 'manual', steps: { transcribe: { status: 'succeeded', attempts: 1 }, clean: { status: 'succeeded', attempts: 1 } }, createdAt: now, updatedAt: now } });
  await storage.writeJsonAtomic('processed/cleaned/image-fixture.json', { output: { title: '海边生活记录', summary: '观察风景', keyPoints: ['海边日落'], cleanScript: '日落的光线映在海面上。我们观察风景，也记录生活。', tags: ['海边'] } });
  const frame = storage.resolve('output/videos/image-fixture/hyperframes/snapshots/frame-00-at-1s.png');
  await mkdir(path.dirname(frame), { recursive: true }); await writeFile(frame, png);
  const assets = new AssetStore(storage);
  await assets.add('image', { originalName: '初始海边.png', data: png, metadata: { description: '海边白帆船', tags: ['海边'] } });
  await assets.add('image', { originalName: '初始雪山.png', data: png, metadata: { description: '雪山和白云', tags: ['雪山'] } });
  await writeFile(path.join(root, 'upload-one.png'), png); await writeFile(path.join(root, 'upload-two.png'), png); await writeFile(path.join(root, 'bad.txt'), 'invalid image');
  const videoPath = storage.resolve('output/videos/image-fixture/video.mp4');
  await promisify(execFile)('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=1080x1920:r=1', '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-y', videoPath]);
  await storage.writeJsonAtomic('processed/scripts/image-fixture.json', { hyperframesVideo: { provider: 'hyperframes', projectPath: path.dirname(videoPath), videoPath, createdAt: now, duration: 1, aspectRatio: '9:16', width: 1080, height: 1920, scenes: [] } });
  const cleaned = await storage.readJson<any>('processed/cleaned/image-fixture.json');
  cleaned.output.hyperframesVideo = (await storage.readJson<any>('processed/scripts/image-fixture.json')).hyperframesVideo;
  await storage.writeJsonAtomic('processed/cleaned/image-fixture.json', cleaned);
  const app = await createExpressApp({ rootDir: root, storagePath: root, resolveAiConfig: async () => ({ apiKey: 'fake-secret', model: 'fixture-model', baseURL: `http://127.0.0.1:${aiPort}/v1` }) });
  app.use(express.static(rendererDir, { index: false }));
  server = createServer(app);
  const portArg = process.argv.find(arg => arg.startsWith('--port='));
  const port = await listen(server, portArg ? Number(portArg.slice(7)) : 0);
  app.get('*', async (req, res, next) => {
    if (req.path.startsWith('/api/')) { res.status(404).end(); return; }
    try { const html = await readFile(path.join(rendererDir, 'index.html'), 'utf8'); res.type('html').send(html.replaceAll('./assets/', '/assets/').replace('<head>', `<head><script>window.electron={getServerPort:async()=>${port},getConfig:async()=>({app:{}}),saveConfig:async()=>{}};</script>`)); } catch (e) { next(e); }
  });
  const base = `http://127.0.0.1:${port}`;
  const response = await fetch(`${base}/api/local-sessions/auto`, { method: 'POST' }); const token = (await response.json()).session.token;
  const generated = await fetch(`${base}/api/image-prompts`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Session': token }, body: JSON.stringify({ mode: 'generate', referenceText: '海边日落', count: 1, language: 'zh' }) });
  assert.equal(generated.status, 201); const draft = (await generated.json()).prompts[0];
  const form = new FormData(); form.append('files', new File([png], '验证图.png')); form.append('metadata', JSON.stringify([{ description: '黄昏白帆船', tags: ['黄昏'] }])); form.append('imagePromptId', draft.id); form.append('imagePromptVersion', '1');
  const uploaded = await fetch(`${base}/api/assets/images`, { method: 'POST', headers: { 'X-Local-Session': token }, body: form }); assert.equal(uploaded.status, 201);
  const search = await fetch(`${base}/api/assets?kind=image&q=${encodeURIComponent('黄昏')}`); const matched = await search.json(); assert.equal(matched.assets.length, 1); assert.equal(matched.total, 3);
  console.log(JSON.stringify({ url: `${base}/assets`, article: `${base}/jobs/image-fixture`, temporaryStorage: root, httpSmoke: 'passed' }));
  if (process.argv.includes('--serve')) { process.on('SIGINT', () => void close().then(() => process.exit(0))); process.on('SIGTERM', () => void close().then(() => process.exit(0))); }
  else await close();
} catch (e) { await close(); throw e; }
