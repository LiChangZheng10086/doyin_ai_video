import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { TranscriptProofreader } from './transcript-proofreader.js';
import type { TranscriptAsset } from '../types.js';

const config = { provider: 'deepseek' as const, apiKey: 'test-key', model: 'test-model' };
const asset = (): TranscriptAsset => ({ jobId: 'test', sourceUrl: 'local', audioPath: 'audio.wav',
  text: '前言\n章尾勾子要清楚。\n每章都要回销线索。\n结束', transcript: '前言\n章尾勾子要清楚。\n每章都要回销线索。\n结束',
  segments: [{ start: 0, end: 2, text: '章尾勾子要清楚。' }, { start: 2, end: 4, text: '每章都要回销线索。' }],
  words: [{ start: 0, end: 1, word: '勾子' }], duration: 4, model: 'ggml-small', provider: 'whisper.cpp', createdAt: 'now' });
function service(answer: (args: any, options?: any) => any) {
  return new TranscriptProofreader({ resolveAiConfig: async () => config, createClient: () => ({ chat: { completions: {
    async create(args: any, options?: any) { return answer(args, options); }
  } } }) });
}
const response = (corrections: unknown[], finish_reason = 'stop') => ({ choices: [{ finish_reason, message: { content: JSON.stringify({ corrections }) } }] });

test('AI corrections preserve full text, timing, provenance, originals and never reuse stale word timestamps', async () => {
  const input = asset();
  const result = await service(args => {
    assert.deepEqual(JSON.parse(args.messages[1].content).segments.map((s: any) => s.segmentIndex), [0, 1]);
    assert.deepEqual(args.thinking, { type: 'disabled' });
    return response([{ segmentIndex: 0, before: '勾子', after: '钩子' }, { segmentIndex: 1, before: '回销', after: '回收' }]);
  }).proofread(input);
  assert.equal(result.text, '前言\n章尾钩子要清楚。\n每章都要回收线索。\n结束');
  assert.equal(result.transcript, result.text);
  assert.deepEqual(result.segments.map(({ start, end }) => ({ start, end })), input.segments.map(({ start, end }) => ({ start, end })));
  assert.equal(result.provider, input.provider); assert.equal(result.model, input.model);
  assert.equal(result.words, undefined); assert.deepEqual(result.proofreading?.original?.words, input.words);
  assert.equal(result.proofreading?.status, 'succeeded'); assert.equal(result.proofreading?.changes.length, 2);
  assert.equal(result.proofreading?.original?.text, input.text); assert.equal(input.segments[0].text, '章尾勾子要清楚。');
});

test('long transcripts check every segment including the tail with adjacent context', async () => {
  const input = asset(); input.segments = Array.from({ length: 51 }, (_, i) => ({ start: i * 2, end: i * 2 + 2, text: `第${i}段需要核对。` }));
  input.duration = 102; input.text = input.transcript = input.segments.map(s => s.text).join('\n');
  const seen: number[] = []; let calls = 0;
  const result = await service(args => { const data = JSON.parse(args.messages[1].content); calls++;
    seen.push(...data.segments.map((s: any) => s.segmentIndex));
    if (calls === 2) assert.match(data.contextBefore, /第19段/);
    return response([]);
  }).proofread(input);
  assert.deepEqual(seen, Array.from({ length: 51 }, (_, i) => i)); assert.equal(calls, 3);
  assert.equal(result.proofreading?.status, 'succeeded'); assert.equal(result.proofreading?.changes.length, 0);
  assert.deepEqual(result.words, input.words);
});

