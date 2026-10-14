import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerXhsNoteRoutes } from './xhs-note-routes.js';
import { XhsNoteService } from './xhs-notes.js';
import { LocalStorage } from './storage.js';
import { AssetStore } from './assets-store.js';
import { LocalUserStore } from './local-users.js';
import { LocalSessionStore } from './local-auth.js';

test('REST contracts enforce sessions, versions, source binding, preview and package guards', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'xhs-note-api-')); t.after(() => rm(root, { recursive: true, force: true }));
  const storage = new LocalStorage(root); await storage.ensureBaseDirs();
  const users = new LocalUserStore(storage); await users.init(); const user = await users.ensureLocalOperator();
  const sessions = new LocalSessionStore(users); const session = await sessions.openLocalOperator(user.id);
  const library = new AssetStore(storage); const image = await library.add('image', { originalName: 'image.png', data: Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex') });
  let packages = 0;
  const notes = new XhsNoteService({ storage, library, writer: { rewrite: async () => ({ title: '标题', description: '完整正文', hashtags: ['测试'], cards: [{ title: '图卡', body: '正文' }], reviewNotes: [] }) }, publishing: { createXhsNote: async () => { packages++; return { package: { id: 'package' }, tasks: [] } as any; } } });
  const app = express(); app.use(express.json()); registerXhsNoteRoutes(app, { notes, sessions });
  const server = createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/xhs-notes`;
  const request = async (url = '', method = 'GET', body?: unknown, token = session.token) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Local-Session': token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  for (const [url, method, body] of [['', 'POST', { sourceText: '来源' }], ['/id', 'PATCH', { version: 1 }], ['/id', 'DELETE', { version: 1 }], ['/id/rewrite', 'POST', { version: 1 }], ['/id/publishing/preview', 'POST', { version: 1 }], ['/id/publishing/packages', 'POST', { version: 1 }]] as const) {
    const response = await request(url, method, body, ''); assert.equal(response.status, 401); assert.equal(response.body.code, 'local_session_required');
  }
  const denied = await request('', 'POST', { sourceText: '来源' }, 'invalid'); assert.equal(denied.status, 401);
  const resolveSession = sessions.resolve.bind(sessions);
  sessions.resolve = async token => token === 'forbidden' ? { ...session.user, role: 'viewer' as any } : resolveSession(token);
  assert.equal((await request('', 'POST', { sourceText: '来源' }, 'forbidden')).status, 403);
  const created = await request('', 'POST', { sourceText: '完整原文', imageAssetIds: [image.id] }); assert.equal(created.status, 201);
  let note = created.body.note; const url = `/${note.id}`;
  for (const [endpoint, method] of [[url, 'DELETE'], [url + '/rewrite', 'POST'], [url + '/publishing/preview', 'POST']]) {
    const forged = await request(endpoint, method, { version: note.version, contentSourceHash: 'forged' });
    assert.equal(forged.status, 400); assert.deepEqual((await request(url)).body.note, note);
  }
  assert.deepEqual((await request()).body.notes, [note]); assert.deepEqual((await request(url)).body.note, note);
  assert.equal((await request(url, 'PATCH', { version: 1, contentSourceHash: 'forged' })).status, 400);
  assert.equal((await request(url + '/publishing/preview', 'POST', { version: note.version })).status, 409);
  note = (await request(url + '/rewrite', 'POST', { version: note.version })).body.note;
  assert.ok(note.contentSourceHash);
  const preview = (await request(url + '/publishing/preview', 'POST', { version: note.version })).body.preview;
  assert.ok(preview.previewRevision);
  assert.equal((await request(url + '/publishing/packages', 'POST', { version: note.version, previewRevision: preview.previewRevision, rightsConfirmed: false })).status, 422);
  assert.equal((await request(url + '/publishing/packages', 'POST', { version: note.version - 1, previewRevision: preview.previewRevision, rightsConfirmed: true })).status, 409);
  const packaged = await request(url + '/publishing/packages', 'POST', { version: note.version, previewRevision: preview.previewRevision, rightsConfirmed: true });
  assert.equal(packaged.status, 201); assert.equal(packaged.body.detail.package.id, 'package'); assert.equal(packages, 1);
  note = (await request(url, 'PATCH', { version: note.version, sourceText: '新来源' })).body.note;
  note = (await request(url, 'PATCH', { version: note.version, title: '手动标题' })).body.note;
  assert.equal((await request(url + '/publishing/preview', 'POST', { version: note.version })).status, 409);
  assert.equal((await request(url, 'DELETE', { version: note.version - 1 })).status, 409);
  assert.deepEqual((await request(url, 'DELETE', { version: note.version })).body, { ok: true });
  assert.equal((await request(url)).status, 404); assert.equal(packages, 1);
});
