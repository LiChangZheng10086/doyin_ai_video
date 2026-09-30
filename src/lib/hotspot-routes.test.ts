import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createExpressApp } from '../app.js';

test('hotspot API exposes boards, guards favorite writes and rejects forged input and stale note versions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hotspot-api-'));
  const app = await createExpressApp({ storagePath: root, rootDir: root });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  let token = '';
  const request = async (url: string, method = 'GET', data?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${url}`, { method, headers: { 'Content-Type': 'application/json', 'X-Local-Session': token }, ...(data ? { body: JSON.stringify(data) } : {}) });
    return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? await response.json() as any : {} };
  };
  try {
    assert.equal((await request('/api/hotspots/favorites')).status, 200);
    assert.equal((await request('/api/hotspots/favorites', 'POST', { sourceId: 'toutiao', itemId: '123' })).status, 401);
    token = (await request('/api/local-sessions/auto', 'POST')).body.session.token;
    assert.equal((await request('/api/hotspots/favorites', 'POST', { sourceId: '../config', itemId: '123' })).status, 400);
    assert.equal((await request('/api/hotspots/favorites', 'POST', { sourceId: 'toutiao', itemId: 'invented', url: 'https://evil.example' })).status, 404);
    // Seed only isolated API cache; do not contact real platforms in regression tests.
    const { LocalStorage } = await import('./storage.js');
    const storage = new LocalStorage(root); const now = new Date().toISOString();
    await storage.writeJsonAtomic('cache/hotspots/toutiao.json', { items: [{ sourceId: 'toutiao', itemId: '123', title: 'API选题', url: 'https://www.toutiao.com/trending/123/', rank: 1 }], fetchedAt: now, checkedAt: now });
    const saved = await request('/api/hotspots/favorites', 'POST', { sourceId: 'toutiao', itemId: '123', title: '不可注入' });
    assert.equal(saved.status, 201); assert.equal(saved.body.favorite.title, 'API选题');
    const url = `/api/hotspots/favorites/${saved.body.favorite.id}`;
    app.locals.localSessions.close(token);
    const expired = await request(url, 'PATCH', { note: '过期会话', version: 1 });
    assert.equal(expired.status, 401); assert.equal(expired.body.code, 'local_session_required');
    token = (await request('/api/local-sessions/auto', 'POST')).body.session.token;
    assert.equal((await request(url, 'PATCH', { note: '选题角度', version: 1 })).status, 200);
    assert.equal((await request(url, 'PATCH', { note: '旧编辑', version: 1 })).status, 409);
    assert.equal((await request(url, 'DELETE')).status, 400);
    assert.equal((await request(url, 'DELETE', { version: 2 })).status, 200);
    assert.deepEqual((await request('/api/hotspots/favorites')).body.favorites, []);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
