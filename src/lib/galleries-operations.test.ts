import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { GalleryService } from './galleries.js';
import { LocalStorage } from './storage.js';
import type { JobRecord } from '../types.js';

async function fixture(count = 16, candidatesPerQuote = 1) {
  const root = await mkdtemp(path.join(tmpdir(), 'gallery-operation-'));
  const storage = new LocalStorage(root); await storage.ensureBaseDirs();
  const videoPath = storage.resolve('raw/videos/job.mp4'); await writeFile(videoPath, 'source');
  const segments = Array.from({ length: count }, (_, i) => ({ start: i * 2, end: i * 2 + 1, text: `第${i}句。` }));
  await storage.writeJsonAtomic('raw/transcripts/job.json', { segments, transcript: segments.map(s => s.text).join(''), duration: count * 2 });
  let renders = 0; let ocr = 0; const contexts: { start: number; end: number; text?: string; targetText?: string; adjacentText?: string }[] = [];
  let hook: (() => Promise<void>) | undefined;
  const deps: ConstructorParameters<typeof GalleryService>[0] = { storage, jobs: { get: async () => ({ id: 'job', videoPath } as JobRecord) }, media: {
    probe: async () => ({ width: 320, height: 480, duration: count * 2 }), frame: async () => Buffer.from('frame'),
    suggestSubtitles: async (_v, q, _r, control) => { await control?.checkpoint?.(); contexts.push(q); ocr++; await hook?.(); return Array.from({ length: candidatesPerQuote }, (_, i) => ({ time: q.start + .05 + i * .01, bandTop: .8, bandBottom: .85, verification: 'ocr' as const, recognizedText: `${q.text}${i}` })); },
    render: async (_v, image, out) => { renders++; await hook?.(); await writeFile(out, JSON.stringify(image)); },
  }, contentPlanner: { plan: async items => items.map(i => ({ ...i, selected: i.segmentIndex < 8, reason: '保留重点' })) } };
  const service = new GalleryService(deps);
  const services = [service];
  return { service, restart: () => { const next = new GalleryService(deps); services.push(next); return next; }, storage, root, contexts, counts: () => ({ renders, ocr }), hook: (next?: () => Promise<void>) => { hook = next; }, cleanup: async () => {
    for (const service of services) {
      const active = service as unknown as { operations: Map<string, { resume?: () => void }>; busy: Set<string> };
      for (const operation of active.operations.values()) operation.resume?.();
      active.operations.clear();
    }
    await until(async () => services.every(service => !(service as unknown as { busy: Set<string> }).busy.size));
    await rm(root, { recursive: true, force: true });
  } };
}
async function until(predicate: () => Promise<boolean>) {
  const end = Date.now() + 3000;
  while (!(await predicate())) { if (Date.now() > end) throw new Error('operation timeout'); await new Promise(r => setTimeout(r, 5)); }
}

test('content confirmation and 35 image estimate prevent OCR without trimming source', async () => {
  const f = await fixture(400);
  try {
    const g = await f.service.create('job');
    await assert.rejects(f.service.startOperation(g.id, { kind: 'candidates', version: g.version }), /文字|内容/);
    const content = await f.service.prepareContent(g.id, { version: g.version, targetLines: 8 });
    assert.equal(content.contentPlan!.items.length, 400);
    assert.ok(content.contentPlan!.estimatedImages > 35);
    await assert.rejects(f.service.plan(g.id, { version: content.version }), /35/);
    const confirmed = await f.service.updateContent(g.id, { version: content.version, contentPlanId: content.contentPlan!.id, selectedIds: content.contentPlan!.items.map(i => i.id) });
    await assert.rejects(f.service.startOperation(g.id, { kind: 'candidates', version: confirmed.version, contentPlanId: confirmed.contentPlan!.id, contentConfirmed: true }), /35/);
    assert.deepEqual(f.counts(), { ocr: 0, renders: 0 });
    await assert.rejects(f.service.updateContent(g.id, { version: confirmed.version, contentPlanId: confirmed.contentPlan!.id, selectedIds: ['unknown'] }), /编号/);
  } finally { await f.cleanup(); }
});

