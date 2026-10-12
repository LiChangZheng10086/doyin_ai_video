import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { GalleryService } from './galleries.js';
import { LocalStorage } from './storage.js';
import type { JobRecord } from '../types.js';

test('full translation and saved drafts remain complete while automatic generation above 35 images is intercepted', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gallery-full-video-'));
  try {
    const storage = new LocalStorage(root); await storage.ensureBaseDirs();
    const videoPath = storage.resolve('raw/videos/job.mp4'); await writeFile(videoPath, 'safevideo');
    const segments = Array.from({ length: 400 }, (_, i) => ({ start: i, end: i + 1, text: `Source sentence ${i}.` }));
    await storage.writeJsonAtomic('raw/transcripts/job.json', { segments, transcript: segments.map(s => s.text).join('\n'), duration: 400 });
    const service = new GalleryService({ storage, jobs: { get: async () => ({ id: 'job', videoPath, sourceUrl: 'https://www.youtube.com/watch?v=test' } as JobRecord) },
      translator: { translate: async cues => cues.map(c => ({ ...c, text: `完整中文第${c.segmentIndex}条。` })) },
      media: { probe: async () => ({ width: 320, height: 480, duration: 400 }), frame: async () => Buffer.from('frame'),
        render: async (_v, image, out) => { await writeFile(out, JSON.stringify(image)); } } });
    const draft = await service.create('job');
    const partial = await service.translate(draft.id, { version: draft.version, start: 0, end: 120 });
    await assert.rejects(service.plan(draft.id, { version: partial.version }), /完整视频|全文/);
    const selected = await service.plan(draft.id, { version: partial.version, fullVideo: false });
    assert.equal(selected.plan?.scope, 'range');
    await assert.rejects(service.prepareContent(draft.id, { version: selected.version }), /全文/);
    await assert.rejects(service.prepareContent(draft.id, { version: selected.version, fullVideo: 'false' as any }), /范围/);
    const rangeContent = await service.prepareContent(draft.id, { version: selected.version, fullVideo: false });
    assert.equal(rangeContent.contentPlan!.items.length, 120);
    const rangeConfirmed = await service.updateContent(draft.id, { version: rangeContent.version, contentPlanId: rangeContent.contentPlan!.id, selectedIds: rangeContent.contentPlan!.items.map(item => item.id) });
    const rangePlan = await service.plan(draft.id, { version: rangeConfirmed.version, contentPlanId: rangeConfirmed.contentPlan!.id, contentConfirmed: true, fullVideo: false });
    assert.equal(rangePlan.plan!.scope, 'range'); assert.equal(rangePlan.plan!.images.flatMap(image => image.quotes).length, 120);
    const full = await service.translate(draft.id, { version: rangePlan.version, start: 0, end: 400 });
    assert.equal(full.translation?.cues.length, 400);
    await assert.rejects(service.plan(draft.id, { version: full.version, targetLines: 10 }), /35/);
    const content = await service.prepareContent(draft.id, { version: full.version, targetLines: 8 });
    assert.equal(content.contentPlan!.items.length, 400);
    assert.equal(content.translation!.cues.length, 400);
    assert.equal(content.contentPlan!.estimatedImages, 50);
    // Saving a manual draft retains its full input regardless of the automatic processing limit.
    const native = await service.create('job', 'native');
    const saved = await service.update(native.id, { ...native, images: Array.from({ length: 50 }, () => native.images[0]!) });
    assert.equal(saved.images.length, 50);
    assert.equal((await storage.readJson<any>('raw/transcripts/job.json')).segments.length, 400);
  } finally { await rm(root, { recursive: true, force: true }); }
});
