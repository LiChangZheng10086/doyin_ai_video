import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { LocalStorage } from './storage.js';
import type { JobRecord } from '../types.js';

test('gallery persists independent drafts and blocks stale versions, files and previews', async () => {
  const { GalleryService } = await import('./galleries.js');
  const root = await mkdtemp(path.join(tmpdir(), 'galleries-test-'));
  try {
    await mkdir(path.join(root, 'raw/videos'), { recursive: true });
    const videoPath = path.join(root, 'raw/videos/job-1.mp4');
    await writeFile(videoPath, 'local-original-video');
    const job = { id: 'job-1', topic: '本地字幕测试', videoPath } as JobRecord;
    let block: (() => void) | undefined;
    let fail = false;
    const media = {
      probe: async () => ({ width: 320, height: 480, duration: 10 }),
      frame: async () => Buffer.from('frame'),
      render: async (_video: string, _image: unknown, output: string) => {
        if (fail) throw new Error('render failed');
        if (block) await new Promise<void>(resolve => { block = resolve; });
        const png = Buffer.alloc(30); Buffer.from('89504e470d0a1a0a', 'hex').copy(png); png.writeUInt32BE(1080, 16); png.writeUInt32BE(1440, 20);
        await writeFile(output, png);
      },
    };
    const deps = { storage: new LocalStorage(root), jobs: { get: async (id: string) => id === job.id ? job : null }, media };
    const service = new GalleryService(deps);
    const draft = await service.create('job-1');
    assert.equal(draft.status, 'draft');
    assert.equal((await new GalleryService(deps).get(draft.id)).sourceJobId, 'job-1');
    await assert.rejects(service.update(draft.id, { ...draft, version: 0 }), /版本/);
    await assert.rejects(service.update(draft.id, { ...draft, images: [{ ...draft.images[0]!, mainTime: 12 }] }), /时间/);
    const ready = await service.render(draft.id, draft.version);
    assert.equal(ready.status, 'ready');
    const preview = await service.preview(draft.id, ready.version);
    assert.equal(preview.imageCount, 1);
    assert.equal(preview.violations.length, 0);
    const edited = await service.update(draft.id, { ...ready, title: '新标题' });
    assert.notEqual((await service.preview(draft.id, edited.version)).previewRevision, preview.previewRevision);
    // Editing a timestamp invalidates finished images even when the old generation is retained.
    const dirty = await service.update(draft.id, { ...edited, images: [{ ...edited.images[0]!, mainTime: 3 }] });
    await assert.rejects(service.preview(draft.id, dirty.version), /重新生成/);
    fail = true;
    await assert.rejects(service.render(draft.id, dirty.version), /render failed/);
    assert.equal((await service.get(draft.id)).status, 'failed');
    fail = false;
    const refreshed = await service.render(draft.id, (await service.get(draft.id)).version);
    await writeFile(videoPath, 'changed-video-content');
    await assert.rejects(service.preview(draft.id, refreshed.version), /原视频/);
    await service.render(draft.id, refreshed.version);
    const current = await service.get(draft.id);
    await writeFile(path.join(root, 'output/galleries', current.id, current.generated!.id, '0.png'), 'tampered');
    await assert.rejects(service.preview(draft.id, current.version), /图片/);
    // IDs must never be turned into paths before validating them.
    await assert.rejects(service.get('../escape'), /标识/);
    await assert.rejects(service.get('__proto__'), /不存在/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('validated video identity survives path replacement; preserved mtime and stale editor versions cannot approve old output', async () => {
  const { GalleryService } = await import('./galleries.js');
  const root = await mkdtemp(path.join(tmpdir(), 'gallery-identity-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'gallery-outside-'));
  try {
    const videoPath = path.join(root, 'source.mp4');
    await writeFile(videoPath, 'original'); await writeFile(path.join(outside, 'secret.mp4'), 'external');
    let replace = false;
    const service = new GalleryService({ storage: new LocalStorage(root), jobs: { get: async () => ({ id: 'source', topic: '测试', videoPath } as JobRecord) }, media: {
      probe: async () => {
        if (replace) { replace = false; await rm(videoPath); await symlink(path.join(outside, 'secret.mp4'), videoPath); }
        return { width: 100, height: 100, duration: 5 };
      },
      frame: async video => readFile(video), render: async (_v, _i, output) => { await writeFile(output, 'image'); },
    } });
    const gallery = await service.create('source');
    replace = true;
    assert.equal((await service.frame(gallery.id, 1)).toString(), 'original');
    await rm(videoPath); await writeFile(videoPath, 'original');
    const ready = await service.render(gallery.id, gallery.version);
    const before = await stat(videoPath);
    await writeFile(videoPath, 'replaced'); await utimes(videoPath, before.atime, before.mtime);
    await assert.rejects(service.preview(gallery.id, ready.version), /原视频/);
    const latest = await service.render(gallery.id, ready.version);
    await service.update(gallery.id, { ...latest, title: '另一个窗口的修改' });
    await assert.rejects(service.preview(gallery.id, latest.version), /版本/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('render locks drafts, recovers interrupted runs and rejects unsafe video paths', async () => {
  const { GalleryService } = await import('./galleries.js');
  const root = await mkdtemp(path.join(tmpdir(), 'galleries-lock-'));
  try {
    await mkdir(path.join(root, 'raw/videos'), { recursive: true });
    const videoPath = path.join(root, 'raw/videos/job.mp4'); await writeFile(videoPath, 'video');
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const service = new GalleryService({ storage: new LocalStorage(root), jobs: { get: async () => ({ id: 'job', topic: '测试', videoPath } as JobRecord) },
      media: { probe: async () => ({ width: 100, height: 100, duration: 5 }), frame: async () => Buffer.from('frame'),
        render: async (_v, _i, output) => { started(); await new Promise<void>(resolve => { release = resolve; }); await writeFile(output, Buffer.from('image')); } } });
    const gallery = await service.create('job');
    const rendering = service.render(gallery.id, gallery.version);
    await entered;
    await assert.rejects(service.update(gallery.id, gallery), /生成中/);
    await assert.rejects(service.render(gallery.id, gallery.version), /生成中/);
    await assert.rejects(service.remove(gallery.id, gallery.version), /生成中/);
    release(); await rendering;
    const storage = new LocalStorage(root);
    const record = await service.get(gallery.id); record.status = 'running';
    await storage.writeJsonAtomic('cache/galleries.json', { [gallery.id]: record });
    const recovered = new GalleryService({ storage, jobs: { get: async () => null } });
    assert.equal((await recovered.get(gallery.id)).status, 'failed');
    const unsafe = new GalleryService({ storage: new LocalStorage(root), jobs: { get: async () => ({ id: 'bad', videoPath: '/tmp/outside.mp4' } as JobRecord) } });
    await assert.rejects(unsafe.create('bad'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