test('candidate and final image operations pause at boundaries, continue without redo and let other galleries edit', async () => {
  const f = await fixture();
  let release: (() => void) | undefined;
  try {
    const g = await f.service.create('job'); const other = await f.service.create('job');
    const content = await f.service.prepareContent(g.id, { version: g.version, targetLines: 8 });
    const confirmed = await f.service.updateContent(g.id, { version: content.version, contentPlanId: content.contentPlan!.id, selectedIds: content.contentPlan!.items.map(i => i.id) });
    for (const kind of ['candidates', 'render'] as const) {
      const current = await f.service.get(g.id);
      let entered!: () => void; const start = new Promise<void>(r => { entered = r; });
      const gate = new Promise<void>(r => { release = r; }); let first = true;
      f.hook(async () => { if (first) { first = false; entered(); await gate; } });
      const running = await f.service.startOperation(g.id, { version: current.version, kind,
        ...(kind === 'candidates' ? { contentPlanId: confirmed.contentPlan!.id, contentConfirmed: true } : { planId: current.plan!.id, subtitlesConfirmed: true }) }, 'owner');
      await start;
      await assert.rejects(f.service.pauseOperation(g.id, running.operation!.id, 'other'), /操作者|权限/);
      await assert.rejects(f.service.pauseOperation(g.id, 'old', 'owner'), /任务/);
      const pausing = await f.service.pauseOperation(g.id, running.operation!.id, 'owner');
      assert.equal(pausing.operation!.status, 'pausing'); release!();
      await until(async () => (await f.service.get(g.id)).operation!.status === 'paused');
      const counts = f.counts(); await new Promise(r => setTimeout(r, 30)); assert.deepEqual(f.counts(), counts);
      await assert.rejects(f.service.remove(g.id, running.version), /生成中|任务/);
      const otherCurrent = await f.service.get(other.id);
      await Promise.race([f.service.update(other.id, { ...otherCurrent, title: 'other editable' }), new Promise((_, reject) => setTimeout(() => reject(new Error('global queue blocked')), 500))]);
      await f.service.resumeOperation(g.id, running.operation!.id, 'owner');
      await until(async () => ['completed', 'failed'].includes((await f.service.get(g.id)).operation!.status));
      const done = await f.service.get(g.id); assert.equal(done.operation!.status, 'completed', done.operation!.error);
      assert.equal(done.operation!.completed, done.operation!.total);
    }
    const done = await f.service.get(g.id);
    assert.equal(f.counts().ocr, 16); assert.equal(f.counts().renders, done.plan!.images.length * 2);
  } finally { release?.(); f.hook(); await f.cleanup(); }
});

test('actual candidate overflow fails before any drawing and selected missing OCR remains blocked', async () => {
  const f = await fixture(16, 25);
  try {
    const g = await f.service.create('job'); const c = await f.service.prepareContent(g.id, { version: g.version, targetLines: 8 });
    const selected = await f.service.updateContent(g.id, { version: c.version, contentPlanId: c.contentPlan!.id, selectedIds: c.contentPlan!.items.map(i => i.id) });
    const running = await f.service.startOperation(g.id, { kind: 'candidates', version: selected.version, contentPlanId: selected.contentPlan!.id, contentConfirmed: true });
    await until(async () => (await f.service.get(g.id)).operation!.status === 'failed');
    assert.match((await f.service.get(g.id)).operation!.error!, /35/); assert.equal(f.counts().renders, 0);
    assert.equal(running.operation!.status, 'running');
  } finally { await f.cleanup(); }
});

test('candidate drawing can pause after one completed image without repeating OCR or that image', async () => {
  const f = await fixture(32); let release!: () => void;
  try {
    const g = await f.service.create('job'); const c = await f.service.prepareContent(g.id, { version: g.version });
    const confirmed = await f.service.updateContent(g.id, { version: c.version, contentPlanId: c.contentPlan!.id, selectedIds: c.contentPlan!.items.map(i => i.id) });
    let entered!: () => void; const started = new Promise<void>(r => { entered = r; });
    const gate = new Promise<void>(r => { release = r; }); let first = true;
    f.hook(async () => { if (f.counts().renders === 1 && first) { first = false; entered(); await gate; } });
    const running = await f.service.startOperation(g.id, { kind: 'candidates', version: confirmed.version, contentPlanId: confirmed.contentPlan!.id, contentConfirmed: true });
    await started; await f.service.pauseOperation(g.id, running.operation!.id); release();
    await until(async () => (await f.service.get(g.id)).operation!.status === 'paused');
    const paused = await f.service.get(g.id); assert.equal(paused.operation!.stage, 'candidates'); assert.equal(paused.operation!.completed, 1);
    assert.deepEqual(f.counts(), { ocr: 32, renders: 1 });
    await f.service.resumeOperation(g.id, running.operation!.id);
    await until(async () => (await f.service.get(g.id)).operation!.status === 'completed');
    const done = await f.service.get(g.id); assert.equal(f.counts().renders, done.plan!.images.length); assert.equal(f.counts().ocr, 32);
  } finally { release?.(); f.hook(); await f.cleanup(); }
});

