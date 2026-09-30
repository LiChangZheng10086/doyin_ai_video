import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { LocalStorage } from './storage.js';
import { AssetStore } from './assets-store.js';
import { OnlineAudioService, probeAudioFile } from './online-audio.js';
import { runCommand } from './command.js';
import type { OnlineTrack } from './online-audio-sources.js';

const track: OnlineTrack = { key: 'netease:123', source: 'netease', trackId: '123', title: 'Test', artist: 'Artist', url: 'https://music.163.com/song?id=123', durationMs: 1000 };
async function fixture(t: import('node:test').TestContext, extra: Record<string, unknown> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'online-audio-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const storage = new LocalStorage(root); await storage.ensureBaseDirs(); const assets = new AssetStore(storage);
  const service = new OnlineAudioService(storage, assets, { fetchTracks: async () => [track], ...extra });
  return { root, storage, service, assets };
}

test('boards cache, throttle refreshes, and keep stale entries when the source fails', async t => {
  let now = 1_800_000_000_000; let calls = 0;
  const { service } = await fixture(t, { now: () => now, fetchTracks: async () => { if (++calls > 1) throw new Error('offline'); return [track]; } });
  assert.equal((await service.list('netease', 'hot')).status, 'fresh');
  await service.list('netease', 'hot', true); assert.equal(calls, 1);
  now += 61_000;
  const stale = await service.list('netease', 'hot', true);
  assert.equal(stale.status, 'stale'); assert.equal(stale.items[0].key, track.key);
  assert.ok(stale.error); assert.equal(calls, 2);
  await assert.rejects(() => service.search('evil', 'Test'));
  await assert.rejects(() => service.search('netease', ''));
  await assert.rejects(() => service.preview('netease:unregistered'));
});

let ffprobeAvailable = true;
try { await runCommand(process.env.FFPROBE_BINARY ?? 'ffprobe', ['-version'], { timeoutMs: 5000 }); }
catch { ffprobeAvailable = false; }
test('an MP3 with plausible headers and duration but undecodable frames is rejected', { skip: !ffprobeAvailable && 'FFprobe unavailable' }, async t => {
  const { root } = await fixture(t);
  const file = path.join(root, 'corrupt.mp3');
  const frame = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(413, 0xff)]);
  await writeFile(file, Buffer.concat(Array.from({ length: 100 }, () => frame)));
  await assert.rejects(() => probeAudioFile(file, 'mp3', process.env.FFPROBE_BINARY ?? 'ffprobe'), /校验失败/);
});

test('imports require known tracks, report failures individually and survive repeat clicks', async t => {
  const second = { ...track, key: 'netease:456', trackId: '456', url: 'https://music.163.com/song?id=456' };
  let resolves = 0;
  const { service } = await fixture(t, { fetchTracks: async () => [track, second], resolveMedia: async () => { resolves++; throw new Error('no media'); } });
  await service.list('netease', 'hot');
  assert.throws(() => service.startImport(['https://localhost/secret'], 'actor'));
  const batch = service.startImport([track.key, second.key], 'actor');
  const repeated = service.startImport([track.key], 'actor');
  assert.equal(repeated.items[0].id, batch.items[0].id);
  for (let i = 0; i < 40 && service.getImport(batch.id, 'actor').items.some(i => ['queued', 'downloading'].includes(i.status)); i++) await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(service.getImport(batch.id, 'actor').items.map(i => i.status), ['failed', 'failed']);
  assert.equal(resolves, 2);
  assert.throws(() => service.getImport(batch.id, 'other'), /不存在/);
});

test('preview files are not assets; import preserves verified metadata and corrupt audio is cleaned', async t => {
  const { service, assets } = await fixture(t, {
    resolveMedia: async () => ({ url: 'https://m701.music.126.net/test.mp3', extension: 'mp3', previewOnly: true }),
    openRemote: async () => { const response = Readable.from([Buffer.from('test-mp3')]) as IncomingMessage; response.headers = {}; return response; },
    probe: async () => ({ durationMs: 1000 }),
  });
  await service.search('netease', 'Test');
  const preview = await service.preview(track.key);
  assert.equal(preview.previewOnly, true); assert.equal((await assets.list()).length, 0);
  const media = await service.openMedia(preview.token); assert.equal((await readFile(media.path)).toString(), 'test-mp3');
  const batch = service.startImport([track.key], 'actor');
  for (let i = 0; i < 40 && service.getImport(batch.id, 'actor').items[0].status !== 'succeeded'; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(service.getImport(batch.id, 'actor').items[0].status, 'succeeded');
  assert.equal((await assets.list())[0].audioSource?.previewOnly, true);
  assert.equal((await assets.list())[0].durationMs, 1000);

  const bad = await fixture(t, { resolveMedia: async () => ({ url: 'https://m701.music.126.net/a.mp3', extension: 'mp3', previewOnly: false }),
    openRemote: async () => { const r = Readable.from(['html']) as IncomingMessage; r.headers = {}; return r; }, probe: async () => { throw new Error('invalid'); } });
  await bad.service.search('netease', 'Test');
  await assert.rejects(() => bad.service.preview(track.key));
  assert.deepEqual(await bad.assets.list(), []);
});
