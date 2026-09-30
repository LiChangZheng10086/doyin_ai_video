import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { LocalStorage } from './storage.js';
import { HotspotService, type HotspotItem } from './hotspots.js';

const item: HotspotItem = { sourceId: 'toutiao', itemId: '123', title: '测试选题', url: 'https://www.toutiao.com/trending/123/', rank: 1, heat: '456' };
const urls: Record<string, string> = { douyin: 'https://www.douyin.com/hot/123', toutiao: item.url, baidu: 'https://www.baidu.com/s?wd=news', zhihu: 'https://www.zhihu.com/question/123', bilibili: 'https://search.bilibili.com/all?keyword=news' };
const sourceItem = (sourceId: string): HotspotItem => ({ ...item, sourceId, url: urls[sourceId] });
async function fixture(fn: (storage: LocalStorage) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'hotspots-test-'));
  try { await fn(new LocalStorage(root)); } finally { await rm(root, { recursive: true, force: true }); }
}

test('cache survives restart; manual refresh is rate limited and stale failures retain old items', () => fixture(async storage => {
  let now = 1_800_000_000_000; let calls = 0;
  const service = new HotspotService(storage, { now: () => now, fetchSource: async source => { calls++; return [sourceItem(source)]; } });
  const first = await service.list(); assert.ok(first.every(board => board.status === 'fresh' && board.delivery === 'network'));
  assert.equal(calls, 5);
  await service.list(true); assert.equal(calls, 5);
  const restarted = new HotspotService(storage, { now: () => now, fetchSource: async () => { throw new Error('offline'); } });
  assert.ok((await restarted.list()).every(board => board.delivery === 'cache' && board.status === 'fresh'));
  now += 600_001;
  const failed = await restarted.list();
  assert.ok(failed.every(board => board.status === 'stale' && board.items.length === 1 && board.error));
  assert.equal(failed[0].fetchedAt, first[0].fetchedAt);
}));

test('parallel refresh coalesces each source; one source failure does not blank the rest', () => fixture(async storage => {
  const counts = new Map<string, number>();
  const service = new HotspotService(storage, { fetchSource: async source => { counts.set(source, (counts.get(source) ?? 0) + 1); await new Promise(resolve => setTimeout(resolve, 5)); if (source === 'douyin') throw new Error('blocked'); return [sourceItem(source)]; } });
  const [a, b] = await Promise.all([service.list(true), service.list(true)]);
  assert.deepEqual(a, b); assert.ok([...counts.values()].every(count => count === 1));
  assert.equal(a.find(board => board.source.id === 'douyin')?.status, 'unavailable');
  assert.equal(a.filter(board => board.status === 'fresh').length, 4);
}));

test('failed sources are rate limited and corrupted caches are not advertised as fresh', () => fixture(async storage => {
  await storage.writeJsonAtomic('cache/hotspots/douyin.json', { items: 'broken', fetchedAt: 'tomorrow' });
  let calls = 0;
  const service = new HotspotService(storage, { fetchSource: async () => { calls++; throw new Error('offline'); } });
  assert.ok((await service.list()).every(board => board.status === 'unavailable'));
  await service.list(true); assert.equal(calls, 5);
}));

test('favorites snapshot real cached items, survive restart, keep notes on duplicate save, and guard old edits', () => fixture(async storage => {
  const service = new HotspotService(storage, { fetchSource: async source => [sourceItem(source)] });
  await service.list();
  await assert.rejects(service.save('../config', '123'));
  await assert.rejects(service.save('toutiao', 'invented'));
  const [saved, duplicate] = await Promise.all([service.save('toutiao', '123'), service.save('toutiao', '123')]);
  assert.equal(saved.id, duplicate.id); assert.equal((await service.favorites()).length, 1);
  const edited = await service.update(saved.id, '我的选题角度', saved.version);
  assert.equal(edited.note, '我的选题角度'); assert.equal(edited.version, 2);
  await assert.rejects(service.update(saved.id, '过期编辑', 1), (error: any) => error.status === 409);
  await assert.rejects(service.update(saved.id, 'x'.repeat(2001), 2), (error: any) => error.status === 400);
  assert.equal((await service.save('toutiao', '123')).note, '我的选题角度');
  const restarted = new HotspotService(storage);
  assert.equal((await restarted.favorites())[0].note, '我的选题角度');
  await assert.rejects(restarted.remove(saved.id, 1), (error: any) => error.status === 409);
  await restarted.remove(saved.id, 2); assert.equal((await restarted.favorites()).length, 0);
}));

test('concurrent distinct favorites persist without lost updates', () => fixture(async storage => {
  const service = new HotspotService(storage, { fetchSource: async source => [sourceItem(source)] }); await service.list();
  await Promise.all(['toutiao', 'douyin', 'zhihu'].map(source => service.save(source, '123')));
  assert.equal((await new HotspotService(storage).favorites()).length, 3);
}));