test('AI selection retains originals, manual restoration works, and source changes invalidate confirmation', async () => {
  const f = await fixture();
  try {
    const g = await f.service.create('job'); const c = await f.service.prepareContent(g.id, { version: g.version });
    await assert.rejects(f.service.startOperation(g.id, { version: c.version, kind: 'content', contentPlanId: 'stale' }), /内容|文字/);
    await f.service.startOperation(g.id, { version: c.version, kind: 'content', contentPlanId: c.contentPlan!.id });
    await until(async () => (await f.service.get(g.id)).operation!.status === 'completed');
    const ai = await f.service.get(g.id); assert.equal(ai.contentPlan!.method, 'ai'); assert.equal(ai.contentPlan!.confirmedAt, undefined);
    assert.deepEqual(ai.contentPlan!.items.map(({ selected: _s, reason: _r, ...item }) => item), c.contentPlan!.items.map(({ selected: _s, reason: _r, ...item }) => item));
    const selected = await f.service.updateContent(g.id, { version: ai.version, contentPlanId: ai.contentPlan!.id, selectedIds: ai.contentPlan!.items.filter(i => i.selected).map(i => i.id) });
    const restored = await f.service.updateContent(g.id, { version: selected.version, contentPlanId: selected.contentPlan!.id, selectedIds: selected.contentPlan!.items.map(i => i.id) });
    assert.equal(restored.contentPlan!.items.filter(i => i.selected).length, 16);
    await writeFile(f.storage.resolve('raw/videos/job.mp4'), 'changed source');
    await assert.rejects(f.service.startOperation(g.id, { version: restored.version, kind: 'candidates', contentPlanId: restored.contentPlan!.id, contentConfirmed: true }), /来源|转录/);
    assert.deepEqual(f.counts(), { renders: 0, ocr: 0 });
  } finally { await f.cleanup(); }
});

test('deselected text is not a missing candidate; selected OCR misses still block final generation', async () => {
  for (const found of [0, 1]) {
    const f = await fixture(16, found);
    try {
      const g = await f.service.create('job'); const c = await f.service.prepareContent(g.id, { version: g.version });
      const confirmed = await f.service.updateContent(g.id, { version: c.version, contentPlanId: c.contentPlan!.id, selectedIds: c.contentPlan!.items.slice(0, 8).map(i => i.id) });
      await f.service.startOperation(g.id, { version: confirmed.version, kind: 'candidates', contentPlanId: confirmed.contentPlan!.id, contentConfirmed: true });
      await until(async () => (await f.service.get(g.id)).operation!.status === 'completed');
      const planned = await f.service.get(g.id);
      assert.equal(planned.plan!.scope, 'selection'); assert.equal(f.counts().ocr, 8); assert.equal(planned.plan!.coverage!.totalSegments, 8);
      assert.equal(planned.plan!.excluded.length, found ? 0 : 8);
      if (!found) await assert.rejects(f.service.startOperation(g.id, { version: planned.version, kind: 'render', planId: planned.plan!.id, subtitlesConfirmed: true }), /不完整|覆盖/);
    } finally { await f.cleanup(); }
  }
});

