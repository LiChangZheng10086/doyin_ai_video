import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RuntimeItem, RuntimeState } from '../types/index.js';
import {
  checkStatusLabel,
  compactAllReadyLabel,
  formatAge,
  formatElapsed,
  isRuntimeChannel,
  runtimeCheckExpectation,
  runtimeStateMeta,
  runningCheckLabel,
  verifiedLabel,
  visibleItems,
} from './runtime.js';

const NOW = new Date('2026-09-22T02:00:00.000Z');
const ALL_STATES: RuntimeState[] = ['ready', 'degraded', 'blocked', 'unknown'];

function item(overrides: Partial<RuntimeItem> = {}): RuntimeItem {
  return {
    id: 'douyin',
    label: '抖音',
    state: 'degraded',
    detail: '凭据已存在，有效性未知。',
    ...overrides,
  };
}

test('四态都有「图标 + 文字」，且四个状态词的集合是封闭的', () => {
  const metas = ALL_STATES.map((state) => runtimeStateMeta(state));
  for (const meta of metas) {
    assert.ok(meta.label.length > 0, '必须同时给文字 —— 状态不能只靠颜色表达（spec §5.1）');
    assert.ok(['check', 'warn', 'x', 'help'].includes(meta.icon));
    assert.ok(['success', 'warning', 'danger', 'subtle'].includes(meta.tone));
  }
  assert.deepEqual(metas.map((meta) => meta.label), ['就绪', '待确认', '不可用', '未知']);
});

test('⚠️ INV-1：渲染层的默认文案不含「已登录」（免费层不谈登录）', () => {
  for (const state of ALL_STATES) {
    assert.doesNotMatch(runtimeStateMeta(state).label, /已登录/u);
  }
  assert.doesNotMatch(compactAllReadyLabel(), /已登录/u);
});

test('formatElapsed：秒 / 分秒两档，且**绝不含百分比**（INV-5）', () => {
  assert.equal(formatElapsed(42_000), '已运行 42 秒');
  assert.equal(formatElapsed(0), '已运行 0 秒');
  assert.equal(formatElapsed(65_000), '已运行 1 分 5 秒');
  assert.equal(formatElapsed(undefined), '已运行 0 秒');
  for (const ms of [0, 999, 42_000, 300_000]) {
    assert.doesNotMatch(formatElapsed(ms), /%/u, '拿不到中间进度就不许编一个百分比');
  }
});

test('抖音的耗时预期是「事实」不是估计（最坏 5 分钟来自 CHECK_TIMEOUT_MS）', () => {
  assert.equal(runtimeCheckExpectation('douyin'), '通常 10–30 秒，最坏 5 分钟');
  assert.match(runtimeCheckExpectation('toutiao'), /十几秒/u);
  assert.equal(runningCheckLabel({ id: 'douyin', elapsedMs: 42_000 }), '已运行 42 秒 · 通常 10–30 秒，最坏 5 分钟');
});

test('visibleItems：compact 只显示非 ready；全绿时返回空（调用方渲染「环境正常」）', () => {
  const items = [
    item({ id: 'douyin', state: 'ready' }),
    item({ id: 'toutiao', state: 'degraded' }),
    item({ id: 'ffmpeg', state: 'ready' }),
  ];
  assert.deepEqual(visibleItems(items, 'compact').map((entry) => entry.id), ['toutiao']);
  assert.deepEqual(visibleItems(items, 'full').map((entry) => entry.id), ['douyin', 'toutiao', 'ffmpeg']);

  const allReady = [item({ id: 'douyin', state: 'ready' })];
  assert.deepEqual(visibleItems(allReady, 'compact'), []);
  assert.deepEqual(visibleItems(allReady, 'full').length, 1, 'full 下全绿也要显示');
});

test('isRuntimeChannel：只有三个渠道有「登录态」可验', () => {
  assert.equal(isRuntimeChannel('douyin'), true);
  assert.equal(isRuntimeChannel('toutiao'), true);
  assert.equal(isRuntimeChannel('xiaohongshu'), true);
  assert.equal(isRuntimeChannel('ffmpeg'), false);
  assert.equal(isRuntimeChannel('storage'), false);
});

test('⚠️ verifiedLabel 是**唯一**能说「有效」的地方，且必须带时间戳', () => {
  assert.equal(verifiedLabel({}, NOW), undefined, '没有记录时什么都不说');
  assert.equal(
    verifiedLabel({ verified: { state: 'valid', at: new Date(NOW.getTime() - 2 * 3600_000).toISOString() } }, NOW),
    '2 小时前 · 登录态有效',
  );
  assert.equal(
    verifiedLabel({ verified: { state: 'invalid', at: new Date(NOW.getTime() - 90_000).toISOString() } }, NOW),
    '1 分钟前 · 登录态已失效',
  );
});

test('formatAge 四档 + 时间无法解析时不编造', () => {
  assert.equal(formatAge(new Date(NOW.getTime() - 10_000).toISOString(), NOW), '刚刚');
  assert.equal(formatAge(new Date(NOW.getTime() - 300_000).toISOString(), NOW), '5 分钟前');
  assert.equal(formatAge(new Date(NOW.getTime() - 7200_000).toISOString(), NOW), '2 小时前');
  assert.equal(formatAge(new Date(NOW.getTime() - 3 * 86_400_000).toISOString(), NOW), '3 天前');
  assert.equal(formatAge('不是时间', NOW), '时间未知');
});

test('checkStatusLabel 四态都有中文', () => {
  assert.equal(checkStatusLabel('running'), '检测中');
  assert.equal(checkStatusLabel('succeeded'), '已完成');
  assert.equal(checkStatusLabel('cancelled'), '已取消');
  assert.equal(checkStatusLabel('failed'), '未完成');
});
