import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TranscriptAsset } from '../types.js';

const transcript = (texts: string[]): TranscriptAsset => ({ segments: texts.map((text, i) => ({ text, start: i * 2, end: i * 2 + 1.8 })), transcript: texts.join(''), text: texts.join('') } as TranscriptAsset);
const source = { width: 320, height: 480, duration: 100 };
const candidate = async (quote: { start: number; end: number }) => ({ time: (quote.start + quote.end) / 2, bandTop: .82, bandBottom: .85 });

test('a proposal missing most source windows is not offered as a normal generation plan', async () => {
  const { planGallery } = await import('./gallery-planner.js');
  const asset = transcript(Array.from({ length: 16 }, (_, i) => `不同原句${i}。`));
  const plan = await planGallery(asset, source, q => q.segmentIndex < 2 ? candidate(q) : Promise.resolve(null));
  assert.match(plan.blockedReason!, /不足|过低|大部分/);
  assert.equal(plan.excluded.length, 14);
});

test('one ASR window can supply multiple native captions and fills the requested seven rows', async () => {
  const { planGallery } = await import('./gallery-planner.js');
  const asset = transcript(['完整的上下文用于核对，不能只保留其中一帧。', '暂时没有可读字幕。', '后续内容继续按原顺序组织。']);
  const plan = await planGallery(asset, source, async q => q.segmentIndex === 1 ? [] : Array.from({ length: 7 }, (_, i) => ({
    time: q.start + .1 + i * .2, bandTop: .82, bandBottom: .85, recognizedText: `画面${q.segmentIndex}字幕${i}`, verification: 'ocr' as const,
  })), { targetLines: 7 });
  assert.deepEqual(plan.images.map(i => i.quotes.length), [7, 7]);
  assert.equal(plan.excluded.length, 1);
  assert.equal(plan.images[0]!.quotes[0]!.text, '画面0字幕0');
  assert.ok(plan.images.every(i => i.image.filmstrip));
});

test('caption groups do not become one image per missed context and balance a small final tail', async () => {
  const { planGallery } = await import('./gallery-planner.js');
  const asset = transcript(Array.from({ length: 17 }, (_, i) => `原句第${i}条。`));
  const plan = await planGallery(asset, source, async q => q.segmentIndex === 8 ? null : candidate(q), { targetLines: 7 });
  assert.deepEqual(plan.images.map(i => i.quotes.length), [8, 8]);
  assert.equal(plan.images.flatMap(i => i.quotes).length, 16);
});

test('a seven-row target balances 29 captions within the six-to-nine range', async () => {
  const { planGallery } = await import('./gallery-planner.js');
  const plan = await planGallery(transcript(Array.from({ length: 29 }, (_, i) => `不同台词${i}。`)), source, candidate, { targetLines: 7 });
  assert.deepEqual(plan.images.map(i => i.quotes.length), [8, 7, 7, 7]);
});

test('planner covers 32 complete sentences in four chronological groups without inventing text', async () => {
  const { planGallery } = await import('./gallery-planner.js');
  const texts = Array.from({ length: 32 }, (_, i) => `原句第${i + 1}条。`);
  const plan = await planGallery(transcript(texts), source, candidate);
  assert.equal(plan.images.length, 4);
  assert.deepEqual(plan.images.map(i => i.quotes.length), [8, 8, 8, 8]);
  assert.equal(plan.images.flatMap(i => i.quotes).map(q => q.text).join(''), texts.join(''));
  assert.ok(plan.warnings.some(w => /误选/.test(w)));
});

test('planner joins ASR half-sentences and splits long text preserving all text and valid times', async () => {
  const { planGallery } = await import('./gallery-planner.js');
  const asset = transcript(['这是前半', '句子结束。另一句。', Array.from({ length: 30 }, (_, i) => `第${i}段不同的长句文字`).join('') + '。']);
  const plan = await planGallery(asset, source, candidate);
  const quotes = plan.images.flatMap(i => i.quotes);
  assert.equal(quotes.map(q => q.text).join(''), asset.transcript);
  assert.ok(quotes.every(q => q.text.length <= 36 && q.start < q.end));
  assert.ok(quotes[0]!.text.includes('句子结束'));
});