test('restart marks active operations interrupted and keeps old generated assets', async () => {
  const f = await fixture();
  try {
    const g = await f.service.create('job'); const ready = await f.service.render(g.id, g.version);
    const active = { ...ready, operation: { id: 'active', actorId: 'owner', kind: 'render' as const, status: 'paused' as const, stage: 'render' as const, completed: 1, total: 2, startedAt: ready.createdAt, updatedAt: ready.updatedAt } };
    await f.storage.writeJsonAtomic('cache/galleries.json', { [g.id]: active });
    const recovered = new GalleryService({ storage: f.storage, jobs: { get: async () => null } });
    const interrupted = await recovered.get(g.id); assert.equal(interrupted.operation!.status, 'interrupted'); assert.deepEqual(interrupted.generated, ready.generated);
    await assert.rejects(recovered.resumeOperation(g.id, 'active', 'owner'), /中断|任务/);
    assert.ok((await recovered.image(g.id, 0, ready.generated!.id)).length);
  } finally { await f.cleanup(); }
});

test('manual background render uses the same pause gate and permits another gallery to render', async () => {
  const f = await fixture(); let release!: () => void;
  try {
    const g = await f.service.create('job'); const other = await f.service.create('job');
    const edited = await f.service.update(g.id, { ...g, images: [g.images[0]!, g.images[0]!] });
    let entered!: () => void; const start = new Promise<void>(r => { entered = r; }); const gate = new Promise<void>(r => { release = r; }); let first = true;
    f.hook(async () => { if (first) { first = false; entered(); await gate; } });
    const op = await f.service.startOperation(g.id, { version: edited.version, kind: 'render' });
    await start; await f.service.pauseOperation(g.id, op.operation!.id); release();
    await until(async () => (await f.service.get(g.id)).operation!.status === 'paused');
    await f.service.render(other.id, other.version);
    await f.service.resumeOperation(g.id, op.operation!.id); await until(async () => (await f.service.get(g.id)).operation!.status === 'completed');
    assert.equal(f.counts().renders, 3);
  } finally { release?.(); f.hook(); await f.cleanup(); }
});

test('source changed during pause fails before continuing OCR and allows a new content plan', async () => {
  const f = await fixture(); let release!: () => void;
  try {
    const g = await f.service.create('job'); const c = await f.service.prepareContent(g.id, { version: g.version });
    const confirmed = await f.service.updateContent(g.id, { version: c.version, contentPlanId: c.contentPlan!.id, selectedIds: c.contentPlan!.items.map(i => i.id) });
    let entered!: () => void; const start = new Promise<void>(r => { entered = r; }); const gate = new Promise<void>(r => { release = r; }); let first = true;
    f.hook(async () => { if (first) { first = false; entered(); await gate; } });
    const op = await f.service.startOperation(g.id, { version: confirmed.version, kind: 'candidates', contentPlanId: confirmed.contentPlan!.id, contentConfirmed: true });
    await start; await f.service.pauseOperation(g.id, op.operation!.id); release();
    await until(async () => (await f.service.get(g.id)).operation!.status === 'paused');
    const before = f.counts(); await writeFile(f.storage.resolve('raw/videos/job.mp4'), 'replacement');
    await f.service.resumeOperation(g.id, op.operation!.id);
    await until(async () => (await f.service.get(g.id)).operation!.status === 'failed');
    const failed = await f.service.get(g.id); assert.match(failed.operation!.error!, /来源|转录/); assert.deepEqual(f.counts(), before);
    await f.service.prepareContent(g.id, { version: failed.version });
  } finally { release?.(); f.hook(); await f.cleanup(); }
});

test('legacy cached automatic plans above 35 cannot use either render entry point', async () => {
  const f = await fixture();
  try {
    const g = await f.service.create('job'); const p = await f.service.plan(g.id, { version: g.version });
    const oversized = { ...p, images: Array.from({ length: 36 }, () => p.plan!.images[0]!.image), plan: { ...p.plan!, images: Array.from({ length: 36 }, () => p.plan!.images[0]!), previewHashes: Array.from({ length: 36 }, () => p.plan!.previewHashes![0]!) }, appliedPlanId: p.plan!.id };
    await f.storage.writeJsonAtomic('cache/galleries.json', { [g.id]: oversized });
    const fresh = new GalleryService({ storage: f.storage, jobs: { get: async () => ({ id: 'job', videoPath: f.storage.resolve('raw/videos/job.mp4') } as JobRecord) } });
    await assert.rejects(fresh.renderPlan(g.id, { version: p.version, planId: p.plan!.id, subtitlesConfirmed: true }), /35/);
    await assert.rejects(fresh.render(g.id, p.version), /35/);
    assert.equal((await fresh.get(g.id)).plan!.images.length, 36);
  } finally { await f.cleanup(); }
});

