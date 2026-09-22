/**
 * 小红书登录面板的静态渲染用例。
 *
 * 与头条面板共用同一份实现（`QrLoginPanel`），所以这里守的是**小红书特有的那两件事**：
 * ① 入口齐全（扫码 / 打开浏览器窗口 / 校验登录）；
 * ② 文案必须写清「只做发布、不读取不互动」与「风险自负」—— 这两句是产品承诺，不是装饰。
 */
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { test } from 'node:test';
import { XhsLoginPanel } from './XhsLoginPanel.js';

test('小红书面板渲染三个入口，且未开始扫码时不渲染二维码', () => {
  const html = renderToStaticMarkup(<XhsLoginPanel />);

  assert.match(html, /扫码登录/u);
  assert.match(html, /打开浏览器扫码登录/u);
  assert.match(html, /校验登录/u);
  // 未开始扫码时不渲染空的 <img>（本项目吃过「元素在但图是破的」的亏）。
  assert.equal(html.includes('data-testid="xhs-qr"'), false);
  assert.equal(html.includes('data-testid="xhs-login-panel"'), true);
});

test('小红书面板写明「只做发布、不读取不互动」与风险自负', () => {
  const html = renderToStaticMarkup(<XhsLoginPanel />);
  assert.match(html, /只做发布/u);
  assert.match(html, /不读取你的笔记、不搜索、不评论、不点赞收藏/u);
  assert.match(html, /风险由你的账号承担/u);
  // 登录态不许落到 storage 之外（与后端那条约束同一口径，文案也要说清）。
  assert.match(html, /不会离开 storage/u);
});
