import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { createExpressApp } from '../app.js';
import { OpenAiScriptCleaner } from './ai-cleaner.js';
import { PublishingCopyService } from './publishing-copy.js';
import { planToutiaoArticle } from './toutiao-article.js';
import { TranscriptProofreader } from './transcript-proofreader.js';
import { ImagePromptService } from './image-prompts.js';
import { JobStore } from './jobs.js';
import { LocalStorage } from './storage.js';
import type { ScriptAsset, TranscriptAsset } from '../types.js';

const config = { provider: 'deepseek' as const, apiKey: 'fake-secret', model: 'test-model', baseURL: 'http://127.0.0.1:1' };

function nativeReply(t: TestContext, payload: unknown) {
  const originalFetch = globalThis.fetch;
  const requests: any[] = [];
  t.mock.method(globalThis, 'fetch', async (url: any, options: any) => {
    if (!String(url).startsWith(config.baseURL + '/')) return originalFetch(url, options);
    const request = JSON.parse(String(options.body));
    requests.push(request);
    assert.equal(request.model, config.model);
    assert.ok(options.signal, 'SDK timeout/cancellation must reach the native transport');
    const content = typeof payload === 'string' ? payload : JSON.stringify(payload);
    if (request.stream) return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    return new Response('\n\n' + JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }), { headers: { 'Content-Type': 'application/json' } });
  });
  return requests;
}

async function storageFixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-native-fetch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = new LocalStorage(root);
  await storage.ensureBaseDirs();
  return { root, storage };
}

test('default cleaner accepts native JSON and SSE responses without replacing the SDK client', async t => {
  const payload = { title: '内容生产方法', summary: '核心内容', hook: '先找准核心问题', key_points: ['核心内容', '明确目标', '验证结果'], clean_script: '核心内容', short_video_script: '核心内容'.repeat(46), cover_title: '内容生产方法', tags: ['内容生产'], quality_notes: [] };
  const requests = nativeReply(t, payload);
  const cleaner = new OpenAiScriptCleaner(config);
  const draft = { sourceUrl: 'local', topic: '内容生产', rawText: '原始转录', cleanScript: '原始转录', voiceoverScript: '原始转录', coverTitle: '内容生产', tags: [], sceneList: [], status: 'draft' } as ScriptAsset;
  const input = { topic: draft.topic, transcriptText: draft.rawText, draft };
  const controller = new AbortController();
  assert.equal((await cleaner.clean(input, controller.signal)).title, payload.title);
  let streamed = '';
  assert.equal((await cleaner.clean(input, controller.signal, update => { streamed = update.text; })).title, payload.title);
  assert.equal(JSON.parse(streamed).title, payload.title);
  assert.deepEqual(requests.map(request => request.stream), [undefined, true]);
});

test('default publishing copy client returns AI copy through native fetch rather than fallback', async t => {
  const copy = { title: '内容生产', description: '明确目标，逐项验证。', hashtags: ['内容创作'] };
  const requests = nativeReply(t, { douyin: copy });
  const service = new PublishingCopyService({ resolveAiConfig: async () => config });
  const result = await service.previewAll({ title: '内容生产', summary: '明确目标', keyPoints: ['验证结果'], tags: [] } as unknown as ScriptAsset, ['douyin']);
  assert.deepEqual(result.copies.douyin, { ...copy, copySource: 'ai' });
  assert.equal(result.warning, undefined);
  assert.equal(requests.length, 1);
});

test('shared article planner reads native responses and retains the platform draft contract', async t => {
  const draft = { title: '内容生产', sections: [{ heading: '明确目标', paragraphs: ['逐项验证。'] }], tags: ['内容创作'] };
  const requests = nativeReply(t, draft);
  const result = await planToutiaoArticle({ title: '内容生产', summary: '明确目标' }, { resolveAiConfig: async () => config });
  assert.equal(result.copySource, 'ai');
  assert.deepEqual(result.draft, draft);
  assert.equal(requests.length, 1);
});

test('default proofreader uses native fetch and retains original ASR and cancellation support', async t => {
  const requests = nativeReply(t, { corrections: [{ segmentIndex: 0, before: '勾子', after: '钩子' }] });
  const asset: TranscriptAsset = { jobId: 'test', sourceUrl: 'local', audioPath: 'audio.wav', text: '章尾勾子要清楚。', transcript: '章尾勾子要清楚。', segments: [{ start: 0, end: 2, text: '章尾勾子要清楚。' }], duration: 2, model: 'ggml-small', provider: 'whisper.cpp', createdAt: 'now' };
  const result = await new TranscriptProofreader({ resolveAiConfig: async () => config }).proofread(asset, new AbortController().signal);
  assert.equal(result.proofreading?.status, 'succeeded');
  assert.equal(result.text, '章尾钩子要清楚。');
  assert.equal(result.proofreading?.original?.text, asset.text);
  assert.equal(requests.length, 1);
});

test('default image prompt client saves validated native responses to isolated storage', async t => {
  const prompt = { title: '雨夜', tags: ['城市'], prompt: '雨夜街道，暖色路灯。' };
  const requests = nativeReply(t, { prompts: [prompt] });
  const { storage } = await storageFixture(t);
  const service = new ImagePromptService(storage, { resolveAiConfig: async () => config });
  const [saved] = await service.generate({ mode: 'generate', referenceText: '雨夜城市' });
  assert.equal(saved.prompt, prompt.prompt);
  assert.deepEqual(await service.list(), [saved]);
  assert.equal(requests.length, 1);
});

for (const automatic of [false, true]) test(`Skills ${automatic ? 'automatic sync' : 'manual extraction'} uses native fetch and does not save an empty result`, async t => {
  const { root, storage } = await storageFixture(t);
  const id = 'native-fetch-test';
  const collection = { id, nickname: 'test', sourcePageUrl: 'https://example.com', secUid: 'test', avatarUrl: '', crawlResult: { items: [{ awemeId: 'video', desc: 'test' }], totalCollected: 1, hasMore: false, nextCursor: 0 }, childJobIds: ['source'], childJobMap: { video: 'source' }, autoSyncSkill: true, skillName: 'test', createdAt: 'now', updatedAt: 'now' };
  await storage.writeJsonAtomic('cache/collections-index.json', { [id]: collection });
  await storage.writeJsonAtomic('raw/transcripts/source.json', { transcript: '完整来源。' });
  if (automatic) t.mock.method(JobStore.prototype, 'runStep', async () => {});
  const app = await createExpressApp({ rootDir: root, storagePath: root, resolveAiConfig: async () => config });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const requests = nativeReply(t, '');
  const response = await fetch(`http://127.0.0.1:${address.port}/api/collections/${id}/${automatic ? 'steps/transcribe' : 'generate-skill'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 200);
  const body = await response.text();
  if (automatic) {
    assert.equal(JSON.parse(body).results[0].status, 'ok');
    for (let i = 0; i < 100 && !requests.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
    await new Promise(resolve => setImmediate(resolve));
  } else {
    const events = body.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events.at(-1).success, false);
    assert.match(events.at(-1).error, /未生成 Skill/);
  }
  assert.equal(requests.length, 1);
  assert.deepEqual(await storage.readJson('cache/collections-index.json'), { [id]: collection });
});