test('completion racing a pause request cannot turn a completed operation back into pausing', async () => {
  const f = await fixture(); let release!: () => void;
  try {
    const g = await f.service.create('job');
    let entered!: () => void; const enteredRender = new Promise<void>(r => { entered = r; }); const gate = new Promise<void>(r => { release = r; });
    f.hook(async () => { entered(); await gate; });
    const op = await f.service.startOperation(g.id, { version: g.version, kind: 'render' }); await enteredRender;
    // Hold the request after its read so completion wins before the serial state transition.
    const service = f.service as unknown as { controlOperation: (...args: [string, string, string?]) => Promise<any> };
    const original = service.controlOperation.bind(f.service);
    service.controlOperation = async (...args) => {
      const read = await original(...args); release();
      await until(async () => (await f.service.get(g.id)).operation!.status === 'completed');
      return read;
    };
    await assert.rejects(f.service.pauseOperation(g.id, op.operation!.id), /结束|状态/);
    assert.equal((await f.service.get(g.id)).operation!.status, 'completed');
  } finally { release?.(); f.hook(); await f.cleanup(); }
});

test('manual rendering refuses source replacement during pause before another image call', async () => {
  const f = await fixture(); let release!: () => void;
  try {
    const g = await f.service.create('job'); const saved = await f.service.update(g.id, { ...g, images: [g.images[0]!, g.images[0]!] });
    let entered!: () => void; const start = new Promise<void>(r => { entered = r; }); const gate = new Promise<void>(r => { release = r; }); let first = true;
    f.hook(async () => { if (first) { first = false; entered(); await gate; } });
    const op = await f.service.startOperation(g.id, { version: saved.version, kind: 'render' }); await start;
    await f.service.pauseOperation(g.id, op.operation!.id); release();
    await until(async () => (await f.service.get(g.id)).operation!.status === 'paused');
    await writeFile(f.storage.resolve('raw/videos/job.mp4'), 'replacement');
    await f.service.resumeOperation(g.id, op.operation!.id);
    await until(async () => (await f.service.get(g.id)).operation!.status === 'failed');
    assert.equal(f.counts().renders, 1); assert.match((await f.service.get(g.id)).operation!.error!, /来源|原视频/);
  } finally { release?.(); f.hook(); await f.cleanup(); }
});


test('selected native windows retain full overlapping ASR context for caption boundary matching', async () => {
  const f = await fixture(2);
  try {
    const original = '在整理长视频内容时我们先核对完整转录与字幕时间然后选择需要保留的原句并继续检查每一张候选图片中的像素文字是否清楚最后确认生成整套图集以便后续人工准备发布材料。';
    await f.storage.writeJsonAtomic('raw/transcripts/job.json', { segments: [{ start: 0, end: 3, text: original }], transcript: original, duration: 4 });
    const g = await f.service.create('job'); const c = await f.service.prepareContent(g.id, { version: g.version });
    assert.ok(c.contentPlan!.items.length > 1);
    const first = c.contentPlan!.items[0]!;
    const selected = await f.service.updateContent(g.id, { version: c.version, contentPlanId: c.contentPlan!.id, selectedIds: [first.id] });
    await f.service.startOperation(g.id, { version: selected.version, kind: 'candidates', contentPlanId: selected.contentPlan!.id, contentConfirmed: true });
    await until(async () => (await f.service.get(g.id)).operation!.status === 'completed');
    assert.equal(f.contexts.length, 1); assert.equal(f.contexts[0]!.start, first.start); assert.equal(f.contexts[0]!.end, first.end);
    assert.equal(f.contexts[0]!.text, original);
  } finally { await f.cleanup(); }
});


