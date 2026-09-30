import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { LocalStorage } from './storage.js';
import { AssetStore } from './assets-store.js';
import { LocalUserStore } from './local-users.js';
import { LocalSessionStore } from './local-auth.js';
import { OnlineAudioService } from './online-audio.js';
import { registerOnlineAudioRoutes } from './online-audio-routes.js';

test('online audio routes validate input and require the existing local operator for imports', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'online-audio-routes-')); t.after(() => rm(root, { recursive: true, force: true }));
  const storage = new LocalStorage(root); await storage.ensureBaseDirs();
  const users = new LocalUserStore(storage); const sessions = new LocalSessionStore(users);
  const audio = new OnlineAudioService(storage, new AssetStore(storage), { fetchTracks: async () => [{ key: 'netease:123', source: 'netease', trackId: '123', title: 'Test', artist: 'Artist', url: 'https://music.163.com/song?id=123' }], resolveMedia: async () => { throw new Error('offline'); } });
  const app = express(); app.use(express.json()); registerOnlineAudioRoutes(app, { audio, sessions });
  const server = app.listen(0, '127.0.0.1'); t.after(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));
  await new Promise<void>(r => server.once('listening', r)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/online-audio`;
  assert.equal((await fetch(`${base}/boards?source=evil&board=hot`)).status, 400);
  assert.equal((await fetch(`${base}/search?source=netease&q=`)).status, 400);
  const board = await fetch(`${base}/boards?source=netease&board=hot`); assert.equal(board.status, 200); assert.equal((await board.json()).board.items.length, 1);
  const denied = await fetch(`${base}/imports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trackKeys: ['netease:123'] }) });
  assert.equal(denied.status, 401);
  assert.equal((await fetch(`${base}/media/not-a-token`)).status, 404);
});
