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

test('plans persist separately, confirmation binds transcript/source and render failures preserve old generation', async () => {
  const { GalleryService } = await import('./galleries.js');
  const root = await mkdtemp(path.join(tmpdir(), 'gallery-plan-'));
  try {
    const storage = new LocalStorage(root);
    await storage.ensureBaseDirs();
    const videoPath = storage.resolve('raw/videos/job.mp4'); await writeFile(videoPath, 'video');
    const asset = { segments: Array.from({ length: 9 }, (_, i) => ({ text: `原句${i}。`, start: i, end: i + .8 })), transcript: '原句', text: '原句' };
    await storage.writeJsonAtomic('raw/transcripts/job.json', asset);
    let change = false; let fail = false;
    const deps = { storage, jobs: { get: async () => ({ id: 'job', topic: '测试', videoPath } as JobRecord) }, media: {
      probe: async () => ({ width: 320, height: 480, duration: 10 }), frame: async () => Buffer.from('frame'),
      suggestSubtitle: async (_v: string, quote: { start: number; end: number }) => ({ time: (quote.start + quote.end) / 2, bandTop: .82, bandBottom: .85 }),
      render: async (_v: string, _i: unknown, out: string) => { if (fail) throw new Error('render fail'); if (change) { change = false; await storage.writeJsonAtomic('raw/transcripts/job.json', { ...asset, transcript: 'changed' }); } await writeFile(out, 'png'); },
    } };
    const service = new GalleryService(deps);
    const initial = await service.create('job');
    const ready = await service.render(initial.id, initial.version);
    const planned = await service.plan(initial.id, { version: ready.version, targetLines: 9 });
    assert.deepEqual(planned.images, ready.images);
    assert.deepEqual(planned.generated, ready.generated);
    assert.ok(planned.plan?.id);
    assert.equal((await new GalleryService(deps).get(initial.id)).plan?.id, planned.plan.id);
    assert.equal((await service.planImage(initial.id, 0, planned.plan.id, planned.version)).toString(), 'png');
    await assert.rejects(service.renderPlan(initial.id, { version: planned.version, planId: planned.plan.id, subtitlesConfirmed: false }), /核对/);
    const previewFile = storage.resolve('output/galleries', initial.id, `plan-${planned.plan.id}`, '0.png');
    await writeFile(previewFile, 'tampered');
    await assert.rejects(service.planImage(initial.id, 0, planned.plan.id, planned.version), /预览/);
    await assert.rejects(service.renderPlan(initial.id, { version: planned.version, planId: planned.plan.id, subtitlesConfirmed: true }), /预览/);
    await writeFile(previewFile, 'png');
    await assert.rejects(service.renderPlan(initial.id, { version: ready.version, planId: planned.plan.id, subtitlesConfirmed: true }), /版本/);
    await storage.writeJsonAtomic('raw/transcripts/job.json', { ...asset, transcript: 'changed' });
    await assert.rejects(service.renderPlan(initial.id, { version: planned.version, planId: planned.plan.id, subtitlesConfirmed: true }), /转录/);
    await storage.writeJsonAtomic('raw/transcripts/job.json', asset);
    fail = true;
    await assert.rejects(service.renderPlan(initial.id, { version: planned.version, planId: planned.plan.id, subtitlesConfirmed: true }), /render fail/);
    assert.equal((await service.get(initial.id)).generated?.id, ready.generated?.id);
    assert.deepEqual((await service.get(initial.id)).images, ready.images);
    fail = false;
    const again = await service.plan(initial.id, { version: (await service.get(initial.id)).version });
    change = true;
    await assert.rejects(service.renderPlan(initial.id, { version: again.version, planId: again.plan!.id, subtitlesConfirmed: true }), /转录/);
    const stale = await service.get(initial.id);
    assert.equal(stale.status, 'failed');
    // The ordinary render endpoint cannot turn an applied stale plan into a ready generation.
    await assert.rejects(service.render(initial.id, stale.version), /转录/);
    assert.equal(stale.generated?.id, ready.generated?.id);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('blank plans cannot render and source changes or duplicate confirmation cannot approve stale plans', async () => {
  const { GalleryService } = await import('./galleries.js');
  const root = await mkdtemp(path.join(tmpdir(), 'gallery-plan-lock-'));
  try {
    const storage = new LocalStorage(root); await storage.ensureBaseDirs();
    const videoPath = storage.resolve('raw/videos/job.mp4'); await writeFile(videoPath, 'video');
    await storage.writeJsonAtomic('raw/transcripts/job.json', { segments: [{ start: 0, end: 1, text: '实际原句。' }], transcript: '实际原句。' });
    let blank = true; let hold = false;
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const service = new GalleryService({ storage, jobs: { get: async () => ({ id: 'job', videoPath } as JobRecord) }, media: {
      probe: async () => ({ width: 320, height: 480, duration: 5 }), frame: async () => Buffer.from('frame'),
      suggestSubtitle: async () => blank ? null : ({ time: .5, bandTop: .82, bandBottom: .85 }),
      render: async (_v, _i, out) => { if (hold) { entered(); await new Promise<void>(resolve => { release = resolve; }); } await writeFile(out, 'png'); },
    } });
    const draft = await service.create('job');
    await assert.rejects(service.renderPlan(draft.id, { version: draft.version, subtitlesConfirmed: true } as never), /方案/);
    const empty = await service.plan(draft.id, { version: draft.version });
    assert.equal(empty.plan!.images.length, 0);
    await assert.rejects(service.renderPlan(draft.id, { version: empty.version, planId: empty.plan!.id, subtitlesConfirmed: true }), /没有可用/);
    blank = false;
    const proposed = await service.plan(draft.id, { version: empty.version });
    await writeFile(videoPath, 'changed');
    await assert.rejects(service.planImage(draft.id, 0, proposed.plan!.id, proposed.version), /原视频/);
    await assert.rejects(service.renderPlan(draft.id, { version: proposed.version, planId: proposed.plan!.id, subtitlesConfirmed: true }), /原视频/);
    const fresh = await service.plan(draft.id, { version: proposed.version });
    hold = true;
    const input = { version: fresh.version, planId: fresh.plan!.id, subtitlesConfirmed: true };
    const rendering = service.renderPlan(draft.id, input);
    await started;
    const running = await service.get(draft.id);
    assert.equal((await service.planImage(draft.id, 0, fresh.plan!.id, running.version)).toString(), 'png');
    await assert.rejects(service.renderPlan(draft.id, input), /生成中/);
    await assert.rejects(service.update(draft.id, fresh), /生成中/);
    release(); const ready = await rendering;
    assert.equal(ready.generated!.transcriptHash, fresh.plan!.transcriptHash);
    await storage.writeJsonAtomic('raw/transcripts/job.json', { segments: [{ start: 0, end: 1, text: '新的原句。' }], transcript: '新的原句。' });
    await assert.rejects(service.preview(draft.id, ready.version), /转录/);
    const edited = await service.update(draft.id, { ...ready, title: '手动编辑' });
    assert.equal(edited.plan, undefined);
    await assert.rejects(readFile(storage.resolve('output/galleries', draft.id, `plan-${fresh.plan!.id}`, '0.png')), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('automatic render rejects bytes differing from the confirmed preview and preserves prior output', async () => {
  const { GalleryService } = await import('./galleries.js');
  const root = await mkdtemp(path.join(tmpdir(), 'gallery-plan-parity-'));
  try {
    const storage = new LocalStorage(root); await storage.ensureBaseDirs();
    const videoPath = storage.resolve('raw/videos/job.mp4'); await writeFile(videoPath, 'unchanged-video');
    await storage.writeJsonAtomic('raw/transcripts/job.json', { segments: [{ start: 0, end: 1, text: '实际原句。' }], transcript: '实际原句。' });
    let outputBytes = 'confirmed-preview-pixels';
    const service = new GalleryService({ storage, jobs: { get: async () => ({ id: 'job', videoPath } as JobRecord) }, media: {
      probe: async () => ({ width: 320, height: 480, duration: 5 }), frame: async () => Buffer.from('frame'),
      suggestSubtitle: async () => ({ time: .5, bandTop: .82, bandBottom: .85 }),
      render: async (_v, _i, out) => { await writeFile(out, outputBytes); },
    } });
    const draft = await service.create('job');
    const original = await service.render(draft.id, draft.version);
    const planned = await service.plan(draft.id, { version: original.version });
    outputBytes = 'different-final-pixels';
    await assert.rejects(service.renderPlan(draft.id, { version: planned.version, planId: planned.plan!.id, subtitlesConfirmed: true }), /预览.*不一致|不一致.*预览/);
    const failed = await service.get(draft.id);
    assert.equal(failed.status, 'failed');
    assert.deepEqual(failed.images, original.images);
    assert.deepEqual(failed.generated, original.generated);
    assert.equal((await service.image(draft.id, 0, original.generated!.id)).toString(), 'confirmed-preview-pixels');
    outputBytes = 'confirmed-preview-pixels';
    const ready = await service.renderPlan(draft.id, { version: failed.version, planId: planned.plan!.id, subtitlesConfirmed: true });
    assert.equal(ready.status, 'ready');
    assert.deepEqual(ready.generated!.hashes, ready.plan!.previewHashes);
  } finally { await rm(root, { recursive: true, force: true }); }
});
