import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TranscriptAsset } from '../types.js';
import type { GalleryContentItem, GalleryTranslation } from './gallery-types.js';

const source = { width: 320, height: 480, duration: 2000 };
const transcript = (count: number): TranscriptAsset => ({ segments: Array.from({ length: count }, (_, i) => ({ text: `完整原句第${i}条。`, start: i * 2, end: i * 2 + 1.8 })) } as TranscriptAsset);
const config = { apiKey: 'test', model: 'test', provider: 'deepseek' as const, maxOutputTokens: 1900 };
const items = (count: number): GalleryContentItem[] => Array.from({ length: count }, (_, i) => ({ id: `q-${i}`, selected: true, reason: '', segmentIndex: i, text: `原句${i}。`, start: i * 2, end: i * 2 + 1 }));
const response = (value: unknown, finish_reason = 'stop') => ({ choices: [{ finish_reason, message: { content: JSON.stringify(value) } }] });

test('translated estimates and image plans share short-caption groups while editable content retains every cue', async () => {
  const { galleryContentItems, estimateGalleryContent } = await import('./gallery-content.js');
  const { planTranslatedGallery } = await import('./gallery-translation.js');
  const cues = Array.from({ length: 30 }, (_, i) => ({ segmentIndex: i, original: `Source ${i}`, text: ['大家好', '今天聊一聊', '人生目标。'][i % 3]!, start: i, end: i + .9 }));
  const t: GalleryTranslation = { transcriptHash: 't', sourceFingerprint: 's', start: 0, end: 30, cues };
  const all = galleryContentItems(transcript(30), source, t);
  assert.equal(all.length, 30);
  assert.equal(estimateGalleryContent(all, 8, source, true), 2);
  const plan = planTranslatedGallery(t, 8, source.duration);
  assert.equal(plan.images.length, 2);
  assert.equal(plan.images.flatMap(image => image.quotes).length, 30);
  assert.equal(plan.images.flatMap(image => image.image.translatedCaptions!).length, 10);
});

test('content list retains complete native input and estimates the 35 image boundary without OCR', async () => {
  const { galleryContentItems, estimateGalleryContent } = await import('./gallery-content.js');
  const all = galleryContentItems(transcript(534), source);
  assert.equal(all.length, 534);
  assert.equal(new Set(all.map(item => item.id)).size, 534);
  assert.ok(all.every(item => item.selected && item.reason === ''));
  assert.equal(estimateGalleryContent(all.slice(0, 280), 8, source), 35);
  assert.equal(estimateGalleryContent(all.slice(0, 281), 8, source), 36);
  assert.equal(estimateGalleryContent(all.map(item => ({ ...item, selected: false })), 8, source), 0);
  assert.equal(estimateGalleryContent(items(29), 7, source), 4);
  assert.equal(estimateGalleryContent(items(20), 12, source), 2);
  assert.throws(() => estimateGalleryContent(all, 0, source), /条数/);
});

test('native split preserves word bounds and unreadable tail remains visible for review', async () => {
  const { galleryContentItems } = await import('./gallery-content.js');
  const input = { segments: [{ start: 0, end: 2, text: '甲句。乙句。' }], words: [{ word: '甲句。', start: .1, end: .4 }, { word: '乙句。', start: .9, end: 1.3 }] } as TranscriptAsset;
  assert.deepEqual(galleryContentItems(input, source).map(item => [item.start, item.end]), [[.1, .4], [.9, 1.3]]);
  const tail = { segments: [{ start: 9.9998, end: 10.2, text: '最后原句。' }] } as TranscriptAsset;
  assert.equal(galleryContentItems(tail, { ...source, duration: 10 })[0]!.text, '最后原句。');
});

test('blank native chunks do not block AI or candidates and retain the meaningful text time offset', async () => {
  const { galleryContentItems, GalleryContentPlanner } = await import('./gallery-content.js');
  const { planGallery } = await import('./gallery-planner.js');
  for (const [prefix, text] of [['\n', '第一条。'], [' '.repeat(72), '第二条。']]) {
    const rawText = prefix! + text!;
    const input = { segments: [{ start: 0, end: 2, text: rawText }] } as TranscriptAsset;
    const all = galleryContentItems(input, source);
    assert.equal(all.length, 1);
    assert.equal(all[0]!.text, text);
    assert.equal(all[0]!.start, 2 * prefix!.length / rawText.length);
    assert.equal(all[0]!.end, 2);
    const planner = new GalleryContentPlanner({ resolveAiConfig: async () => config, createClient: () => ({ chat: { completions: { create: async () =>
      response({ items: all.map(item => ({ id: item.id, selected: true, reason: '' })) }) } } }) });
    assert.deepEqual(await planner.plan(all), all);
    for (const control of [{}, { quotes: all }]) {
      let calls = 0;
      const plan = await planGallery(input, source, async quote => { calls++; return { time: (quote.start + quote.end) / 2, bandTop: .82, bandBottom: .85 }; }, {}, control);
      assert.equal(calls, 1);
      assert.equal(plan.blockedReason, undefined);
      assert.equal(plan.images[0]!.quotes[0]!.text, text);
    }
  }
});

