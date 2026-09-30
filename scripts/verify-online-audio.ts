/** Real public sources, isolated storage only. --serve exposes the isolated API on port 3100 for UI checks. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createExpressApp } from '../src/app.js';
import type { OnlineTrack } from '../src/lib/online-audio-sources.js';
import type { AudioImportBatch } from '../src/lib/online-audio.js';

const root = await mkdtemp(path.join(tmpdir(), 'online-audio-verify-'));
const app = await createExpressApp({ rootDir: process.cwd(), storagePath: root, ffprobeBinary: process.env.FFPROBE_BINARY ?? 'ffprobe' });
const server = createServer(app);
const serve = process.argv.includes('--serve');
await new Promise<void>(resolve => server.listen(serve ? 3100 : 0, '127.0.0.1', resolve));
const address = server.address(); assert.ok(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}`;
async function close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
if (serve) {
  console.log(`Isolated real-source audio API: ${base}; temporary storage will be removed on exit.`);
  process.on('SIGINT', () => void close().then(() => process.exit(0)));
  process.on('SIGTERM', () => void close().then(() => process.exit(0)));
} else {
  let token = '';
  const request = async (url: string, data?: unknown) => {
    const response = await fetch(`${base}${url}`, { method: data ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Local-Session': token }, ...(data ? { body: JSON.stringify(data) } : {}) });
    const body = await response.json();
    if (!response.ok) throw new Error(`${response.status}: ${body.message}`);
    return body;
  };
  try {
    token = (await request('/api/local-sessions/auto', {})).session.token;
    for (const source of ['netease', 'qq']) {
      for (const board of ['hot', 'soar', 'new']) {
        const result = (await request(`/api/online-audio/boards?source=${source}&board=${board}`)).board;
        assert.equal(result.status, 'fresh'); assert.ok(result.items.length > 0);
        console.log(JSON.stringify({ source, board, count: result.items.length, ok: true }));
      }
      const tracks: OnlineTrack[] = (await request(`/api/online-audio/search?source=${source}&q=${encodeURIComponent('卡农')}`)).tracks;
      assert.ok(tracks.length > 0); console.log(JSON.stringify({ source, search: true, count: tracks.length, ok: true }));
      let playable: OnlineTrack | undefined;
      for (const track of tracks.slice(0, 10)) {
        try {
          const preview = (await request('/api/online-audio/preview', { trackKey: track.key })).preview;
          if (preview.previewOnly) continue;
          const partial = await fetch(`${base}/api/online-audio/media/${preview.token}`, { headers: { Range: 'bytes=0-1023' } });
          assert.equal(partial.status, 206); assert.equal((await partial.arrayBuffer()).byteLength, 1024);
          assert.equal((await request('/api/assets?kind=audio')).assets.filter((asset: any) => asset.audioSource?.platform === source).length, 0);
          playable = track;
          console.log(JSON.stringify({ source, preview: 'complete', durationMs: preview.durationMs, range: 206, ok: true })); break;
        } catch (error) { console.log(JSON.stringify({ source, unavailable: track.title, message: error instanceof Error ? error.message : 'failed' })); }
      }
      assert.ok(playable, `${source}: no complete public audio in the first 10 search results`);
      let batch: AudioImportBatch = (await request('/api/online-audio/imports', { trackKeys: [playable.key] })).batch;
      for (let i = 0; i < 100 && batch.items.some(item => ['queued', 'downloading'].includes(item.status)); i++) {
        await new Promise(resolve => setTimeout(resolve, 200)); batch = (await request(`/api/online-audio/imports/${batch.id}`)).batch;
      }
      assert.equal(batch.items[0].status, 'succeeded', batch.items[0].message);
      const id = batch.items[0].assetId!;
      const repeat: AudioImportBatch = (await request('/api/online-audio/imports', { trackKeys: [playable.key] })).batch;
      for (let i = 0; i < 100; i++) {
        const current = (await request(`/api/online-audio/imports/${repeat.id}`)).batch;
        if (current.items[0].status === 'succeeded') { assert.equal(current.items[0].assetId, id); break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const assets = (await request('/api/assets?kind=audio')).assets;
      assert.equal(assets.filter((asset: any) => asset.audioSource?.platform === source).length, 1);
      const raw = await fetch(`${base}/api/assets/${id}/raw`, { headers: { Range: 'bytes=0-127' } }); assert.equal(raw.status, 206); await raw.arrayBuffer();
      assert.equal((await fetch(`${base}/api/assets/${id}`, { method: 'DELETE' })).status, 204);
      console.log(JSON.stringify({ source, imported: true, deduplicated: true, deleted: true, ok: true }));
    }
  } finally { await close(); }
}
