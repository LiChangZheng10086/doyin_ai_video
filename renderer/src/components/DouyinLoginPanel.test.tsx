import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DouyinLoginPanel } from './DouyinLoginPanel.js';

test('抖音默认提供应用内扫码，浏览器扫码只作独立备用入口', () => {
  const html = renderToStaticMarkup(<DouyinLoginPanel />);
  assert.match(html, /data-testid="douyin-login-panel"/);
  assert.match(html, />扫码登录<\/button>/);
  assert.match(html, />打开浏览器扫码登录<\/button>/);
  assert.equal(html.includes('data-testid="douyin-qr"'), false);
  assert.match(html, /二维码显示在本页/);
});
