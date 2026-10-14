import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiClient } from './api.js';

test('Xhs note API unwraps the REST contract and preserves versions, preview fields and image order', async () => {
  const client = new ApiClient();
  const calls: any[] = [];
  const note = { id: 'n', version: 7, sourceText: '完整原文', imageAssetIds: ['b', 'a'] };
  const preview = { note, previewRevision: 'revision', imageAssetIds: ['b', 'a'], imageHashes: ['hash-b', 'hash-a'], imageLimit: 18,
    copyLimits: { titleMax: 20, descriptionMax: 1000, hashtagMax: 10, hashtagLengthMax: 20 } };
  const detail = { package: { id: 'pkg' } };
  client.getClient = async () => ({ request: async (config: any) => {
    calls.push(config); return { data: { notes: [note], note, preview, detail, ok: true } };
  } }) as any;
  assert.deepEqual(await client.getXhsNotes(), [note]);
  assert.deepEqual(await client.createXhsNote({ sourceText: '完整原文' }), note);
  assert.deepEqual(await client.getXhsNote('n/中文'), note);
  await client.saveXhsNote('n', { version: 7, imageAssetIds: ['b', 'a'], title: '笔记' });
  await client.deleteXhsNote('n', 8);
  await client.rewriteXhsNote('n', 9);
  assert.deepEqual(await client.previewXhsNote('n', 10), preview);
  assert.deepEqual(await client.createXhsNotePackage('n', 10, 'revision', true), detail);
  assert.equal(calls[2].url, '/api/xhs-notes/n%2F%E4%B8%AD%E6%96%87');
  assert.deepEqual(calls.map(call => call.method ?? 'GET'), ['GET', 'POST', 'GET', 'PATCH', 'DELETE', 'POST', 'POST', 'POST']);
  assert.deepEqual(calls[3].data, { version: 7, imageAssetIds: ['b', 'a'], title: '笔记' });
  assert.deepEqual(calls[4].data, { version: 8 });
  assert.deepEqual(calls[5].data, { version: 9 });
  assert.equal(calls[5].timeout, 600000);
  assert.deepEqual(calls[6].data, { version: 10 });
  assert.deepEqual(calls[7].data, { version: 10, previewRevision: 'revision', rightsConfirmed: true });
  assert.ok(calls.every(call => !('contentSourceHash' in (call.data ?? {})) && !('cardImageHash' in (call.data ?? {}))));
});

test('Xhs save conflicts keep the parsed status and never retry using a newer version', async () => {
  const client = new ApiClient(); let attempts = 0;
  client.getClient = async () => ({ request: async () => {
    attempts++; throw { response: { status: 409, data: { code: 'version_conflict', message: '版本已改变' } } };
  } }) as any;
  await assert.rejects(client.saveXhsNote('n', { version: 7, title: '我的修改' }), (error: any) => error.status === 409 && error.message === '版本已改变');
  assert.equal(attempts, 1);
});

test('Xhs requests reuse local session recovery after a backend restart', async () => {
  const client = new ApiClient(); await client.getClient();
  const instance = await client.getClient();
  const seen: string[] = [];
  instance.defaults.adapter = async (config: any) => {
    seen.push(config.url);
    if (config.url === '/api/local-sessions/auto') return { data: { session: { token: 'fresh' } }, status: 200, statusText: 'OK', headers: {}, config };
    if (seen.length === 1) throw { config, response: { status: 401, data: { code: 'local_session_required' } } };
    return { data: { notes: [] }, status: 200, statusText: 'OK', headers: {}, config };
  };
  assert.deepEqual(await client.getXhsNotes(), []);
  assert.deepEqual(seen, ['/api/xhs-notes', '/api/local-sessions/auto', '/api/xhs-notes']);
});
