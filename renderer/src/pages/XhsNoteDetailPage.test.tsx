import React from 'react';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { bindXhsNoteCardImages, editXhsNote, XhsNoteWorkspace, xhsNoteChanges } from './XhsNoteDetailPage.js';
import type { XhsNote } from '../../../src/lib/xhs-notes';

const note = (): XhsNote => ({ id: 'n', version: 7, sourceText: '原文有条件：收入 100 元。', sourceAuthor: '作者', sourceUrl: '', audience: '', voiceSample: '', instructions: '',
  title: '原笔记', description: '保留条件', hashtags: ['笔记'], cards: [{ title: '封面', body: '原文内容' }], reviewNotes: ['核对条件'], imageMode: 'library', imageAssetIds: ['old'],
  contentSourceHash: 'source', cardImageHash: 'cards', createdAt: '', updatedAt: '' });
const markup = (n: XhsNote) => {
  // 现有 Layout 在根 tsx 配置下使用经典 JSX，浏览器构建使用自动 JSX。
  const previous = (globalThis as any).React; (globalThis as any).React = React;
  try { return renderToStaticMarkup(<MemoryRouter><XhsNoteWorkspace initial={n} /></MemoryRouter>); }
  finally { if (previous === undefined) delete (globalThis as any).React; else (globalThis as any).React = previous; }
};
const file = () => new File(['png'], '图卡.png', { type: 'image/png' });

test('source changes clear binding and subsequent title-only or copy edits never certify the old copy', () => {
  const old = note();
  const changed = editXhsNote(old, { sourceText: '全新原文' });
  const titleOnly = editXhsNote({ ...changed, version: 8 }, { title: '手动编辑标题' });
  assert.equal(titleOnly.contentSourceHash, undefined);
  assert.equal(editXhsNote(titleOnly, { description: '手动编辑正文', cards: [{ title: '新卡', body: '正文' }] }).contentSourceHash, undefined);
  assert.equal(editXhsNote(old, { title: '有效来源下编辑' }).contentSourceHash, 'source');
  assert.equal(old.contentSourceHash, 'source');
  assert.match(markup(titleOnly), /当前原文尚未成功改写/);
  assert.match(markup(titleOnly), /disabled=""[^>]*>保存并预览笔记/);
});

test('draft patches carry only changed fields and never send provenance hashes or unchanged old image IDs', () => {
  const old = note();
  const changed = editXhsNote(old, { sourceText: '新资料', cards: [{ title: '更改的图卡', body: '正文' }] });
  assert.equal(changed.cardImageHash, undefined);
  assert.deepEqual(xhsNoteChanges(old, changed), { sourceText: '新资料', cards: changed.cards, version: 7 });
  assert.deepEqual(xhsNoteChanges(old, old), { version: 7 });
  assert.deepEqual(xhsNoteChanges(old, editXhsNote(old, { hashtags: ['新话题', ''], reviewNotes: [''] })), { hashtags: ['新话题'], reviewNotes: [], version: 7 });
  const cleared = editXhsNote(old, { hashtags: [''], reviewNotes: ['核对条件', '', '  '] });
  assert.deepEqual(xhsNoteChanges(old, cleared), { hashtags: [], reviewNotes: ['核对条件'], version: 7 });
  assert.deepEqual(cleared.reviewNotes, ['核对条件', '', '  '], '保存边界过滤空行，不能改动正在输入的换行');
});

test('card image binding captures the saved version before render and upload, conflicts do not switch to latest', async () => {
  const saved = { ...note(), imageMode: 'cards' as const };
  let serverVersion = saved.version;
  const calls: any[] = [];
  await assert.rejects(bindXhsNoteCardImages(saved, {
    uploadImageAssets: async () => { serverVersion++; return { assets: [{ id: 'new-card' }] as any }; },
    saveXhsNote: async (id, input) => {
      calls.push({ id, input });
      assert.notEqual(input.version, serverVersion);
      throw Object.assign(new Error('版本冲突'), { name: 'PublishingApiError', status: 409 });
    },
  }, async () => [file()]), /版本冲突/);
  assert.deepEqual(calls, [{ id: 'n', input: { version: 7, imageMode: 'cards', imageAssetIds: ['new-card'] } }]);
  assert.deepEqual(saved.imageAssetIds, ['old']);
});

test('partial upload or render overflow leaves the entire previous image selection intact', async () => {
  const saved = note(); let bindings = 0; let uploads = 0;
  const client = { uploadImageAssets: async () => { uploads++; return { assets: [{ id: 'partial' }] as any, failures: [{ index: 1, code: 'failed', message: '第二张失败' }] }; },
    saveXhsNote: async () => { bindings++; return saved; } };
  await assert.rejects(bindXhsNoteCardImages(saved, client, async () => [file(), file()]), /原有选图保留/);
  await assert.rejects(bindXhsNoteCardImages(saved, client, async () => { throw new Error('请拆成多张'); }), /拆成多张/);
  assert.equal(bindings, 0); assert.equal(uploads, 1); assert.deepEqual(saved.imageAssetIds, ['old']);
});

test('complete card upload binds ordered images once at the captured version', async () => {
  let input: unknown;
  await bindXhsNoteCardImages(note(), { uploadImageAssets: async () => ({ assets: [{ id: 'cover' }, { id: 'body' }] as any }),
    saveXhsNote: async (_id, patch) => { input = patch; return note(); } }, async () => [file(), file()]);
  assert.deepEqual(input, { version: 7, imageMode: 'cards', imageAssetIds: ['cover', 'body'] });
});

test('workspace keeps source and copy separate, exposes both image choices and gates packages on fresh preview', () => {
  const html = markup(note());
  for (const label of ['原文与改写要求', '笔记文案', '保存草稿', '改写成小红书笔记', '上传 / 素材库', '文字图卡', '话题', '审校意见', '图片顺序与预览', '风险由你的账号承担', 'AI 声明固定开启']) assert.ok(html.includes(label), label);
  assert.match(html, /disabled=""[^>]*aria-label="上移第 1 张图片"/);
  assert.match(html, /disabled=""[^>]*>创建小红书发布包/);
  const cards = markup({ ...note(), imageMode: 'cards', cardImageHash: undefined });
  assert.match(cards, /1080×1440 PNG/);
  assert.match(cards, /保存并生成整套图卡/);
  assert.match(cards, /原有图片仅供参考/);
  assert.match(cards, /disabled=""[^>]*>保存并预览笔记/);
  assert.match(cards, /disabled=""[^>]*aria-label="移除第 1 张图片"/);
});

test('overlong complete original and voice sample stay in the editor while rewrite is blocked', () => {
  const sourceText = '字'.repeat(40000) + '📝原文结尾';
  const voiceSample = '语'.repeat(5000) + '样稿结尾';
  const draft = editXhsNote(note(), { sourceText, voiceSample });
  const html = markup(draft);
  assert.ok(html.includes(sourceText)); assert.ok(html.includes(voiceSample));
  assert.equal(xhsNoteChanges(note(), draft).sourceText, sourceText);
  assert.match(html, /40005\/40000/);
  assert.match(html, /完整输入已保留/);
  assert.match(html, /disabled=""[^>]*>改写成小红书笔记/);
  assert.doesNotMatch(html, /maxLength="40000"|maxLength="5000"/);
});
