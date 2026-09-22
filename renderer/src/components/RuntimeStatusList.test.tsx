import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RuntimeCheckSummary, RuntimeItem } from '../types/index.js';
import { RuntimeStatusList } from './RuntimeStatusList.js';

const NOW = new Date('2026-09-22T02:00:00.000Z');
const noop = () => {};

/** 五项的完整模型 —— 概览条与运行环境**共用同一份**（这是本设计的核心主张）。 */
function fiveItems(): RuntimeItem[] {
  return [
    { id: 'douyin', label: '抖音', state: 'degraded', detail: '凭据已存在，有效性未知。' },
    { id: 'toutiao', label: '今日头条', state: 'ready', detail: '凭据已存在，有效性未知。', verified: { state: 'valid', at: new Date(NOW.getTime() - 2 * 3600_000).toISOString() } },
    {
      id: 'xiaohongshu',
      label: '小红书',
      state: 'blocked',
      detail: '没有可用的浏览器。',
      guidance: ['① 运行 npm run prepare:package:mac', '② 或运行 npx playwright install chromium', '③ 或用 XHS_BROWSER_BINARY 指定路径'],
      action: { kind: 'login', target: 'xiaohongshu' },
      evidence: {
        paths: [{ label: '会话目录', value: '/storage/xhs/profile' }],
        attempts: [{ layer: 'config', ok: false, detail: '未配置 XHS_BROWSER_BINARY' }],
      },
    },
    { id: 'ffmpeg', label: 'ffmpeg', state: 'ready', detail: '就绪。' },
    { id: 'storage', label: '存储目录', state: 'ready', detail: '可写。' },
  ];
}

function runningCheck(): RuntimeCheckSummary {
  return {
    checkId: 'check-1',
    id: 'douyin',
    status: 'running',
    startedAt: NOW.toISOString(),
    elapsedMs: 42_000,
    detail: '检测中。',
  };
}

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

test('⚠️ 一个组件两种尺寸：compact 与 full 渲染的是同一份模型', () => {
  const items = fiveItems();
  const full = render(<RuntimeStatusList items={items} variant="full" now={NOW} />);
  const compact = render(<RuntimeStatusList items={items} variant="compact" now={NOW} />);

  // 两处都必须出现全部 5 项（compact 只是**过滤 ready**，不是换一套数据源）
  for (const label of ['抖音', '今日头条', '小红书', 'ffmpeg', '存储目录']) {
    assert.match(full, new RegExp(label), `full 缺 ${label}`);
  }
  for (const label of ['抖音', '小红书']) {
    assert.match(compact, new RegExp(label), `compact 缺非 ready 的 ${label}`);
  }
  // full 显示 ready 的项，compact 不显示（避免发布现场摆一排绿点）
  assert.match(full, /ffmpeg/);
  assert.doesNotMatch(compact, /存储目录/);
});

test('blocked 项的每一行可照抄动作都渲染出来（两种尺寸都渲染）', () => {
  const items = fiveItems();
  const lines = items[2].guidance!;
  for (const variant of ['compact', 'full'] as const) {
    const markup = render(<RuntimeStatusList items={items} variant={variant} now={NOW} />);
    for (const line of lines) {
      assert.ok(markup.includes(line), `${variant} 少了这一行：${line}`);
    }
  }
});

test('⚠️ INV-1：没有 verified 时不出现任何有效性字样；有 verified 时必须带时间戳', () => {
  const markup = render(<RuntimeStatusList items={fiveItems()} variant="full" now={NOW} />);

  assert.doesNotMatch(markup, /已登录/u, '免费层文案永远不许说「已登录」');
  assert.match(markup, /2 小时前 · 登录态有效/u, 'approved 的呈现：带时间戳的结论');

  // 抖音那条没有 verified → 整行不能出现「登录态有效」
  const douyinRow = markup.slice(markup.indexOf('data-runtime-item="douyin"'));
  const douyinEnd = douyinRow.indexOf('data-runtime-item="toutiao"');
  assert.doesNotMatch(douyinRow.slice(0, douyinEnd === -1 ? undefined : douyinEnd), /登录态有效/u);
});

test('检测中：显示已运行秒数 + 耗时区间 + 取消入口，**且没有百分比**（INV-5）', () => {
  const markup = render(
    <RuntimeStatusList items={fiveItems()} variant="full" check={runningCheck()} now={NOW} onCancel={noop} />,
  );

  assert.match(markup, /检测中/);
  assert.match(markup, /已运行 42 秒 · 通常 10–30 秒，最坏 5 分钟/);
  assert.match(markup, /取消检测/);
  assert.doesNotMatch(markup, /%/u, '拿不到中间进度就不许编一个百分比');
  assert.match(markup, /取不到中间进度/u, '要如实说明为什么没有进度');
});

test('动作按钮：compact 不给「验证登录态」，full 给；「去登录」两处都只在渠道行出现', () => {
  const items = fiveItems();
  const full = render(<RuntimeStatusList items={items} variant="full" now={NOW} onLogin={noop} onVerify={noop} />);
  const compact = render(<RuntimeStatusList items={items} variant="compact" now={NOW} onLogin={noop} onVerify={noop} />);

  assert.match(full, /验证登录态/);
  assert.doesNotMatch(compact, /验证登录态/, '概览条只做概览，深检动作留在设置页');
  assert.match(full, /去登录/);
  assert.match(compact, /去登录/);

  // ffmpeg 行没有「去登录」（它没有登录态）
  const ffmpegRow = full.slice(full.indexOf('data-runtime-item="ffmpeg"'));
  assert.doesNotMatch(ffmpegRow.slice(0, ffmpegRow.indexOf('</li>')), /去登录/u);
});

test('全绿时 compact 收成一行「环境正常」', () => {
  const allReady: RuntimeItem[] = [
    { id: 'douyin', label: '抖音', state: 'ready', detail: '凭据已存在，有效性未知。' },
    { id: 'ffmpeg', label: 'ffmpeg', state: 'ready', detail: '就绪。' },
  ];
  const markup = render(<RuntimeStatusList items={allReady} variant="compact" now={NOW} />);
  assert.match(markup, /环境正常/);
  assert.doesNotMatch(markup, /data-runtime-item/u);
});

test('full 下逐层诊断默认收起，展开可见 attempt 与 errno', () => {
  const markup = render(<RuntimeStatusList items={fiveItems()} variant="full" now={NOW} />);
  assert.match(markup, /<details/);
  assert.match(markup, /逐层诊断/);
  assert.match(markup, /config ✕ 未配置 XHS_BROWSER_BINARY/);
});
