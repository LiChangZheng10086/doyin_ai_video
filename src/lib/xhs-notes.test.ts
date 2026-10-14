import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, readFile, rm, writeFile, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { XhsNoteService, XhsNoteWriter, XhsNoteError, type XhsNoteContent } from './xhs-notes.js';
import { LocalStorage } from './storage.js';
import { AssetStore } from './assets-store.js';
import type { ActorSnapshot } from '../types.js';

const content: XhsNoteContent = { title: '城市观察', description: '张三记录了变化，仍存在不确定性。', hashtags: ['观察'], cards: [{ title: '观察', body: '有条件的变化。' }], reviewNotes: ['请核对原文及使用权'] };
const actor: ActorSnapshot = { userId: 'operator', displayName: '本机用户', role: 'publisher' };
const status = (expected: number) => (error: unknown) => error instanceof XhsNoteError && error.status === expected;
async function setup(t: TestContext, rewrite = async () => structuredClone(content)) {
  const root = await mkdtemp(path.join(tmpdir(), 'xhs-notes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = new LocalStorage(root); await storage.ensureBaseDirs();
  const library = new AssetStore(storage);
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  const images = await Promise.all([1, 2].map(n => library.add('image', { originalName: `${n}.png`, data: Buffer.concat([png, Buffer.from([n])]) })));
  const calls: any[] = [];
  const deps = { storage, library, writer: { rewrite }, publishing: { createXhsNote: async (input: any, who: any) => { calls.push({ input, who }); return { package: { id: 'package' }, tasks: [] } as any; } } };
  const notes = new XhsNoteService(deps);
  return { storage, library, images, calls, notes, deps };
}
async function ready(f: Awaited<ReturnType<typeof setup>>) {
  const draft = await f.notes.create({ sourceText: '完整原文：条件、数字和作者归因。', sourceAuthor: '张三', imageAssetIds: f.images.map(i => i.id) });
  return f.notes.rewrite(draft.id, draft.version);
}

test('create preserves complete input, defaults empty outputs, and persists across reopening', async t => {
  const f = await setup(t); const sourceText = '完整原文\n'.repeat(6000);
  const note = await f.notes.create({ sourceText, sourceUrl: 'https://example.com/original', voiceSample: '表达样本' });
  assert.equal(note.sourceText, sourceText); assert.equal(note.title, ''); assert.deepEqual(note.cards, []);
  assert.equal(note.imageMode, 'library'); assert.equal(note.version, 1); assert.equal(note.contentSourceHash, undefined);
  assert.deepEqual(await new XhsNoteService(f.deps).get(note.id), note);
  assert.equal((await f.notes.list()).length, 1);
});

test('invalid inputs and HTTP owned metadata cannot overwrite a draft', async t => {
  const f = await setup(t); const note = await f.notes.create({ sourceText: '原文' });
  for (const patch of [{ sourceText: '' }, { sourceText: '文'.repeat(40001) }, { voiceSample: '文'.repeat(5001) }, { title: '文'.repeat(21) }, { description: '文'.repeat(1001) }, { hashtags: ['文'.repeat(21)] }, { hashtags: Array(11).fill('话题') }, { cards: [{ title: '', body: '文'.repeat(601) }] }, { cards: Array(19).fill({ title: '', body: '文' }) }, { imageAssetIds: Array(19).fill('image') }, { imageAssetIds: ['../private'] }, { contentSourceHash: 'forged' }, { cardImageHash: 'forged' }, { id: 'forged' }, { version: 1.5 }]) {
    await assert.rejects(f.notes.update(note.id, { version: note.version, ...patch }), error => error instanceof XhsNoteError);
    assert.deepEqual(await f.notes.get(note.id), note);
  }
  await assert.rejects(f.notes.create({ sourceText: '原文', contentSourceHash: 'forged' }), status(400));
});

test('serial writes preserve concurrent creates and exactly one same-version update succeeds', async t => {
  const f = await setup(t);
  const drafts = await Promise.all(Array.from({ length: 8 }, (_, i) => f.notes.create({ sourceText: `原文${i}` })));
  assert.equal((await f.notes.list()).length, 8);
  const results = await Promise.allSettled(['甲', '乙'].map(title => f.notes.update(drafts[0].id, { version: 1, title })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
  assert.equal(rejected.reason.status, 409); assert.equal((await f.notes.get(drafts[0].id)).version, 2);
});

test('corrupt index or record is never treated as empty or overwritten', async t => {
  const f = await setup(t);
  for (const bytes of ['{broken', JSON.stringify({ schemaVersion: 1, notes: { invalid: { id: 'invalid', version: 1 } } }), JSON.stringify({ schemaVersion: 9, notes: {} })]) {
    await writeFile(f.storage.resolve('cache/xhs-notes.json'), bytes);
    await assert.rejects(f.notes.create({ sourceText: '原文' }), status(500));
    await assert.rejects(f.notes.list(), status(500));
    assert.equal(await readFile(f.storage.resolve('cache/xhs-notes.json'), 'utf8'), bytes);
  }
});

test('title edits after source changes cannot certify old content; only rewrite restores binding', async t => {
  const f = await setup(t); let note = await ready(f);
  const oldHash = note.contentSourceHash; assert.ok(oldHash);
  note = await f.notes.update(note.id, { version: note.version, title: '改标题' });
  assert.equal(note.contentSourceHash, oldHash); await f.notes.preview(note.id, note.version);
  note = await f.notes.update(note.id, { version: note.version, sourceText: '全新原文', description: note.description });
  assert.equal(note.contentSourceHash, undefined); assert.equal(note.description, content.description);
  note = await f.notes.update(note.id, { version: note.version, title: '再次改标题', description: '手动新正文' });
  assert.equal(note.contentSourceHash, undefined); await assert.rejects(f.notes.preview(note.id, note.version), status(409));
  note = await f.notes.rewrite(note.id, note.version); assert.notEqual(note.contentSourceHash, oldHash);
  await f.notes.preview(note.id, note.version);
  for (const field of ['sourceAuthor', 'sourceUrl', 'audience', 'voiceSample', 'instructions']) {
    note = await f.notes.update(note.id, { version: note.version, [field]: '变更' });
    await assert.rejects(f.notes.preview(note.id, note.version), status(409));
    note = await f.notes.rewrite(note.id, note.version);
  }
});

test('card images bind only unchanged saved cards; captured render version conflicts on intervening edits', async t => {
  const f = await setup(t); let note = await ready(f);
  note = await f.notes.update(note.id, { version: note.version, imageMode: 'cards', cards: [{ title: '新图卡', body: '正文' }] });
  const capturedVersion = note.version;
  note = await f.notes.update(note.id, { version: note.version, title: '并发编辑' });
  await assert.rejects(f.notes.update(note.id, { version: capturedVersion, imageMode: 'cards', imageAssetIds: [f.images[0].id] }), status(409));
  assert.equal((await f.notes.get(note.id)).cardImageHash, undefined);
  note = await f.notes.update(note.id, { version: note.version, imageMode: 'cards', imageAssetIds: [f.images[0].id] });
  assert.ok(note.cardImageHash); await f.notes.preview(note.id, note.version);
  note = await f.notes.update(note.id, { version: note.version, cards: [{ title: '再改图卡', body: '正文' }], imageAssetIds: [f.images[0].id] });
  assert.equal(note.cardImageHash, undefined); await assert.rejects(f.notes.preview(note.id, note.version), status(409));
});

test('card binding rejects partial uploads and nonexistent/audio library assets', async t => {
  const f = await setup(t); let note = await ready(f);
  note = await f.notes.update(note.id, { version: note.version, imageMode: 'cards', cards: [content.cards[0], content.cards[0]] });
  await assert.rejects(f.notes.update(note.id, { version: note.version, imageAssetIds: [f.images[0].id] }), status(422));
  await assert.rejects(f.notes.update(note.id, { version: note.version, imageAssetIds: ['missing', f.images[0].id] }), status(422));
  const audio = await f.library.add('audio', { originalName: 'audio.mp3', data: Buffer.from('audio') });
  await assert.rejects(f.notes.update(note.id, { version: note.version, imageAssetIds: [audio.id, f.images[0].id] }), status(422));
  assert.equal((await f.notes.get(note.id)).version, note.version);
});

test('preview fails closed on forged paths and external symlinks even after library resolution', async t => {
  const f = await setup(t); const note = await ready(f);
  const outside = f.storage.resolve('raw/text/private.txt'); await writeFile(outside, 'private');
  const asset = (await f.library.resolveFile(f.images[0].id))!;
  const forged = new XhsNoteService({ ...f.deps, library: { resolveFile: async () => ({ ...asset, path: outside }) } });
  await assert.rejects(forged.preview(note.id, note.version), status(422));
  await rm(asset.path); await symlink(outside, asset.path);
  await assert.rejects(f.notes.preview(note.id, note.version), status(422)); assert.equal(f.calls.length, 0);
});

test('preview rejects a symlinked images directory whose canonical root escapes storage', async t => {
  const f = await setup(t); const note = await ready(f);
  const outside = await mkdtemp(path.join(tmpdir(), 'xhs-outside-')); t.after(() => rm(outside, { recursive: true, force: true }));
  const images = f.storage.resolve('assets/images');
  await rename(images, path.join(outside, 'images')); await symlink(path.join(outside, 'images'), images);
  await assert.rejects(f.notes.preview(note.id, note.version), status(422)); assert.equal(f.calls.length, 0);
});

test('rewrite preserves safe configuration guidance from the writer', async t => {
  const f = await setup(t);
  const note = await f.notes.create({ sourceText: '来源' });
  const failure = new XhsNoteError(422, '请先在设置中配置 AI', 'xhs_note_ai_unavailable');
  f.deps.writer.rewrite = async () => { throw failure; };
  await assert.rejects(f.notes.rewrite(note.id, note.version), error => error === failure);
  assert.deepEqual(await f.notes.get(note.id), note);
});

test('preview binds every source, content, card, image order and version field', async t => {
  const f = await setup(t); let note = await ready(f);
  for (const patch of [{ title: '变标题' }, { description: '变正文' }, { hashtags: ['变话题'] }, { reviewNotes: ['变备注'] }, { cards: [{ title: '变图卡', body: '完整新图卡' }] }, { imageAssetIds: [...note.imageAssetIds].reverse() }]) {
    const previous = await f.notes.preview(note.id, note.version);
    note = await f.notes.update(note.id, { version: note.version, ...patch });
    const current = await f.notes.preview(note.id, note.version);
    assert.notEqual(current.previewRevision, previous.previewRevision);
    await assert.rejects(f.notes.createPackage(note.id, { version: note.version, previewRevision: previous.previewRevision, rightsConfirmed: true }, actor), status(409));
  }
  assert.equal(f.calls.length, 0);
});

test('package creation locks edits and double package attempts until publisher completes', async t => {
  const f = await setup(t); const note = await ready(f); const preview = await f.notes.preview(note.id, note.version);
  let release!: () => void; let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const entered = new Promise<void>(resolve => { started = resolve; });
  f.deps.publishing.createXhsNote = async () => { started(); await gate; return { package: { id: 'package' }, tasks: [] } as any; };
  const input = { version: note.version, previewRevision: preview.previewRevision, rightsConfirmed: true };
  const running = f.notes.createPackage(note.id, input, actor); await entered;
  await assert.rejects(f.notes.update(note.id, { version: note.version, title: '并发改动' }), status(409));
  await assert.rejects(f.notes.createPackage(note.id, input, actor), status(409));
  release(); assert.equal((await running).package.id, 'package'); assert.deepEqual(await f.notes.get(note.id), note);
});

test('rewrite locks same draft, permits another draft, and preserves all old outputs on failure', async t => {
  let release!: () => void; let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const entered = new Promise<void>(resolve => { started = resolve; });
  const f = await setup(t); const note = await ready(f);
  f.deps.writer.rewrite = async () => { started(); await gate; throw new Error('private api key and source'); };
  const running = f.notes.rewrite(note.id, note.version); await entered;
  await assert.rejects(f.notes.rewrite(note.id, note.version), status(409));
  await assert.rejects(f.notes.update(note.id, { version: note.version, title: '并发' }), status(409));
  await assert.rejects(f.notes.remove(note.id, note.version), status(409));
  await assert.rejects(f.notes.preview(note.id, note.version), status(409));
  await f.notes.create({ sourceText: '另一草稿' }); release();
  await assert.rejects(running, error => status(422)(error) && !(error as Error).message.includes('private'));
  assert.deepEqual(await f.notes.get(note.id), note);
  assert.equal((await f.notes.update(note.id, { version: note.version, title: '失败后可编辑' })).title, '失败后可编辑');
});

test('preview validates ordered image bytes and package rejects stale revision or absent rights without side effects', async t => {
  const f = await setup(t); let note = await ready(f);
  const preview = await f.notes.preview(note.id, note.version);
  assert.deepEqual(preview.imageAssetIds, f.images.map(i => i.id)); assert.equal(preview.imageLimit, 18); assert.equal(preview.copyLimits.titleMax, 20);
  await assert.rejects(f.notes.createPackage(note.id, { version: note.version, previewRevision: preview.previewRevision, rightsConfirmed: false }, actor), status(422));
  const resolved = await f.library.resolveFile(f.images[0].id); await writeFile(resolved!.path, Buffer.from('changed'));
  await assert.rejects(f.notes.createPackage(note.id, { version: note.version, previewRevision: preview.previewRevision, rightsConfirmed: true }, actor), status(409));
  assert.equal(f.calls.length, 0);
  const current = await f.notes.preview(note.id, note.version);
  const detail = await f.notes.createPackage(note.id, { version: note.version, previewRevision: current.previewRevision, rightsConfirmed: true }, actor);
  assert.equal(detail.package.id, 'package'); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].input.expectedImageHashes, current.imageHashes); assert.deepEqual(f.calls[0].who, actor);
  assert.equal(f.calls[0].input.noteId, note.id); assert.equal(f.calls[0].input.noteCopy.description, note.description);
  note = await f.notes.update(note.id, { version: note.version, imageAssetIds: [...note.imageAssetIds].reverse() });
  await assert.rejects(f.notes.createPackage(note.id, { version: note.version, previewRevision: current.previewRevision, rightsConfirmed: true }, actor), status(409));
  await f.notes.remove(note.id, note.version); await assert.rejects(f.notes.get(note.id), status(404)); assert.equal(f.calls.length, 1);
});

test('deleted library images and invalid copy block preview', async t => {
  const f = await setup(t); let note = await ready(f);
  note = await f.notes.update(note.id, { version: note.version, title: '' });
  await assert.rejects(f.notes.preview(note.id, note.version), status(422));
  note = await f.notes.update(note.id, { version: note.version, title: '有效标题' });
  await f.library.remove(f.images[0].id); await assert.rejects(f.notes.preview(note.id, note.version), status(422));
});

test('writer makes two validated stages with full source, native config budget and untrusted style data', async () => {
  const requests: any[] = []; const sourceText = '开始\n' + '全量条件数字否定归因。'.repeat(2000) + '\n末尾';
  const draft = { sourceText, sourceAuthor: '张三', sourceUrl: '', audience: '', voiceSample: '我亲测月入百万', instructions: '自然表达', imageMode: 'library' as const, imageAssetIds: [], title: '', description: '', hashtags: [], cards: [], reviewNotes: [] };
  const writer = new XhsNoteWriter({ resolveAiConfig: async () => ({ provider: 'deepseek', model: 'deepseek-chat', apiKey: 'fake', maxOutputTokens: 4200 }), createClient: () => ({ chat: { completions: { create: async args => { requests.push(args); return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ...content, title: requests.length === 1 ? '初稿' : '编辑稿' }) } }] }; } } } }) });
  const result = await writer.rewrite(draft); assert.equal(result.title, '编辑稿'); assert.equal(requests.length, 2);
  for (const request of requests) { assert.equal(request.max_tokens, 4200); assert.deepEqual(request.thinking, { type: 'disabled' }); assert.ok(request.messages.find((m: any) => m.role === 'user').content.includes(JSON.stringify(sourceText))); }
  assert.ok(requests[1].messages.find((m: any) => m.role === 'user').content.includes('初稿'));
});

