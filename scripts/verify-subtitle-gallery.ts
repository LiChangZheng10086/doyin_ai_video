/** Temporary gallery data with no publishing engine configured; shared config routes remain available. */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createExpressApp } from '../src/app.js';
import { LocalStorage } from '../src/lib/storage.js';
import { runCommand } from '../src/lib/command.js';

const root = await mkdtemp(path.join(tmpdir(), 'subtitle-gallery-ui-'));
const storage = new LocalStorage(root);
await storage.ensureBaseDirs();
const videoPath = storage.resolve('raw/videos/gallery-demo.mp4');
await runCommand('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:d=6:r=10', '-vf',
  'drawbox=x=45:y=520:w=270:h=16:color=white:t=fill,drawbox=x=75:y=552:w=210:h=12:color=white:t=fill',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath], { captureStderr: true });
const now = new Date().toISOString();
await storage.writeJson('cache/jobs-index.json', { 'gallery-demo': {
  id: 'gallery-demo', topic: '字幕图集验收（合成画面）', sourceUrl: 'https://example.com/demo', videoPath,
  status: 'queued', stage: 'transcribed', storagePath: 'processed/scripts/gallery-demo.json', createdAt: now, updatedAt: now,
} });
await storage.writeJson('raw/transcripts/gallery-demo.json', {
  transcript: '这是一段合成验收视频，不含真实台词。白色条用于核对字幕区域像素。',
  segments: [{ start: 0, end: 2, text: '测试分段一：定位候选帧' }, { start: 2, end: 4, text: '测试分段二：校准字幕区域' }, { start: 4, end: 6, text: '测试分段三：检查图片顺序' }],
  duration: 6, provider: 'whisper.cpp', model: 'test-fixture',
});
const app = await createExpressApp({ storagePath: root, rootDir: root });
const server = createServer(app);
server.listen(3100, '127.0.0.1', () => console.log('Isolated gallery UI fixture: http://127.0.0.1:3100 (no live publishing configured)'));
let closing = false;
const close = () => {
  if (closing) return; closing = true;
  server.close(() => { void rm(root, { recursive: true, force: true }).then(() => process.exit(0)); });
};
process.on('SIGINT', close); process.on('SIGTERM', close);
