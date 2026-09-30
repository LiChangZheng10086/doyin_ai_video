import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderWechatArticleHtml } from './wechat-article.js';
import { WECHAT_LAYOUTS } from './wechat-templates.js';

test('trusted templates preserve content and image slots while input styles stay forbidden', () => {
  const draft = { title: '测试文章', sections: [{ heading: '步骤', paragraphs: ['<strong style="color:red" onclick="alert(1)">正文</strong><script>alert(2)</script>'] }] };
  const original = renderWechatArticleHtml(draft);
  assert.equal(renderWechatArticleHtml(draft, { layoutTemplate: 'default' }), original);
  for (const layout of WECHAT_LAYOUTS) {
    const html = renderWechatArticleHtml(draft, { layoutTemplate: layout.id, images: [{ slot: 1 }] });
    assert.ok(html.includes('正文') && html.includes('{{wechat-image-1}}'));
    assert.ok(!/onclick|<script|color:red|<style/.test(html));
  }
  assert.notEqual(renderWechatArticleHtml(draft, { layoutTemplate: 'minimal-read' }), original);
  assert.throws(() => renderWechatArticleHtml(draft, { layoutTemplate: 'unknown' }), /模板/);
});
