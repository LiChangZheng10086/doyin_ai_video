import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseWechatSearch, searchWechatArticles } from './wechat-search.js';

test('search returns source metadata with no invented traffic and rejects unsafe links', () => {
  const html = `<ul class="news-list"><li><h3><a href="/link?url=example">教程<em>步骤</em></a></h3><p class="txt-info">摘要</p><div class="s-p"><a class="account">示例号</a><span class="s2">2026-09-29</span></div></li><li><h3><a href="https://evil.example/x">外部</a></h3><a class="account">无效号</a></li></ul>`;
  const result = parseWechatSearch(html);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.title, '教程步骤');
  assert.equal(result[0]!.accountName, '示例号');
  assert.equal(result[0]!.dateText, '2026-09-29');
  assert.ok(!Object.hasOwn(result[0]!, 'reads'));
  assert.equal(parseWechatSearch('<div class="no-result">没有找到</div>').length, 0);
  assert.throws(() => parseWechatSearch('<form action="/antispider">请输入验证码</form>'), /验证码/);
  assert.throws(() => parseWechatSearch('<h1>不同结构的页面</h1>'), /结构/);
});

test('search uses a fixed public host, encoded keyword and one read', async () => {
  let called = '';
  const result = await searchWechatArticles('教程&安全', async url => { called = url; return '<div class="no-result">没有找到</div>'; });
  assert.equal(new URL(called).hostname, 'weixin.sogou.com');
  assert.equal(new URL(called).searchParams.get('query'), '教程&安全');
  assert.deepEqual(result, []);
});

test('current source uses a span account name and script timestamp without executing scripts', () => {
  const items = parseWechatSearch('<ul class="news-list"><li><h3><a href="/link?url=example">真实结构</a></h3><div class="s-p"><span class="all-time-y2">示例日报</span><span class="s2"><script>document.write(timeConvert(\'1790768895\'))</script></span></div></li></ul>');
  assert.equal(items.length,1);
  assert.equal(items[0]!.accountName,'示例日报');
  assert.ok(items[0]!.dateText.startsWith('2026-09-30'));
  assert.ok(!items[0]!.dateText.includes('document.write'));
});
