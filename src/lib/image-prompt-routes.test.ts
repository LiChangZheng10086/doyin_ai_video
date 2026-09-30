import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { LocalStorage } from './storage.js';
import { AssetStore } from './assets-store.js';
import { LocalUserStore } from './local-users.js';
import { LocalSessionStore } from './local-auth.js';
import { ImagePromptService } from './image-prompts.js';
import { registerAssetRoutes } from './assets-routes.js';
import { registerImagePromptRoutes } from './image-prompt-routes.js';

async function fixture(t: any) {
  const root = await mkdtemp(path.join(tmpdir(), 'image-routes-')); t.after(() => rm(root, { recursive: true, force: true }));
  const storage = new LocalStorage(root); await storage.ensureBaseDirs();
  const users = new LocalUserStore(storage); await users.init(); const sessions = new LocalSessionStore(users);
  const user = await users.ensureLocalOperator(); const session = await sessions.openLocalOperator(user.id);
  const assets = new AssetStore(storage);
  const prompts = new ImagePromptService(storage, { resolveAiConfig: async () => ({ provider: 'openai', apiKey: 'fake-secret', model: 'test-model' }),
    createClient: () => ({ chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify({ prompts: [{ title: '雨夜', tags: ['城市'], prompt: '路灯与空街' }] }) } }] }) } } }) });
  const app = express(); app.use(express.json()); registerAssetRoutes(app, { assets, prompts, sessions }); registerImagePromptRoutes(app, { prompts, sessions });
  const server = app.listen(0, '127.0.0.1'); t.after(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));
  await new Promise<void>(r => server.once('listening', r)); const addr = server.address(); assert.ok(addr && typeof addr !== 'string');
  const base = `http://127.0.0.1:${addr.port}/api`;
  const headers = { 'Content-Type': 'application/json', 'X-Local-Session': session.token };
  return { root, assets, prompts, base, headers, token: session.token };
}
function form(files: string[], metadata?: unknown, binding?: { id: string; version: number }): FormData {
  const f = new FormData(); for (const name of files) f.append('files', new Blob(['image fixture']), name);
  if (metadata !== undefined) f.append('metadata', JSON.stringify(metadata));
  if (binding) { f.append('imagePromptId', binding.id); f.append('imagePromptVersion', String(binding.version)); }
  return f;
}

test('authenticated prompt CRUD and bound multi-image upload preserve per-file metadata', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.base}/image-prompts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  const response = await fetch(`${f.base}/image-prompts`, { method: 'POST', headers: f.headers, body: JSON.stringify({ referenceText: '雨夜城市' }) });
  assert.equal(response.status, 201); const [draft] = (await response.json()).prompts;
  const upload = await fetch(`${f.base}/assets/images`, { method: 'POST', headers: { 'X-Local-Session': f.token }, body: form(['甲.png', '乙.png'],
    [{ description: '雨夜空街', tags: ['城市'] }, { description: '路灯', tags: ['灯光'] }], { id: draft.id, version: 1 }) });
  assert.equal(upload.status, 201); const images = (await upload.json()).assets;
  assert.deepEqual(images.map((x: any) => x.description), ['雨夜空街', '路灯']);
  assert.ok(images.every((x: any) => x.generationPrompt === '路灯与空街' && x.imagePromptVersion === 1));
  assert.equal((await fetch(`${f.base}/image-prompts/${draft.id}`, { method: 'DELETE', headers: f.headers, body: '{"version":1}' })).status, 204);
  const searched = await (await fetch(`${f.base}/assets?kind=image&q=城市`)).json(); assert.equal(searched.total, 2); assert.equal(searched.assets.length, 1);
  const updated = await fetch(`${f.base}/assets/${images[0].id}/metadata`, { method: 'PATCH', headers: f.headers, body: '{"version":1,"generationPrompt":"手工修正"}' });
  assert.equal(updated.status, 200); assert.equal((await updated.json()).asset.imagePromptId, undefined);
  assert.equal((await fetch(`${f.base}/assets/${images[0].id}/metadata`, { method: 'PATCH', headers: f.headers, body: '{"version":1,"description":"旧编辑"}' })).status, 409);
});

test('invalid metadata, missing sessions and stale bindings leave no uploaded files', async t => {
  const f = await fixture(t); const [draft] = await f.prompts.generate({ referenceText: '城市' });
  await f.prompts.update(draft.id, { version: 1, prompt: '新稿' });
  const send = (body: FormData, token = f.token) => fetch(`${f.base}/assets/images`, { method: 'POST', headers: { 'X-Local-Session': token }, body });
  assert.equal((await send(form(['a.png'], [{}]), '')).status, 401);
  assert.equal((await send(form(['a.png'], []))).status, 400);
  assert.equal((await send(form(['a.png'], [{}], { id: draft.id, version: 1 }))).status, 409);
  assert.equal((await send(form(['a.png'], [{ description: 'a'.repeat(1001) }]))).status, 400);
  assert.equal((await send(form(['a.png'], 'x'.repeat(1048577)))).status, 400);
  assert.deepEqual(await f.assets.list(), []);
  assert.deepEqual(await readdir(path.join(f.root, 'assets/images')).catch(() => []), []);
});

test('partial image uploads identify failed original indices and legacy contracts remain', async t => {
  const f = await fixture(t);
  const response = await fetch(`${f.base}/assets/images`, { method: 'POST', body: form(['ok.png', 'bad.exe', 'also.png']) });
  assert.equal(response.status, 200); const result = await response.json();
  assert.equal(result.assets.length, 2); assert.equal(result.failures[0].index, 1);
  const denied = await fetch(`${f.base}/assets/images`, { method: 'POST', body: form(['bad.exe']) });
  assert.equal(denied.status, 415); assert.equal((await denied.json()).code, 'asset_extension_forbidden');
  const audio = await fetch(`${f.base}/assets/audio`, { method: 'POST', body: form(['bgm.mp3']) }); assert.equal(audio.status, 201);
  const [record] = (await audio.json()).assets;
  const range = await fetch(`${f.base}/assets/${record.id}/raw`, { headers: { Range: 'bytes=0-3' } }); assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 4);
  assert.equal((await fetch(`${f.base}/assets?kind=audio&q=city`)).status, 400);
});