test('restart continues completed OCR and candidate images only after explicit resume', async () => {
  const f = await fixture(16); let release!: () => void;
  try {
    const g = await f.service.create('job');
    const c = await f.service.prepareContent(g.id, { version: g.version });
    const confirmed = await f.service.updateContent(g.id, { version: c.version, contentPlanId: c.contentPlan!.id, selectedIds: c.contentPlan!.items.map(i => i.id) });
    let entered!: () => void; const first = new Promise<void>(r => { entered = r; });
    const gate = new Promise<void>(r => { release = r; });
    f.hook(async () => { if (f.counts().renders === 1) { entered(); await gate; } });
    const op = await f.service.startOperation(g.id, { kind: 'candidates', version: confirmed.version, contentPlanId: confirmed.contentPlan!.id, contentConfirmed: true }, 'owner');
    await first; await f.service.pauseOperation(g.id, op.operation!.id, 'owner'); release();
    await until(async () => (await f.service.get(g.id)).operation!.status === 'paused'); f.hook();
    const recovered = f.restart(); const interrupted = await recovered.get(g.id);
    assert.equal(interrupted.operation!.status, 'interrupted');
    assert.deepEqual(f.counts(), { renders: 1, ocr: 16 });
    await assert.rejects(recovered.resumeOperation(g.id, op.operation!.id, 'other'), /操作者/);
    await recovered.resumeOperation(g.id, op.operation!.id, 'owner');
    await until(async () => ['completed', 'failed'].includes((await recovered.get(g.id)).operation!.status));
    const done = await recovered.get(g.id);
    assert.equal(done.operation!.status, 'completed', done.operation!.error);
    assert.deepEqual(f.counts(), { renders: done.plan!.images.length, ocr: 16 });
    assert.equal(done.status, 'draft'); // Candidate recovery never implies final confirmation.
  } finally { release?.(); f.hook(); await f.cleanup(); }
});

test('recovered manual render reuses verified first image and preserves old product on cache corruption', async () => {
  for (const corrupt of [false, true]) {
    const f = await fixture(4); let release!: () => void;
    try {
      const g = await f.service.create('job'); const old = await f.service.render(g.id, g.version);
      const draft = await f.service.update(g.id, { ...old, images: [old.images[0]!, old.images[0]!] });
      let entered!: () => void; const start = new Promise<void>(r => { entered = r; }); const gate = new Promise<void>(r => { release = r; }); let first = true;
      f.hook(async () => { if (first) { first = false; entered(); await gate; } });
      const op = await f.service.startOperation(g.id, { version: draft.version, kind: 'render' }); await start;
      await f.service.pauseOperation(g.id, op.operation!.id); release();
      await until(async () => (await f.service.get(g.id)).operation!.status === 'paused'); f.hook();
      if (corrupt) {
        const { readdir } = await import('node:fs/promises');
        const dir = f.storage.resolve(`output/galleries/${g.id}/operation-${op.operation!.id}`);
        const file = (await readdir(dir)).find(file => file.endsWith('.png'))!; await writeFile(path.join(dir, file), 'tampered');
      }
      const recovered = f.restart(); await recovered.get(g.id); await recovered.resumeOperation(g.id, op.operation!.id);
      await until(async () => ['completed', 'failed'].includes((await recovered.get(g.id)).operation!.status));
      const done = await recovered.get(g.id);
      assert.equal(done.operation!.status, corrupt ? 'failed' : 'completed', done.operation!.error);
      assert.equal(f.counts().renders, corrupt ? 2 : 3);
      if (corrupt) {
        assert.deepEqual(done.generated, old.generated);
        assert.ok((await recovered.image(g.id, 0, old.generated!.id)).length);
        assert.match(done.operation!.error!, /损坏/);
      }
    } finally { release?.(); f.hook(); await f.cleanup(); }
  }
});

