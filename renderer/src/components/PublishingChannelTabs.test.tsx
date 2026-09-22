/**
 * 发布中心「渠道」页签 + 「内容类型」子页签的静态渲染用例。
 *
 * 守住四件事：五个渠道都在、计数只在有意义时显示、说明文案随选中渠道变化、
 * 以及**子页签只在真的多于一种内容类型时才出现**（2026-09-21 改版的核心约定）。
 * （页面级行为——切渠道只显示该渠道的包、切换不把 URL 冲掉——在真浏览器里核对。）
 */
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { test } from 'node:test';
import { PublishingChannelTabs } from './PublishingChannelTabs.js';
import { PUBLISH_CHANNELS } from '../utils/publishing.js';

const counts = { douyin: 2, xiaohongshu: 0, toutiao: 1, 'wechat-mp': 0, other: 5 } as const;

/** 取出某个页签按钮的标签本身（属性顺序不该影响断言）。 */
function buttonTag(html: string, testId: string): string {
  return html.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`, 'u'))?.[0] ?? '';
}

function render(overrides: Partial<React.ComponentProps<typeof PublishingChannelTabs>> = {}) {
  return renderToStaticMarkup(
    <PublishingChannelTabs
      active="douyin"
      counts={{ ...counts }}
      contentTypes={[]}
      contentTypeCounts={{}}
      activeContentType=""
      onSelect={() => undefined}
      onSelectContentType={() => undefined}
      {...overrides}
    />,
  );
}

test('渠道页签渲染五个渠道，并标出当前选中项', () => {
  const html = render({ active: 'toutiao' });

  for (const channel of PUBLISH_CHANNELS) {
    assert.match(html, new RegExp(channel.label, 'u'), `缺少渠道 ${channel.id}`);
  }
  // 选中态必须能被机器读出来（界面/用例都不该靠颜色判断）。
  assert.match(buttonTag(html, 'publish-channel-toutiao'), /aria-selected="true"/u);
  assert.match(buttonTag(html, 'publish-channel-douyin'), /aria-selected="false"/u);
  assert.match(buttonTag(html, 'publish-channel-other'), /aria-selected="false"/u);
  // 「微信公众号」是用户要求先划分好的占位页签，必须真的在界面上。
  assert.match(html, /微信公众号/u);
  assert.match(html, /其它平台/u);
});

test('计数为 0 的渠道不显示数字（避免一排 0 干扰阅读）', () => {
  const html = render();

  assert.match(html, /抖音[\s\S]{0,80}?2/u);
  assert.match(html, /其它平台[\s\S]{0,80}?5/u);
  assert.equal(/微信公众号[\s\S]{0,120}?>0</u.test(html), false);
});

test('说明文案跟随选中渠道：头条说扫码登录，其它平台说明只能人工交付', () => {
  assert.match(render({ active: 'toutiao' }), /设置 → 今日头条/u);
  assert.match(render({ active: 'other' }), /不会自动上传/u);
  // 未接入的渠道必须明说，不能让人以为它已经在自动发布。
  assert.match(render({ active: 'wechat-mp' }), /尚未接入/u);
});

test('内容类型子页签：只有一种类型时不渲染（只含一项的选择是假选择）', () => {
  const html = render({ contentTypes: ['note'], contentTypeCounts: { note: 2 } });
  assert.equal(html.includes('role="tablist" aria-label="内容类型"'), false);
  assert.equal(html.includes('publish-content-type-note'), false);
});

test('内容类型子页签：多于一种时出现，默认停在「全部」且数字按类型分', () => {
  const html = render({
    contentTypes: ['note', 'video'],
    contentTypeCounts: { note: 2, video: 1 },
    activeContentType: '',
  });

  assert.match(html, /aria-label="内容类型"/u);
  // 默认选中「全部」，数字是各类型之和。
  assert.match(buttonTag(html, 'publish-content-type-all'), /aria-selected="true"/u);
  assert.match(html, /全部[\s\S]{0,40}?3/u);
  assert.match(buttonTag(html, 'publish-content-type-note'), /aria-selected="false"/u);
  assert.match(html, /图文[\s\S]{0,40}?2/u);
  assert.match(html, /视频[\s\S]{0,40}?1/u);

  // 选中某个类型时，选中态跟着走（靠 `aria-selected`，不靠颜色）。
  const picked = render({
    contentTypes: ['note', 'video'],
    contentTypeCounts: { note: 2, video: 1 },
    activeContentType: 'video',
  });
  assert.match(buttonTag(picked, 'publish-content-type-video'), /aria-selected="true"/u);
  assert.match(buttonTag(picked, 'publish-content-type-all'), /aria-selected="false"/u);
});

test('内容类型子页签：文章渠道的标签是「文章」而不是「图文」', () => {
  const html = render({
    active: 'toutiao',
    contentTypes: ['article', 'video'],
    contentTypeCounts: { article: 1, video: 0 },
  });
  assert.match(html, /文章/u);
  // 文章渠道里不该出现「图文」这个标签（note 不在它的类型里）。
  assert.equal(html.includes('publish-content-type-note'), false);
});
