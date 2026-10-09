import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GalleryCopyWriter } from './gallery-copy.js';

const config = { apiKey: 'test-key', model: 'test', provider: 'openai' as const };
const output = { title: '提高追更率的三个节奏', description: '读者需要持续获得新信息。\n1. 开头回应上章悬念。\n2. 章中制造相关问题。\n3. 章尾推动行动。\n你最想改哪一步？', hashtags: ['小说创作'], notes: ['收入数字识别不清，请核对。'] };
const source = { topic: '未核实的日收300标题', transcript: '开场信息。'.repeat(70) + '末尾核心观点必须保留。', nativeSubtitles: ['原生字幕补充核对'] };

test('gallery copy receives the complete source and native captions with attribution and factual limits', async () => {
  const requests: any[] = [];
  const writer = new GalleryCopyWriter({ resolveAiConfig: async () => config, createClient: () => ({ chat: { completions: { create: async (request: any) => {
    requests.push(request); return { choices: [{ message: { content: JSON.stringify(output) } }] };
  } } } }) });
  assert.deepEqual(await writer.write(source), output);
  assert.match(requests[0].messages[1].content, /末尾核心观点必须保留/);
  assert.match(requests[0].messages[1].content, /原生字幕补充核对/);
  assert.doesNotMatch(requests[0].messages[1].content, /未核实的日收300/);
  assert.match(requests[0].messages[0].content, /背景|编号/);
  assert.match(requests[0].messages[0].content, /1000|20/);
  assert.match(requests[0].messages[0].content, /身份|承诺/);
  assert.match(requests[0].messages[0].content, /面向读者自然表达/);
});

test('overlong or truncated AI copy is rewritten up to three attempts and never sliced', async () => {
  let calls = 0;
  const writer = new GalleryCopyWriter({ resolveAiConfig: async () => config, createClient: () => ({ chat: { completions: { create: async () => {
    calls++; return { choices: [{ finish_reason: calls === 1 ? 'length' : 'stop', message: { content: JSON.stringify(calls < 3 ? { ...output, description: '字'.repeat(1001) } : output) } }] };
  } } } }) });
  assert.equal((await writer.write(source)).description, output.description); assert.equal(calls, 3);
  calls = 0;
  const bad = new GalleryCopyWriter({ resolveAiConfig: async () => config, createClient: () => ({ chat: { completions: { create: async () => {
    calls++; return { choices: [{ message: { content: JSON.stringify({ ...output, description: '字'.repeat(1001) }) } }] };
  } } } }) });
  await assert.rejects(bad.write(source), /1000|超限|文案/); assert.equal(calls, 3);
});

test('DeepSeek copy disables thinking and respects the configured output budget', async () => {
  for (const maxOutputTokens of [undefined, 3600]) {
    const requests: any[] = [];
    const writer = new GalleryCopyWriter({ resolveAiConfig: async () => ({ ...config, provider: 'deepseek', model: 'deepseek-v4-flash', maxOutputTokens }), createClient: () => ({ chat: { completions: { create: async (request: any) => {
      requests.push(request); return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] };
    } } } }) });
    await writer.write(source);
    assert.deepEqual(requests[0].thinking, { type: 'disabled' });
    assert.equal(requests[0].max_tokens, maxOutputTokens ?? 2400);
    assert.equal(requests[0].extra_body, undefined);
  }
});

test('missing config, huge input and invented operator identity fail without claiming a usable copy', async () => {
  await assert.rejects(new GalleryCopyWriter({ resolveAiConfig: async () => null }).write(source), /配置/);
  const writer = new GalleryCopyWriter({ resolveAiConfig: async () => config, createClient: () => ({ chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify({ ...output, description: '我每天更新自己的创业经历，记得关注。' }) } }] }) } } }) });
  await assert.rejects(writer.write(source), /身份|承诺/);
  await assert.rejects(writer.write({ ...source, transcript: '长'.repeat(50001) }), /过长/);
});
