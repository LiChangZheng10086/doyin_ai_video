import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createExpressApp } from '../app.js';
import { LocalStorage } from './storage.js';
import { runCommand } from './command.js';
import { SauRunner } from './sau-runner.js';

test('gallery HTTP route creates a self-contained douyin note without cleaned content or rendered video', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gallery-api-'));
  let server: ReturnType<typeof createServer> | undefined;
  try {
    const storage = new LocalStorage(root); await storage.ensureBaseDirs();
    const videoPath = storage.resolve('raw/videos/source.mp4');
    await runCommand('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=blue:s=240x320:d=2:r=5', '-vf', 'drawbox=x=30:y=260:w=180:h=10:color=white:t=fill', '-c:v', 'libx264', videoPath], { captureStderr: true });
    const now = new Date().toISOString();
    await storage.writeJson('cache/jobs-index.json', { source: { id: 'source', topic: '字幕图集测试', videoPath, status: 'queued', stage: 'transcribed', sourceUrl: 'https://example.com/video', storagePath: 'processed/scripts/source.json', createdAt: now, updatedAt: now } });
    const runner = new SauRunner({});
    runner.assertConfigured = () => {};
    runner.prepareAccountFile = async () => 'fake-account-file';
    runner.syncBackCookies = async () => 'fake-cookie-file';
    runner.checkLogin = async () => ({ ok: true, exitCode: 0, output: 'valid', needsVerificationCode: false });
    runner.runUploadNote = async input => { assert.equal(input.title, '字幕图集测试'); assert.equal(input.imagePaths.length, 1); return { ok: true, exitCode: 0, output: 'submitted', needsVerificationCode: false }; };
    const app = await createExpressApp({ rootDir: root, storagePath: root, sauRunner: runner });
    server = createServer(app); await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    let token = '';
    const request = async (url: string, method = 'GET', body?: unknown) => {
      const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Local-Session': token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: await response.json() as any };
    };
    assert.equal((await request('/api/galleries', 'POST', { sourceJobId: 'source' })).status, 401);
    token = (await request('/api/local-sessions/auto', 'POST')).body.session.token;
    const created = await request('/api/galleries', 'POST', { sourceJobId: 'source' });
    assert.equal(created.status, 201);
    const gallery = created.body.gallery;
    const url = `/api/galleries/${gallery.id}`;
    const rendered = await request(url + '/render', 'POST', { version: gallery.version });
    assert.equal(rendered.status, 200);
    assert.equal((await request(url + '/publishing/preview', 'POST', { version: gallery.version })).status, 409);
    const preview = await request(url + '/publishing/preview', 'POST', { version: rendered.body.gallery.version }); assert.equal(preview.status, 200);
    assert.equal((await fetch(base + url + '/images/0?generation=stale')).status, 409);
    assert.equal((await request(url + '/publishing/packages', 'POST', { previewRevision: preview.body.preview.previewRevision })).status, 422);
    assert.equal((await request(url + '/publishing/packages', 'POST', { previewRevision: 'stale', rightsConfirmed: true })).status, 409);
    const built = await request(url + '/publishing/packages', 'POST', { previewRevision: preview.body.preview.previewRevision, rightsConfirmed: true });
    assert.equal(built.status, 201, JSON.stringify(built.body));
    const detail = built.body.detail;
    assert.equal(detail.package.contentType, 'note');
    assert.equal(detail.package.noteCopy.title, '字幕图集测试');
    assert.equal(detail.tasks[0].platform, 'douyin');
    assert.equal(detail.tasks[0].status, 'ready');
    const packagedImage = path.join(detail.package.packagePath, detail.package.imagePaths[0]);
    const savedBytes = await readFile(packagedImage);
    const packagePreview = await request(`/api/publishing/packages/${detail.package.id}/preview`);
    assert.equal(packagePreview.status, 200);
    // The package does not reference mutable gallery files.
    const current = (await request(url)).body.gallery;
    await request(url, 'DELETE', { version: current.version });
    assert.deepEqual(await readFile(packagedImage), savedBytes);
    const submitted = await request(`/api/publishing/tasks/${detail.tasks[0].id}/auto-publish`, 'POST', { previewRevision: packagePreview.body.preview.previewRevision });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    assert.equal(submitted.body.task.status, 'ready');
    assert.equal(submitted.body.task.autoPublish.status, 'succeeded');
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
