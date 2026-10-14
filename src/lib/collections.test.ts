import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CollectionStore } from "./collections.js";
import { LocalStorage } from "./storage.js";
import type { JobRecord } from "../types.js";

test("CollectionStore keeps a crawled cover URL when creating child jobs", async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "collections-cover-"));
  const storage = new LocalStorage(storageRoot);
  const capturedInputs: Array<{ coverUrl?: string }> = [];
  const jobStore = {
    async create(input: { sourceUrl?: string; topic?: string; coverUrl?: string }) {
      capturedInputs.push(input);
      return {
        id: "job-1",
        sourceUrl: input.sourceUrl ?? "",
        topic: input.topic ?? "",
        status: "queued",
        stage: "submitted",
        workflowMode: "manual",
        storagePath: "processed/scripts/job-1.json",
        createdAt: "2026-08-07T00:00:00.000Z",
        updatedAt: "2026-08-07T00:00:00.000Z"
      } as JobRecord;
    },
    async get() {
      return null;
    }
  };
  const collections = new CollectionStore(storage, jobStore);
  await collections.init();
  await storage.writeJson("cache/collections-index.json", {
    collection: {
      id: "collection",
      sourcePageUrl: "https://www.douyin.com/user/test",
      secUid: "sec-uid",
      nickname: "测试作者",
      avatarUrl: "",
      crawlResult: {
        items: [{
          awemeId: "video-1",
          desc: "测试视频",
          coverUrl: "https://cdn.example.com/video-1.jpg",
          videoUrl: "",
          duration: 10,
          createTime: 0,
          statistics: { diggCount: 0, commentCount: 0, shareCount: 0, playCount: 0 }
        }],
        totalCollected: 1,
        hasMore: false,
        nextCursor: 0
      },
      childJobIds: [],
      createdAt: "2026-08-07T00:00:00.000Z",
      updatedAt: "2026-08-07T00:00:00.000Z"
    }
  });

  await collections.createChildJobs("collection", ["video-1"]);
  assert.equal(capturedInputs[0]?.coverUrl, "https://cdn.example.com/video-1.jpg");
});


test('CollectionStore serializes metadata changes and child creation without duplicate jobs', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'collections-concurrent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = new LocalStorage(root);
  let created = 0;
  const collections = new CollectionStore(storage, {
    async create() { return { id: `job-${++created}` } as JobRecord; },
    async get() { return null; }
  });
  await collections.init();
  const fixture = (id: string) => ({ id, nickname: '作者', sourcePageUrl: 'https://www.douyin.com/user/test', childJobIds: [], childJobMap: {}, crawlResult: { items: [{ awemeId: '1', desc: 'video' }] } });
  await storage.writeJson('cache/collections-index.json', { one: fixture('one'), two: fixture('two') });
  await Promise.all([
    collections.updateSkillMeta('one', { skillName: 'saved', skillPath: 'skills/saved', skillGeneratedAt: 'now' }),
    collections.toggleAutoSyncSkill('two', true),
    collections.createChildJobs('one', ['1']),
    collections.createChildJobs('one', ['1'])
  ]);
  assert.equal((await collections.get('one'))?.skillName, 'saved');
  assert.equal((await collections.get('two'))?.autoSyncSkill, true);
  assert.equal(created, 1);
  assert.deepEqual((await collections.get('one'))?.childJobMap, { '1': 'job-1' });
});

for (const content of ['{"broken":', '[]', 'null', '{"broken":null}', '{"broken":{"id":"other"}}']) {
  test(`CollectionStore preserves a damaged index: ${content}`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'collections-damaged-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const storage = new LocalStorage(root);
    await storage.ensureBaseDirs();
    await writeFile(storage.resolve('cache/collections-index.json'), content);
    const collections = new CollectionStore(storage, { async create() { throw new Error('unused'); }, async get() { return null; } });
    await assert.rejects(collections.init());
    await assert.rejects(collections.toggleAutoSyncSkill('broken', true));
    assert.equal(await readFile(storage.resolve('cache/collections-index.json'), 'utf8'), content);
  });
}

test('CollectionStore merges a completed crawl with current metadata and never revives a deleted collection', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'collections-crawl-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = new LocalStorage(root);
  const collections = new CollectionStore(storage, { async create() { throw new Error('unused'); }, async get() { return null; } }, { cookieString: 'test=value' });
  await collections.init();
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let entered!: () => void;
  let release!: () => void;
  let gate = Promise.resolve();
  globalThis.fetch = async (input) => {
    if (String(input).includes('/user/')) { entered?.(); await gate; return new Response(''); }
    return Response.json({ status_code: 0, has_more: 0, aweme_list: [{ aweme_id: 'video-1', desc: 'video' }] });
  };
  const { collection } = await collections.create('https://www.douyin.com/user/test');
  for (const deleted of [false, true]) {
    const started = new Promise<void>((resolve) => { entered = resolve; });
    gate = new Promise<void>((resolve) => { release = resolve; });
    const updating = collections.update(collection.id);
    const checked = deleted ? assert.rejects(updating, /collection not found/) : updating;
    await started;
    try {
      if (deleted) await collections.delete(collection.id);
      else await collections.updateSkillMeta(collection.id, { skillName: 'during-crawl', skillPath: 'skills/test', skillGeneratedAt: 'now' });
    } finally { release(); }
    await checked;
    if (!deleted) assert.equal((await collections.get(collection.id))?.skillName, 'during-crawl');
  }
  assert.equal(await collections.get(collection.id), null);
});

test('CollectionStore preserves the last atomic index and accepts the next mutation after a disk failure', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'collections-disk-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let fail = false;
  const { rename } = await import('node:fs/promises');
  const storage = new LocalStorage(root, { rename: async (...args) => {
    if (fail) { fail = false; throw new Error('disk full'); }
    return rename(...args);
  } });
  const collections = new CollectionStore(storage, { async create() { throw new Error('unused'); }, async get() { return null; } });
  await collections.init();
  await storage.writeJson('cache/collections-index.json', { one: { id: 'one', nickname: 'author', autoSyncSkill: false } });
  fail = true;
  await assert.rejects(collections.toggleAutoSyncSkill('one', true), /disk full/);
  assert.equal((await collections.get('one'))?.autoSyncSkill, false);
  await collections.toggleAutoSyncSkill('one', true);
  assert.equal((await collections.get('one'))?.autoSyncSkill, true);
});
