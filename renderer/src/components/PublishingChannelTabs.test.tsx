/**
 * 发布中心「渠道」页签的静态渲染用例。
 *
 * 守住三件事：三个渠道都在、计数只在有意义时显示、说明文案随选中渠道变化。
 * （页面级行为——切渠道只显示该渠道的包——在真浏览器里核对，见计划 Task 4。）
 */
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { test } from 'node:test';
import { PublishingChannelTabs } from './PublishingChannelTabs.js';
import { PUBLISH_CHANNELS } from '../utils/publishing.js';

const counts = { 'douyin-note': 2, 'toutiao-article': 0, 'video-manual': 5 } as const;

/** 取出某个页签按钮的标签本身（属性顺序不该影响断言）。 */
function buttonTag(html: string, testId: string): string {
  return html.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`, 'u'))?.[0] ?? '';
}

test('渠道页签渲染三个渠道，并标出当前选中项', () => {
  const html = renderToStaticMarkup(
    <PublishingChannelTabs active="toutiao-article" counts={{ ...counts }} onSelect={() => undefined} />,
  );

  for (const channel of PUBLISH_CHANNELS) {
    assert.match(html, new RegExp(channel.label, 'u'), `缺少渠道 ${channel.id}`);
  }
  // 选中态必须能被机器读出来（界面/用例都不该靠颜色判断）。
  assert.match(buttonTag(html, 'publish-channel-toutiao-article'), /aria-selected="true"/u);
  assert.match(buttonTag(html, 'publish-channel-douyin-note'), /aria-selected="false"/u);
  assert.match(buttonTag(html, 'publish-channel-video-manual'), /aria-selected="false"/u);
});

test('计数为 0 的渠道不显示数字（避免一排 0 干扰阅读）', () => {
  const html = renderToStaticMarkup(
    <PublishingChannelTabs active="douyin-note" counts={{ ...counts }} onSelect={() => undefined} />,
  );

  assert.match(html, /抖音图文[\s\S]{0,80}?2/u);
  assert.match(html, /视频人工交付[\s\S]{0,80}?5/u);
  assert.equal(/今日头条文章[\s\S]{0,120}?>0</u.test(html), false);
});

test('说明文案跟随选中渠道：头条说扫码登录，视频说不会自动上传', () => {
  const toutiao = renderToStaticMarkup(
    <PublishingChannelTabs active="toutiao-article" counts={{ ...counts }} onSelect={() => undefined} />,
  );
  assert.match(toutiao, /设置 → 今日头条/u);

  const video = renderToStaticMarkup(
    <PublishingChannelTabs active="video-manual" counts={{ ...counts }} onSelect={() => undefined} />,
  );
  assert.match(video, /不会自动上传/u);
});