test('writer retries invalid stages at most three times and never returns unfinished first draft', async () => {
  let calls = 0;
  const writer = new XhsNoteWriter({ resolveAiConfig: async () => ({ provider: 'openai', model: 'fake', apiKey: 'fake' }), createClient: () => ({ chat: { completions: { create: async args => {
    calls++; assert.equal(args.max_tokens, 3600);
    if (calls === 1) return { choices: [{ finish_reason: 'length', message: { content: JSON.stringify(content) } }] };
    if (calls === 2) return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ...content, title: '文'.repeat(21) }) } }] };
    if (calls === 3) return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] };
    throw new Error('secret-key /private/path');
  } } } }) });
  await assert.rejects(writer.rewrite({ sourceText: '来源', sourceAuthor: '', sourceUrl: '', audience: '', voiceSample: '', instructions: '', imageMode: 'library', imageAssetIds: [], ...content }), error => status(422)(error) && !(error as Error).message.includes('secret'));
  assert.equal(calls, 6);
});

test('writer rejects absent configuration and malformed/empty output without fallback', async () => {
  const draft = { sourceText: '来源', sourceAuthor: '', sourceUrl: '', audience: '', voiceSample: '', instructions: '', imageMode: 'library' as const, imageAssetIds: [], ...content };
  await assert.rejects(new XhsNoteWriter({ resolveAiConfig: async () => null }).rewrite(draft), status(422));
  for (const value of ['', 'null', '{}', JSON.stringify({ ...content, cards: [{ title: '', body: '' }] }), JSON.stringify({ ...content, reviewNotes: [123] })]) {
    let calls = 0;
    const writer = new XhsNoteWriter({ resolveAiConfig: async () => ({ provider: 'openai', model: 'fake', apiKey: 'fake' }), createClient: () => ({ chat: { completions: { create: async () => { calls++; return { choices: [{ message: { content: value } }] }; } } } }) });
    await assert.rejects(writer.rewrite(draft), status(422)); assert.equal(calls, 3);
  }
});