test('interrupted candidates reject changed source, transcript, or confirmation version without work', async () => {
  for (const changed of ['source', 'transcript', 'version', 'confirmation']) {
    const f = await fixture(4); let release!: () => void;
    try {
      const g = await f.service.create('job'); const c = await f.service.prepareContent(g.id, { version: g.version });
      const confirmed = await f.service.updateContent(g.id, { version: c.version, contentPlanId: c.contentPlan!.id, selectedIds: c.contentPlan!.items.map(i => i.id) });
      let entered!: () => void; const start = new Promise<void>(r => { entered = r; }); const gate = new Promise<void>(r => { release = r; }); let first = true;
      f.hook(async () => { if (first) { first = false; entered(); await gate; } });
      const op = await f.service.startOperation(g.id, { version: confirmed.version, kind: 'candidates', contentPlanId: confirmed.contentPlan!.id, contentConfirmed: true });
      await start; await f.service.pauseOperation(g.id, op.operation!.id); release();
      await until(async () => (await f.service.get(g.id)).operation!.status === 'paused'); f.hook();
      if (changed === 'source') await writeFile(f.storage.resolve('raw/videos/job.mp4'), 'new source');
      if (changed === 'transcript') await f.storage.writeJsonAtomic('raw/transcripts/job.json', { segments: [{ text: '新转录。', start: 0, end: 1 }] });
      const recovered = f.restart(); const interrupted = await recovered.get(g.id);
      if (changed === 'version') await recovered.update(g.id, { ...interrupted, title: 'edited after restart' });
      if (changed === 'confirmation') {
        const records = await f.storage.readJson<Record<string, any>>('cache/galleries.json');
        records[g.id].contentPlan.confirmedAt = undefined;
        await f.storage.writeJsonAtomic('cache/galleries.json', records);
      }
      const checker = changed === 'confirmation' ? f.restart() : recovered;
      const before = f.counts();
      await assert.rejects(checker.resumeOperation(g.id, op.operation!.id), /来源|转录|版本|确认/);
      assert.deepEqual(f.counts(), before);
    } finally { release?.(); f.hook(); await f.cleanup(); }
  }
});

test('operation cache preserves optional undefined values without reevaluating them', async () => {
  const f = await fixture();
  try {
    const g = await f.service.create('job');
    const cache = f.service as unknown as { operationUnit<T>(id: string, operation: string, key: string, work: () => Promise<T>): Promise<T> };
    let calls = 0;
    for (let i = 0; i < 2; i++) assert.equal(await cache.operationUnit(g.id, 'operation', 'optional-result', async () => { calls++; return undefined; }), undefined);
    assert.equal(calls, 1);
  } finally { await f.cleanup(); }
});

test('native OCR gets only bounded adjacent context while sampling remains in the selected current window', async () => {
  const f = await fixture(16);
  try {
    const segments = [
      { start: 0, end: 2, text: '远处无关文字' },
      { start: 14.4, end: 17.16, text: '你会感觉自己的思考缺乏深度' },
      { start: 17.16, end: 19.64, text: '很难举一反三' },
      { start: 19.64, end: 22.4, text: '花很多时间阅读和做笔记整理' },
    ];
    await f.storage.writeJsonAtomic('raw/transcripts/job.json', { segments });
    const g = await f.service.create('job'); const c = await f.service.prepareContent(g.id, { version: g.version });
    const item = c.contentPlan!.items.find(item => item.text === '很难举一反三')!;
    const confirmed = await f.service.updateContent(g.id, { version: c.version, contentPlanId: c.contentPlan!.id, selectedIds: [item.id] });
    await f.service.startOperation(g.id, { version: confirmed.version, kind: 'candidates', contentPlanId: confirmed.contentPlan!.id, contentConfirmed: true });
    await until(async () => ['completed', 'failed'].includes((await f.service.get(g.id)).operation!.status));
    assert.equal(f.contexts.length, 1);
    const quote = f.contexts[0]!;
    assert.equal(quote.start, 17.16); assert.equal(quote.end, 19.64);
    assert.equal(quote.targetText, '很难举一反三'); assert.equal(quote.text, '很难举一反三');
    assert.equal(quote.adjacentText, segments.slice(1).map(s => s.text).join(''));
  } finally { await f.cleanup(); }
});

test('starting over removes abandoned operation cache only after saving the replacement', async () => {
  const f = await fixture();
  try {
    const g = await f.service.create('job'); const ready = await f.service.render(g.id, g.version);
    const operation = { id: 'abandoned', kind: 'render', status: 'paused', stage: 'render', completed: 0, total: 1, startedAt: '', updatedAt: '' };
    await f.storage.writeJsonAtomic('cache/galleries.json', { [g.id]: { ...ready, operation } });
    await f.storage.writeJsonAtomic(`output/galleries/${g.id}/operation-abandoned/unit.json`, { value: 'cached' });
    const recovered = f.restart(); const interrupted = await recovered.get(g.id);
    await recovered.startOperation(g.id, { version: interrupted.version, kind: 'render' });
    await assert.rejects(f.storage.readJson(`output/galleries/${g.id}/operation-abandoned/unit.json`), { code: 'ENOENT' });
    await until(async () => (await recovered.get(g.id)).operation!.status === 'completed');
  } finally { await f.cleanup(); }
});