test('planner excludes blank candidates, blocks corrupt input and preserves nine-line groups', async () => {
  const { planGallery } = await import('./gallery-planner.js');
  const asset = transcript(Array.from({ length: 9 }, (_, i) => `第${i}句。`));
  assert.equal((await planGallery(asset, source, candidate, { targetLines: 9 })).images[0]!.quotes.length, 9);
  const blank = await planGallery(asset, source, async () => null);
  assert.equal(blank.images.length, 0);
  assert.equal(blank.excluded.length, 9);
  await assert.rejects(planGallery({ ...asset, segments: [{ start: 5, end: 1, text: '异常' }] }, source, candidate), /转录/);
});

test('large subtitle bands split images for readability and valid word timestamps refine sentence bounds', async () => {
  const { planGallery } = await import('./gallery-planner.js');
  const asset = transcript(Array.from({ length: 16 }, (_, i) => `不同台词${i}。`));
  const plan = await planGallery(asset, source, async q => ({ time: q.start + .2, bandTop: .8, bandBottom: .88 }));
  assert.ok(plan.images.every(i => i.quotes.length <= 6));
  assert.equal(plan.images.flatMap(i => i.quotes).length, 16);
  const words = { ...transcript(['甲句。乙句。']), words: [{ word: '甲句。', start: .1, end: .4 }, { word: '乙句。', start: .9, end: 1.3 }] };
  const result = await planGallery(words, source, candidate);
  assert.deepEqual(result.images[0]!.quotes.map(q => [q.start, q.end]), [[.1, .4], [.9, 1.3]]);
});

test('compact row padding is included when checking whether eight captions fit', async () => {
  const { planGallery } = await import('./gallery-planner.js');
  const asset = transcript(Array.from({ length: 16 }, (_, i) => `不同台词${i}。`));
  const plan = await planGallery(asset, { width: 1080, height: 1000, duration: 100 }, async q => ({ time: q.start + .2, bandTop: .8, bandBottom: .9 }));
  assert.ok(plan.images.every(i => i.quotes.length <= 7));
  assert.equal(plan.images.flatMap(i => i.quotes).length, 16);
});

test('tail tolerance clamps the whole interval before interpolation without losing long sentence text', async () => {
  const { planGallery } = await import('./gallery-planner.js');
  const text = '尾段台词仍需完整保留，不能因为转录略超过媒体时长而把后半句传成倒序时间。即使需要拆分为多个定位片段，所有原文字也必须按顺序覆盖并且每段都可读取。';
  const asset = { segments: [{ start: 9.9, end: 10.3, text }], transcript: text, text } as TranscriptAsset;
  const calls: { start: number; end: number }[] = [];
  const plan = await planGallery(asset, { ...source, duration: 10 }, async q => {
    calls.push({ start: q.start, end: q.end });
    assert.ok(q.start < q.end && q.end < 10, `candidate interval ${q.start}..${q.end} must be readable`);
    return candidate(q);
  });
  assert.ok(calls.length >= 2);
  assert.equal(plan.images.flatMap(i => i.quotes).map(q => q.text).join(''), text);
  assert.equal(calls[0]!.start, 9.9);
  assert.equal(calls.at(-1)!.end, 9.999);
});

test('unreadable submillisecond tail is explicitly excluded instead of sending an inverted candidate interval', async () => {
  const { planGallery } = await import('./gallery-planner.js');
  const text = '位于最后不足一毫秒的尾段。';
  const asset = { segments: [{ start: 9.9998, end: 10.2, text }], transcript: text, text } as TranscriptAsset;
  let calls = 0;
  const plan = await planGallery(asset, { ...source, duration: 10 }, async q => { calls++; return candidate(q); });
  assert.equal(calls, 0);
  assert.equal(plan.images.length, 0);
  assert.equal(plan.excluded[0]!.segmentIndex, 0);
  assert.match(plan.excluded[0]!.reason, /尾段|读取/);
});


test('unpunctuated changing ASR segments do not merge into ten-second candidate windows', async () => {
  const { planGallery } = await import('./gallery-planner.js');
  const asset = transcript(['早期对白', '另一条对白', '接下来对白', '最后的对白']);
  const seen: { start: number; end: number }[] = [];
  const plan = await planGallery(asset, source, async q => { seen.push(q); return candidate(q); });
  assert.ok(seen.every(q => q.end - q.start <= 4));
  assert.equal(plan.images.flatMap(i => i.quotes).map(q => q.text).join(''), asset.transcript);
});
