import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { createExpressApp } from './app.js';
import { LocalStorage } from './lib/storage.js';

test('raw transcript diagnoses historical ranges against actual audio without overwriting data', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'transcript-api-'));
  let server: ReturnType<typeof createServer> | undefined;
  try {
    const storage = new LocalStorage(root); await storage.ensureBaseDirs();
    const now = new Date().toISOString();
    await storage.writeJson('cache/jobs-index.json', { sample: { id: 'sample', topic: '原始转录', sourceUrl: 'https://example.com/video', storagePath: 'processed/scripts/sample.json', status: 'queued', stage: 'transcribed', createdAt: now, updatedAt: now } });
    const original = { transcript: '第一句', segments: [{ start: 0, end: 600, text: '第一句' }], duration: 600, provider: 'whisper.cpp', model: 'ggml-small' };
    await storage.writeJson('raw/transcripts/sample.json', original);
    await storage.writeJson('raw/audio/sample.json', { status: 'ready', audio: { duration: 2 } });
    server = createServer(await createExpressApp({ storagePath: root, rootDir: root }));
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const response = await fetch(base + '/api/jobs/sample/raw-transcript');
    const data = await response.json() as any;
    assert.equal(response.status, 200);
    assert.ok(data.rawTranscript.qualityIssues.length > 0);
    assert.match(data.rawTranscript.qualityIssues.join(' '), /时长/);
    assert.deepEqual(await storage.readJson('raw/transcripts/sample.json'), original);
    const missing = await fetch(base + '/api/jobs/missing/retranscribe', { method: 'POST' });
    assert.equal(missing.status, 404);
    assert.match((await missing.json() as any).message, /not found|不存在/);
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
