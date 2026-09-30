import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalStorage } from './storage.js';
import { ImagePromptService } from './image-prompts.js';

const input = { mode: 'generate', referenceText: '雨夜城市', count: 1 };
const output = { prompts: [{ title: '雨夜', tags: ['城市'], prompt: '雨夜街道，暖色路灯，主体居中。' }] };
async function fixture(t: any, reply: () => Promise<any> = async () => ({ choices: [{ message: { content: JSON.stringify(output) } }] })) {
  const root = await mkdtemp(path.join(tmpdir(), 'image-prompts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = new LocalStorage(root); await storage.ensureBaseDirs();
  const deps = { resolveAiConfig: async () => ({ provider: 'openai' as const, apiKey: 'fake-secret', model: 'test-model' }),
    createClient: () => ({ chat: { completions: { create: reply } } }) };
  return { storage, service: new ImagePromptService(storage, deps), deps };
}

test('prompts survive reopening and optimization creates a separate draft', async t => {
  const { storage, service, deps } = await fixture(t);
  const [first] = await service.generate(input);
  const [optimized] = await service.generate({ mode: 'optimize', originalPrompt: first.prompt });
  assert.notEqual(first.id, optimized.id);
  assert.equal(optimized.input.aspectRatio, undefined);
  const reopened = new ImagePromptService(storage, deps);
  assert.equal((await reopened.list()).length, 2);
  assert.equal((await reopened.snapshot(first.id, 1)).prompt, first.prompt);
});

test('snapshots stay unchanged after versioned edits and deletion', async t => {
  const { service } = await fixture(t); const [first] = await service.generate(input);
  const snapshot = await service.snapshot(first.id, 1);
  const updated = await service.update(first.id, { version: 1, prompt: '空街', tags: ['安静'] });
  assert.equal(updated.version, 2);
  await assert.rejects(service.update(first.id, { version: 1, title: '旧编辑' }), { status: 409 });
  await assert.rejects(service.snapshot(first.id, 1), { status: 409 });
  await service.remove(first.id, 2);
  assert.equal(snapshot.prompt, '雨夜街道，暖色路灯，主体居中。');
  assert.deepEqual(await service.list(), []);
});

test('invalid input, upstream shape and count never save partial drafts', async t => {
  const { service } = await fixture(t);
  for (const bad of [{ ...input, count: 7 }, { ...input, referenceText: '' }, { ...input, count: 1.5 },
    { mode: 'optimize', originalPrompt: 'x', count: 2 }, { ...input, referenceText: 'a'.repeat(12001) }]) {
    await assert.rejects(service.generate(bad), { status: 400 });
  }
  await assert.rejects(service.generate({ ...input, count: 2 }), { status: 502 });
  assert.deepEqual(await service.list(), []);
  const malformed = await fixture(t, async () => ({ choices: [{ message: { content: '{broken' } }] }));
  await assert.rejects(malformed.service.generate(input), { status: 502 });
  assert.deepEqual(await malformed.service.list(), []);
});

test('concurrent generations retain all records and damaged indexes are preserved', async t => {
  const { storage, service } = await fixture(t);
  await Promise.all([service.generate(input), service.generate(input), service.generate(input)]);
  assert.equal((await service.list()).length, 3);
  await writeFile(storage.resolve('cache/image-prompts.json'), '{broken');
  await assert.rejects(service.generate(input), { status: 500 });
  assert.equal(await readFile(storage.resolve('cache/image-prompts.json'), 'utf8'), '{broken');
});

test('missing configuration, upstream failure and timeout have distinct safe errors', async t => {
  const { storage } = await fixture(t);
  await assert.rejects(new ImagePromptService(storage, { resolveAiConfig: async () => null }).generate(input), { status: 422 });
  const failing = await fixture(t, async () => { throw new Error('private provider detail'); });
  await assert.rejects(failing.service.generate(input), e => (e as any).status === 502 && !(e as Error).message.includes('private'));
  const timeout = await fixture(t, async () => { const e = new Error('provider'); e.name = 'APIConnectionTimeoutError'; throw e; });
  await assert.rejects(timeout.service.generate(input), { status: 504 });
});
