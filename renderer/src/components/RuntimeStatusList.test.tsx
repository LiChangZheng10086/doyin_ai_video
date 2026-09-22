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

  // 两处都必须出现全部 5 项 —— 同一份模型，只是呈现尺寸不同（AC-1：桌面端一眼看到五项）
  for (const label of ['抖音', '今日头条', '小红书', 'ffmpeg', '存储目录']) {
    assert.match(full, new RegExp(label), `full 缺 ${label}`);
    assert.match(compact, new RegExp(label), `compact 缺 ${label}`);
  }
  // compact 的「就绪」项带窄屏隐藏类（桌面端仍显示，窄屏收起）—— 过滤交给 CSS，不是 JS
  assert.match(compact, /hidden md:block/);
  assert.doesNotMatch(full, /hidden md:block/, 'full 不该有窄屏收起这一层');
});

test('blocked 项的每一行可照抄动作都在 **full** 下渲染出来', () => {
  const items = fiveItems();
  const lines = items[2].guidance!;
  const markup = render(<RuntimeStatusList items={items} variant="full" now={NOW} />);
  for (const line of lines) {
    assert.ok(markup.includes(line), `full 少了这一行：${line}`);
  }
});

test('⚠️ compact 概览条**不**摊开可照抄动作 —— 否则一条 blocked 就把概览条撑成半屏', () => {
  const items = fiveItems();
  const markup = render(<RuntimeStatusList items={items} variant="compact" now={NOW} />);

  for (const line of items[2].guidance!) {
    assert.ok(!markup.includes(line), `compact 不该渲染命令：${line}`);
  }
  // 但"发不出去"这件事本身必须说清楚，命令去设置页看
  assert.match(markup, /没有可用的浏览器/u);
  assert.match(markup, /小红书/u);
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

test('全绿时 compact 在**窄屏**收成一行「环境正常」（桌面端仍列出各项）', () => {
  const allReady: RuntimeItem[] = [
    { id: 'douyin', label: '抖音', state: 'ready', detail: '凭据已存在，有效性未知。' },
    { id: 'ffmpeg', label: 'ffmpeg', state: 'ready', detail: '就绪。' },
  ];
  const markup = render(<RuntimeStatusList items={allReady} variant="compact" now={NOW} />);

  assert.match(markup, /环境正常/);
  assert.match(markup, /md:hidden/, '那一行只在窄屏出现');
  // 桌面端仍然列出各项（否则 AC-1「一眼看到五项」不成立）
  assert.match(markup, /data-runtime-item="douyin"/);
  assert.match(markup, /data-runtime-item="ffmpeg"/);
});

test('full 下逐层诊断默认收起，展开可见 attempt 与 errno', () => {
  const markup = render(<RuntimeStatusList items={fiveItems()} variant="full" now={NOW} />);
  assert.match(markup, /<details/);
  assert.match(markup, /逐层诊断/);
  assert.match(markup, /config ✕ 未配置 XHS_BROWSER_BINARY/);
});