test('translated content retains cue original/time and estimation uses real readable layout', async () => {
  const { galleryContentItems, estimateGalleryContent } = await import('./gallery-content.js');
  const { planTranslatedGallery } = await import('./gallery-translation.js');
  const translation: GalleryTranslation = { transcriptHash: 't', sourceFingerprint: 's', start: 0, end: 40, cues: Array.from({ length: 20 }, (_, i) => ({ segmentIndex: i, original: `original ${i}`, text: `第${i}段中文译文` + '完整中文。'.repeat(20), start: i * 2, end: i * 2 + 1 })) };
  const all = galleryContentItems(transcript(20), source, translation);
  assert.deepEqual(all.map(({ segmentIndex, originalText, text, start, end }) => ({ segmentIndex, original: originalText, text, start, end })), translation.cues);
  assert.equal(estimateGalleryContent(all, 8, source, true), planTranslatedGallery(translation, 8, source.duration).images.length);
  assert.ok(estimateGalleryContent(all, 8, source, true) > 3);
});

test('AI selection updates selected/reason only and restores original order despite reordered response', async () => {
  const { GalleryContentPlanner } = await import('./gallery-content.js');
  const input = items(3); const original = structuredClone(input);
  const planner = new GalleryContentPlanner({ resolveAiConfig: async () => config, createClient: () => ({ chat: { completions: { create: async (request: any) => {
    assert.equal(request.max_tokens, 1900); assert.deepEqual(request.thinking, { type: 'disabled' });
    return response({ items: [...input].reverse().map((item, i) => ({ id: item.id, selected: i !== 1, reason: i === 1 ? '重复铺垫' : '', text: '模型改写', start: 999 })) });
  } } } }) });
  const result = await planner.plan(input);
  assert.deepEqual(input, original);
  assert.deepEqual(result, original.map((item, i) => ({ ...item, selected: i !== 1, reason: i === 1 ? '重复铺垫' : '' })));
});

test('unknown, duplicate, missing IDs, invalid selections and truncated responses are rejected after three attempts', async () => {
  const { GalleryContentPlanner } = await import('./gallery-content.js');
  const input = items(2); const valid = input.map(item => ({ id: item.id, selected: true, reason: '' }));
  for (const invalid of [[{ ...valid[0], id: 'unknown' }, valid[1]], [valid[0], valid[0]], [valid[0]], [{ ...valid[0], selected: 'yes' }, valid[1]], [{ ...valid[0], reason: 1 }, valid[1]], valid]) {
    let calls = 0;
    const planner = new GalleryContentPlanner({ resolveAiConfig: async () => config, createClient: () => ({ chat: { completions: { create: async () => { calls++; return response({ items: invalid }, invalid === valid ? 'length' : 'stop'); } } } }) });
    await assert.rejects(planner.plan(input), /整理.*失败/);
    assert.equal(calls, 3);
    assert.ok(input.every(item => item.selected && item.reason === ''));
  }
  await assert.rejects(new GalleryContentPlanner({ resolveAiConfig: async () => null }).plan(input), /配置/);
});

test('AI batches report completed units, pause before next request and continue without repeated batches', async () => {
  const { GalleryContentPlanner } = await import('./gallery-content.js');
  const input = items(65); let calls = 0; let checkpoints = 0;
  let reached!: () => void; const atPause = new Promise<void>(resolve => { reached = resolve; });
  let resume!: () => void; const paused = new Promise<void>(resolve => { resume = resolve; });
  const progress: number[][] = [];
  const planner = new GalleryContentPlanner({ resolveAiConfig: async () => config, createClient: () => ({ chat: { completions: { create: async (request: any) => {
    calls++; const batch = JSON.parse(request.messages.find((message: any) => message.role === 'user').content).items;
    assert.ok(batch.length <= 30);
    return response({ items: batch.map((item: any) => ({ id: item.id, selected: true, reason: '' })) });
  } } } }) });
  const run = planner.plan(input, { checkpoint: async () => { checkpoints++; if (calls === 1) { reached(); await paused; } }, progress: async (completed, total) => { progress.push([completed, total]); } });
  await atPause;
  assert.equal(calls, 1); assert.deepEqual(progress, [[30, 65]]);
  resume(); const result = await run;
  assert.equal(calls, 3); assert.ok(checkpoints >= 3);
  assert.deepEqual(progress, [[30, 65], [60, 65], [65, 65]]);
  assert.deepEqual(result, input);
});

test('completed AI batches can be restored by a fresh planner without a repeated model request', async () => {
  const { GalleryContentPlanner } = await import('./gallery-content.js');
  const input = items(65); let calls = 0; const saved = new Map<string, unknown>();
  const deps = { resolveAiConfig: async () => config, createClient: () => ({ chat: { completions: { create: async (request: any) => {
    calls++; const batch = JSON.parse(request.messages.find((m: any) => m.role === 'user').content).items;
    return response({ items: batch.map((item: any) => ({ id: item.id, selected: true, reason: '' })) });
  } } } }) };
  const unit = async <T>(key: string, work: () => Promise<T>): Promise<T> => {
    if (saved.has(key)) return saved.get(key) as T;
    const value = await work(); saved.set(key, value); return value;
  };
  await assert.rejects(new GalleryContentPlanner(deps).plan(input, { unit, checkpoint: async () => { if (calls === 1) throw new Error('process stopped'); } }), /process stopped/);
  assert.equal(calls, 1); assert.equal(saved.size, 1);
  assert.deepEqual(await new GalleryContentPlanner(deps).plan(input, { unit }), input);
  assert.equal(calls, 3);
});
