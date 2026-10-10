import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { GalleryService } from './galleries.js';
import { LocalStorage } from './storage.js';
import type { JobRecord } from '../types.js';

test('full-video translation, planning, rendering and saving retain more than 315 cues and 35 images', async () => {
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
    const full = await service.translate(draft.id, { version: selected.version, start: 0, end: 400 });
    assert.equal(full.translation?.cues.length, 400);
    const planned = await service.plan(draft.id, { version: full.version });
    assert.equal(planned.plan?.scope, 'full');
    assert.ok(planned.plan!.images.length > 35);
    assert.deepEqual(planned.plan!.images.flatMap(i => i.quotes.map(q => q.segmentIndex)), segments.map((_, i) => i));
    assert.equal((await service.inspectSource(draft.id)).imageLimit, undefined);
    const ready = await service.renderPlan(draft.id, { version: planned.version, planId: planned.plan!.id, subtitlesConfirmed: true });
    assert.equal(ready.generated?.hashes.length, planned.plan!.images.length);
    const saved = await service.update(draft.id, { ...ready, title: '完整内容' });
    assert.equal((await service.preview(draft.id, saved.version)).imageCount, planned.plan!.images.length);
  } finally { await rm(root, { recursive: true, force: true }); }
});
