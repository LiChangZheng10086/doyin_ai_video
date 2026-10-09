import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectNativeSubtitle, type NativeTextLine } from './subtitle-ocr.js';

const line = (text: string, overrides: Partial<NativeTextLine> = {}): NativeTextLine => ({ text, confidence: .95, left: .3, right: .7, top: .9, bottom: .94, ...overrides });

test('OCR corroborates thin dialogue and rejects unmatched headlines, blank and low-confidence text', () => {
  assert.ok(selectNativeSubtitle([line('内容系统需要清晰目标')], '内容系统需要清晰目标先确定方向'));
  assert.equal(selectNativeSubtitle([line('城市展览馆开幕安排今日公布')], '接下来介绍内容流程'), null);
  assert.equal(selectNativeSubtitle([], '对白字幕'), null);
  assert.equal(selectNativeSubtitle([line('对白字幕', { confidence: .2 })], '对白字幕'), null);
  assert.equal(selectNativeSubtitle([line('对白字幕', { bottom: 1 })], '对白字幕'), null);
  assert.equal(selectNativeSubtitle([line('相关搜索：对白字幕')], '相关搜索对白字幕'), null);
  assert.equal(selectNativeSubtitle([line('8月11日')], '8月11日'), null);
  assert.equal(selectNativeSubtitle([line('外星人', { left: .05, right: .25 })], '外星人'), null);
  assert.equal(selectNativeSubtitle([line('对白字幕')], '白对字幕'), null, 'unordered common characters cannot corroborate a caption');
});

test('OCR retains both native lines, long text and traditional glyphs inside calibrated bounds', () => {
  const lines = [line('这是完整的第一行', { top: .8, bottom: .84 }), line('以及后半句第二行', { top: .86, bottom: .9 })];
  const candidate = selectNativeSubtitle(lines, '这是完整的第一行以及后半句第二行。');
  assert.ok(candidate && candidate.bandTop < .8 && candidate.bandBottom > .9);
  assert.equal(candidate.recognizedText, '这是完整的第一行以及后半句第二行');
  assert.ok(selectNativeSubtitle([line('內容系統需要清晰目標')], '内容系统需要清晰木标'));
  assert.equal(selectNativeSubtitle(lines, '这是完整的第一行', { bandTop: .85, bandBottom: .96 }), null);
  assert.ok(selectNativeSubtitle([line('骗子')], '骗子'));
});
