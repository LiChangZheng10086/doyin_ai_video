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


test('article image placement and references preserve safe content with a quieter source hierarchy', () => {
  const html=renderWechatArticleHtml({title:'标题',sections:[{heading:'概念',paragraphs:['概念正文']},{heading:'按需读取',paragraphs:['加载正文']}]},
    {layoutTemplate:'business-brief',images:[{slot:1,afterSection:1,caption:'按需读取示意'}],references:['来源 <script>bad</script> https://example.com']});
  assert.ok(html.indexOf('加载正文')<html.indexOf('{{wechat-image-1}}'));
  assert.ok(html.includes('按需读取示意'));
  assert.ok(html.includes('font-size:13px'));
  assert.doesNotMatch(html,/<script>/);
  assert.throws(()=>renderWechatArticleHtml({title:'标题',sections:[]},{images:[{slot:1,afterSection:2}]}),/配图/);
});
