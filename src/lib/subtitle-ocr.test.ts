import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeSubtitleOcrBinary, selectNativeSubtitle, type NativeTextLine } from './subtitle-ocr.js';

test('development Electron uses the local OCR bridge despite having resourcesPath', () => {
  const resources = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
  const defaultApp = Object.getOwnPropertyDescriptor(process, 'defaultApp');
  try {
    Object.defineProperty(process, 'resourcesPath', { value: '/electron-resources', configurable: true });
    Object.defineProperty(process, 'defaultApp', { value: true, configurable: true });
    assert.equal(nativeSubtitleOcrBinary(), path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../vendor/runtime/subtitle-ocr'));
    Object.defineProperty(process, 'defaultApp', { value: false, configurable: true });
    assert.equal(nativeSubtitleOcrBinary(), path.join('/electron-resources', 'bin/subtitle-ocr'));
    Reflect.deleteProperty(process, 'resourcesPath');
    assert.equal(nativeSubtitleOcrBinary(), path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../vendor/runtime/subtitle-ocr'));
  } finally {
    if (resources) Object.defineProperty(process, 'resourcesPath', resources); else Reflect.deleteProperty(process, 'resourcesPath');
    if (defaultApp) Object.defineProperty(process, 'defaultApp', defaultApp); else Reflect.deleteProperty(process, 'defaultApp');
  }
});

const line = (text: string, overrides: Partial<NativeTextLine> = {}): NativeTextLine => ({ text, confidence: .95, left: .3, right: .7, top: .9, bottom: .94, ...overrides });

test('readable large native captions are not rejected as headlines', () => {
  assert.ok(selectNativeSubtitle([line('每一章都有清晰的收获', { top: .806, bottom: .895, left: .28, right: .7 })], '每一章都有清晰的收获'));
  assert.equal(selectNativeSubtitle([line('每一章都有清晰的收获', { top: .72, bottom: .91 })], '每一章都有清晰的收获'), null);
});

test('confident native captions tolerate ASR word errors but reject unrelated or news-labelled text', () => {
  assert.ok(selectNativeSubtitle([line('第一，开头回收上章悬念。', { confidence: .5 })], '第一,开头回休相交悬念,前几百字一定要给结果变化或者新信息'));
  assert.equal(selectNativeSubtitle([line('第一，开头回收上章悬念。', { confidence: .5 })], '第一开头介绍完全无关的内容'), null);
  assert.ok(selectNativeSubtitle([line('第一，开头快速抛出悬念。', { confidence: 1 })], '第一开头回休相交悬念前几百字一定要给结果变化或者新信息'));
  assert.ok(selectNativeSubtitle([line('真正稳住追读率的方法', { confidence: 1 })], '签证文著追读率的方法'));
  assert.equal(selectNativeSubtitle([line('今天讲述完全无关的消息', { confidence: 1 })], '第一开头快速抛出悬念'), null);
  assert.equal(selectNativeSubtitle([line('新闻直播间', { left: .05, right: .2 }), line('第一开头快速抛出悬念', { confidence: 1 })], '第一开头回休相交悬念'), null);
});

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

test('centered native captions crossing the half-frame boundary retain complete glyphs', () => {
  const native = line('这些问题你有没有遇到', { top: .483, bottom: .53, left: .407, right: .574, confidence: .5 });
  const selected = selectNativeSubtitle([native], '这些问题你有没有遇到');
  assert.ok(selected && selected.bandTop < native.top && selected.bandBottom > native.bottom);
  assert.equal(selectNativeSubtitle([native], '这些问题你有没有遇到', { bandTop: .5, bandBottom: .98 }), null, 'explicit crop remains strict');
  assert.equal(selectNativeSubtitle([line(native.text, { top: .2, bottom: .25 })], native.text), null, 'upper titles remain excluded by default');
});

test('adjacent transcript context corroborates a continuing caption only when current target is visibly complete', () => {
  const caption = line('你会感觉自己的思考缺乏深度，很难举一反三。', { top: .475, bottom: .534 });
  const current = '很难举一反三';
  const context = { targetText: current, adjacentText: '你会感觉自己的思考缺乏深度很难举一反三花很多时间阅读和做笔记整理' };
  assert.ok(selectNativeSubtitle([caption], current, {}, context));
  assert.equal(selectNativeSubtitle([line('你会感觉自己的思考缺乏深度', { top: .475, bottom: .534 })], current, {}, context), null, 'previous caption alone cannot verify the current target');
  assert.equal(selectNativeSubtitle([line('无关前文很难举一反三完全无关的额外内容')], current, {}, context), null, 'exact target alone does not bypass full-caption corroboration');
});