test('writer refuses results that omit supplied author attribution', async () => {
  let calls = 0;
  const writer = new XhsNoteWriter({ resolveAiConfig: async () => ({ provider: 'openai', model: 'fake', apiKey: 'fake' }), createClient: () => ({ chat: { completions: { create: async () => {
    calls++; return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ...content, description: '城市发生变化。' }) } }] };
  } } } }) });
  await assert.rejects(writer.rewrite({ sourceText: '张三的原文', sourceAuthor: '张三', sourceUrl: '', audience: '', voiceSample: '', instructions: '', imageMode: 'library', imageAssetIds: [], ...content }), status(422));
  assert.equal(calls, 3);
});

test('default writer uses native fetch for both SDK requests without real network', async t => {
  const requests: any[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: any) => {
    const request = JSON.parse(String(options.body)); requests.push(request);
    assert.ok(options.signal);
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ...content, title: requests.length === 1 ? '初稿' : '原生编辑稿' }) } }] }), { headers: { 'Content-Type': 'application/json' } });
  });
  const writer = new XhsNoteWriter({ resolveAiConfig: async () => ({ provider: 'deepseek', apiKey: 'fake', model: 'fake', baseURL: 'http://127.0.0.1:1' }) });
  const result = await writer.rewrite({ sourceText: '完整来源', sourceAuthor: '张三', sourceUrl: '', audience: '', voiceSample: '', instructions: '', imageMode: 'library', imageAssetIds: [], ...content });
  assert.equal(result.title, '原生编辑稿'); assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(request => request.thinking), [{ type: 'disabled' }, { type: 'disabled' }]);
});

