import assert from 'node:assert/strict';
import { test } from 'node:test';
import { layoutCardText, wrapCardText } from './xhs-note-cards.js';

const graphemes = (text: string) => [...new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }).segment(text)].length;

test('card wrapping preserves explicit blank lines, Chinese and complete emoji graphemes', () => {
  const text = '中文👨‍👩‍👧‍👦👍🏽测试\n\n第二段\r\n结尾';
  const lines = wrapCardText(text, 3, graphemes);
  assert.deepEqual(lines, ['中文👨‍👩‍👧‍👦', '👍🏽测试', '', '第二段', '结尾']);
  assert.equal(lines.join('').replace(/\n/g, ''), text.replace(/\r?\n/g, ''));
  assert.ok(lines.every(line => graphemes(line) <= 3));
});

test('card layout uses actual measured width, readable sizes and a safe footer margin', () => {
  const measurements: number[] = [];
  const card = { title: '保留原文数字 123', body: '中文与 emoji 👩🏽‍💻\n第二段原文。'.repeat(10) };
  const layout = layoutCardText(card, (text, size) => { measurements.push(size); return graphemes(text) * size; });
  assert.ok(measurements.length > 0);
  assert.ok(layout.bodySize >= 36);
  assert.ok(layout.titleHeight + layout.gap + layout.body.length * layout.bodySize * 1.65 <= 1192);
  assert.equal(layout.body.join(''), card.body.replace(/\n/g, ''));
});

test('too much text and a glyph wider than the card fail instead of clipping or truncating', () => {
  assert.throws(() => layoutCardText({ title: '长内容', body: '字'.repeat(600) }, (text, size) => graphemes(text) * size), /拆成多张/);
  assert.throws(() => wrapCardText('字', 50, () => 60), /拆分内容/);
});
