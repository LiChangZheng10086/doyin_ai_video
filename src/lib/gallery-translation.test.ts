import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GalleryTranslator, planTranslatedGallery, validateGalleryTranslationCues } from './gallery-translation.js';
import type { GalleryTranslationCue } from './gallery-types.js';

const config = { apiKey: 'test-key', model: 'test', provider: 'openai' as const };
const cue = (segmentIndex: number, text = ''): GalleryTranslationCue => ({ segmentIndex, original: `Source ${segmentIndex}`, text, start: segmentIndex, end: segmentIndex + 1 });
const translation = (cues: GalleryTranslationCue[]) => ({ transcriptHash: 'transcript', sourceFingerprint: 'source', start: 0, end: cues.length, cues });

test('custom translation targets retain all cues and reduce crowded pages without raising small targets', () => {
  for (const [target, count, sizes] of [[1, 3, [1, 1, 1]], [4, 10, [4, 3, 3]], [12, 20, [9, 9, 2]]] as const) {
    const cues = Array.from({ length: count }, (_, i) => cue(i, `完整中文第${i}句。`));
    const plan = planTranslatedGallery(translation(cues), target, 30);
    assert.deepEqual(plan.images.map(i => i.quotes.length), sizes);
    assert.deepEqual(plan.images.flatMap(i => i.quotes.map(q => q.segmentIndex)), cues.map(c => c.segmentIndex));
  }
  for (const target of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => planTranslatedGallery(translation([cue(0, '有效中文。')]), target, 30), /条数/);
  }
});

test('translation covers all batches in source order and preserves originals and exact timings', async () => {
  const input = Array.from({ length: 25 }, (_, i) => cue(i));
  const before = structuredClone(input);
  const requests: any[] = [];
  const writer = new GalleryTranslator({ resolveAiConfig: async () => ({ ...config, provider: 'deepseek', maxOutputTokens: 2000 }), createClient: () => ({ chat: { completions: { create: async (request: any) => {
    requests.push(request);
    const source = JSON.parse(request.messages[1].content).cues;
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ cues: source.toReversed().map((c: any) => ({ segmentIndex: c.segmentIndex, text: '這是完整譯文。', original: 'tampered', start: 100 })) }) } }] };
  } } } }) });
  const result = await writer.translate(input);
  assert.deepEqual(input, before);
  assert.deepEqual(result, before.map(c => ({ ...c, text: '这是完整译文。' })));
  assert.ok(requests.length > 1, 'long input is batched rather than cut');
  assert.deepEqual(requests[0].thinking, { type: 'disabled' });
  assert.equal(requests[0].max_tokens, 2000);
});

test('missing, duplicate, unexpected, empty and truncated translation responses never produce a partial result', async () => {
  for (const variant of ['missing', 'duplicate', 'unexpected', 'empty', 'length', 'long', 'english']) {
    let attempts = 0;
    const writer = new GalleryTranslator({ resolveAiConfig: async () => config, createClient: () => ({ chat: { completions: { create: async () => {
      attempts++;
      const good = [{ segmentIndex: 0, text: '完整译文。' }, { segmentIndex: 1, text: '完整译文。' }];
      const cues = variant === 'missing' ? good.slice(0, 1) : variant === 'duplicate' ? [good[0], good[0]] : variant === 'unexpected' ? [good[0], { ...good[1], segmentIndex: 7 }] : variant === 'empty' ? [{ ...good[0], text: ' ' }, good[1]] : variant === 'long' ? [{ ...good[0], text: '长'.repeat(241) }, good[1]] : variant === 'english' ? [{ ...good[0], text: 'Untranslated text' }, good[1]] : good;
      return { choices: [{ finish_reason: variant === 'length' ? 'length' : 'stop', message: { content: JSON.stringify({ cues }) } }] };
    } } } }) });
    await assert.rejects(writer.translate([cue(0), cue(1)]), /翻译/);
    assert.equal(attempts, 3);
  }
});

test('translation retries a failed batch and refuses huge individual source cues without dropping text', async () => {
  let attempts = 0;
  const writer = new GalleryTranslator({ resolveAiConfig: async () => config, createClient: () => ({ chat: { completions: { create: async () => {
    attempts++; return { choices: [{ finish_reason: attempts === 1 ? 'length' : 'stop', message: { content: JSON.stringify({ cues: [{ segmentIndex: 0, text: '完整中文。' }] }) } }] };
  } } } }) });
  assert.equal((await writer.translate([cue(0)]))[0].text, '完整中文。');
  assert.equal(attempts, 2);
  await assert.rejects(writer.translate([{ ...cue(0), original: 'x'.repeat(5001) }]), /过长|范围/);
  await assert.rejects(new GalleryTranslator({ resolveAiConfig: async () => null }).translate([cue(0)]), /配置/);
});

test('translated plans balance short captions, retain every original, and reduce counts for long readable captions', () => {
  const short = Array.from({ length: 17 }, (_, i) => cue(i, '这一条是完整中文。'));
  const plan = planTranslatedGallery(translation(short), 8, 30);
  assert.equal(plan.mode, 'translated');
  assert.deepEqual(plan.images.map(i => i.quotes.length), [9, 8]);
  assert.deepEqual(plan.images.flatMap(i => i.quotes.map(q => q.originalText)), short.map(c => c.original));
  assert.ok(plan.images.every(i => i.quotes.every(q => q.verification === 'translation')));
  assert.deepEqual(plan.images.flatMap(i => i.image.translatedCaptions!), short.map(c => c.text));
  assert.deepEqual(plan.images.flatMap(i => i.image.times), short.map(c => c.start + .5));
  const long = Array.from({ length: 9 }, (_, i) => cue(i, '中文'.repeat(100)));
  const longPlan = planTranslatedGallery(translation(long), 8, 30);
  assert.ok(longPlan.images.length > 1);
  assert.ok(longPlan.images.every(i => i.quotes.length < 6));
  assert.equal(longPlan.images.flatMap(i => i.quotes).length, 9);
  const complete = Array.from({ length: 534 }, (_, i) => cue(i, `完整内容第${i}条。`));
  const fullPlan = planTranslatedGallery(translation(complete), 8, 534);
  assert.ok(fullPlan.images.length > 35);
  assert.deepEqual(fullPlan.images.flatMap(i => i.quotes.map(q => q.segmentIndex)), complete.map(c => c.segmentIndex));
});

test('invalid or unsaved translated cues cannot be planned', () => {
  for (const cues of [[], [cue(0)], [cue(0, '中文'), cue(0, '重复')], [{ ...cue(0, '中文'), start: -1 }], [{ ...cue(0, '中文'), end: 31 }], [cue(0, '长'.repeat(241))]]) {
    assert.throws(() => validateGalleryTranslationCues(cues, true, 30));
  }
  assert.throws(() => planTranslatedGallery(translation([cue(0, '中文')]), 0, 30));
});

test('a submillisecond source produces a valid nonnegative frame timestamp', () => {
  const plan = planTranslatedGallery({ transcriptHash: 't', sourceFingerprint: 's', start: 0, end: .0001, cues: [{ ...cue(0, '中文'), end: .0001 }] }, 8, .0001);
  assert.deepEqual(plan.images[0].image.times, [.00005]);
});