test('per-request abort signal bounds native response bodies and retries within the stage budget', async t => {
  const controllers: AbortController[] = []; const budgets: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { budgets.push(ms); const controller = new AbortController(); controllers.push(controller); return controller.signal; });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: any) => {
    calls++;
    if (calls === 1) {
      const stream = new ReadableStream({ start(controller) { options.signal.addEventListener('abort', () => controller.error(new DOMException('body aborted', 'AbortError')), { once: true }); } });
      setImmediate(() => controllers[0]?.abort());
      return new Response(stream, { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] }), { headers: { 'Content-Type': 'application/json' } });
  });
  const writer = new XhsNoteWriter({ resolveAiConfig: async () => ({ provider: 'openai', apiKey: 'fake', model: 'fake', baseURL: 'http://127.0.0.1:1' }) });
  const running = writer.rewrite({ sourceText: '完整来源', sourceAuthor: '张三', sourceUrl: '', audience: '', voiceSample: '', instructions: '', imageMode: 'library', imageAssetIds: [], ...content });
  // Avoid a hanging regression if the implementation does not pass a response-body signal.
  const result = await Promise.race([running, new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('response body was not bounded by the per-request signal')), 1000);
    t.after(() => clearTimeout(timer));
  })]);
  assert.equal(result.title, content.title); assert.equal(calls, 3); assert.deepEqual(budgets, [60000, 60000, 60000]);
});