for (const [name, corrections, finish] of [
  ['invalid segment', [{ segmentIndex: 5, before: '勾子', after: '钩子' }], 'stop'],
  ['numeric rewrite', [{ segmentIndex: 0, before: '26岁', after: '30岁' }], 'stop'],
  ['delete', [{ segmentIndex: 0, before: '勾子', after: '' }], 'stop'],
  ['rewrite', [{ segmentIndex: 0, before: '章尾勾子要清楚。', after: '每章必须安排新鲜剧情让读者主动关注故事。' }], 'stop'],
  ['truncated', [], 'length'],
  ['ambiguous replacement', [{ segmentIndex: 0, before: '勾子', after: '钩子' }], 'stop'],
  ['negation rewrite', [{ segmentIndex: 0, before: '不能', after: '能' }], 'stop'],
] as const) test(`reject ${name} and keep original ASR`, async () => {
  const input = asset();
  if (name === 'numeric rewrite') input.segments[0].text = '她26岁创业。';
  if (name === 'ambiguous replacement') input.segments[0].text = '勾子勾子';
  if (name === 'negation rewrite') input.segments[0].text = '不能删除原文。';
  input.text = input.transcript = input.segments.map(s => s.text).join('\n');
  let calls = 0;
  const result = await service(() => { calls++; return response([...corrections], finish); }).proofread(input);
  assert.equal(result.proofreading?.status, 'failed'); assert.equal(result.text, input.text);
  assert.deepEqual(result.segments, input.segments); assert.equal(calls, 3);
});

test('inconsistent aggregate text is preserved instead of reconstructed with omissions', async () => {
  const input = asset(); input.text = input.transcript = '全文与分段不一致';
  const result = await service(() => response([{ segmentIndex: 0, before: '勾子', after: '钩子' }])).proofread(input);
  assert.equal(result.proofreading?.status, 'failed'); assert.equal(result.transcript, input.transcript);
  assert.deepEqual(result.segments, input.segments);
});

test('later batch failure rolls back earlier corrections', async () => {
  const input = asset(); input.segments = Array.from({ length: 21 }, (_, i) => ({ start: i * 2, end: i * 2 + 2, text: `${i}章尾勾子。` }));
  input.duration = 42; input.text = input.transcript = input.segments.map(s => s.text).join('\n');
  let calls = 0;
  const result = await service(() => { if (++calls === 1) return response([{ segmentIndex: 0, before: '勾子', after: '钩子' }]); throw new Error('private upstream detail'); }).proofread(input);
  assert.equal(result.proofreading?.status, 'failed'); assert.deepEqual(result.segments, input.segments);
  assert.doesNotMatch(result.proofreading?.reason ?? '', /private upstream detail/);
});

test('missing config and source captions retain input with explicit skipped status', async () => {
  const input = asset();
  const skipped = await new TranscriptProofreader({ resolveAiConfig: async () => null }).proofread(input);
  assert.equal(skipped.proofreading?.status, 'skipped'); assert.match(skipped.proofreading?.reason ?? '', /配置/); assert.equal(skipped.text, input.text);
  const captions = await service(() => { throw new Error('captions must not reach AI'); }).proofread({ ...input, provider: 'youtube-authored-captions' });
  assert.equal(captions.proofreading?.status, 'skipped'); assert.equal(captions.text, input.text);
});

test('pause passes abort signal to AI and never returns a committed result', async () => {
  const controller = new AbortController();
  await assert.rejects(service((_args, options) => { assert.equal(options.signal, controller.signal); controller.abort(); throw controller.signal.reason; }).proofread(asset(), controller.signal), { name: 'AbortError' });
});

test('installed OpenAI client sends the proofreading request and reads a compatible HTTP response', async () => {
  let requestBody: any;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requestBody = JSON.parse(body);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(response([{ segmentIndex: 0, before: '勾子', after: '钩子' }])));
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const result = await new TranscriptProofreader({ resolveAiConfig: async () => ({ ...config, baseURL: `http://127.0.0.1:${address.port}/v1` }) }).proofread(asset());
    assert.equal(result.proofreading?.status, 'succeeded'); assert.match(result.text, /章尾钩子/);
    assert.equal(requestBody.model, config.model); assert.equal(requestBody.max_tokens, 2400);
    assert.deepEqual(requestBody.response_format, { type: 'json_object' });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
