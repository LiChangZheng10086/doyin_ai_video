/**
 * 头条登录面板的静态渲染用例。
 *
 * 本项目吃过「元素存在 ≠ 图上屏」的亏（图文预览的破图），所以这里**断言 `<img>` 的 src 形状**
 * 而不是只断言元素数量：二维码必须是后端下发的 data URL，否则界面上会是一个破图框。
 */
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { test } from 'node:test';
import { ToutiaoLoginPanel } from './ToutiaoLoginPanel.js';

test('登录面板默认渲染「扫码登录」与「校验登录」两个入口', () => {
  const html = renderToStaticMarkup(<ToutiaoLoginPanel />);

  assert.match(html, /扫码登录/u);
  assert.match(html, /校验登录/u);
  // 未开始扫码时不渲染二维码图片（避免显示一个空的 img）。
  assert.equal(html.includes('data-testid="toutiao-qr"'), false);
  assert.match(html, /不会弹出窗口/u);
});
