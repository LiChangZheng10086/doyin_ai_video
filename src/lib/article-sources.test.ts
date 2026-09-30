import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractArticlePage, resolveArticleAddress, readArticleSource } from './article-sources.js';

const prose = '公开材料说明了项目的具体变化，保留事实、日期和条件，方便读者核对原始依据。'.repeat(10);

test('extracts actual article text and leaves scripts outside the material', () => {
  const page = extractArticlePage(`<title>原始报道</title><nav>菜单</nav><article><h1>原始报道</h1><p>${prose}</p><script>执行发布</script></article>`, 'https://example.com/story');
  assert.equal(page.title, '原始报道');
  assert.ok(page.text.includes(prose));
  assert.ok(!page.text.includes('执行发布'));
  assert.ok(!page.text.includes('菜单'));
});

test('search pages provide candidates but never invented article text', () => {
  const page = extractArticlePage('<title>搜索结果</title><main><a href="/article/123">项目变化的完整报道</a></main>', 'https://example.com/search');
  assert.equal(page.text, '');
  assert.equal(page.links[0]?.url, 'https://example.com/article/123');
});

test('reads embedded article evidence and flags truncation', () => {
  const html = `<script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', headline: '报道', datePublished: '2026-09-30', articleBody: prose.repeat(100) })}</script>`;
  const page = extractArticlePage(html, 'https://example.com/story');
  assert.equal(page.text.length, 20000);
  assert.equal(page.truncated, true);
  assert.equal(page.publishedAt, '2026-09-30');
});

test('rejects unsafe URL forms before DNS lookup and rejects mixed DNS results', async () => {
  for (const url of ['http://example.com', 'https://127.0.0.1', 'https://[::1]', 'https://localhost', 'https://example.com:444', 'https://user:pass@example.com']) {
    await assert.rejects(resolveArticleAddress(url), /公开 HTTPS/);
  }
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.2', '::1', 'fc00::1', '2001:db8::1', '::ffff:127.0.0.1']) {
    await assert.rejects(resolveArticleAddress('https://example.com/story', async () => [{ address, family: address.includes(':') ? 6 : 4 }]), /公网/);
  }
  await assert.rejects(resolveArticleAddress('https://example.com', async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }]), /公网/);
  assert.equal((await resolveArticleAddress('https://example.com', async () => [{ address: '93.184.216.34', family: 4 }])).address, '93.184.216.34');
});

test('network failure and unreadable pages return explicit material-needed results', async () => {
  const failed = await readArticleSource('https://example.com/story', async () => { throw new Error('network'); });
  assert.equal(failed.status, 'needs_material');
  const empty = await readArticleSource('https://example.com/search', async () => '<title>登录</title><p>请登录</p>');
  assert.equal(empty.status, 'needs_material');
  assert.equal(empty.text, '');
  const huge = await readArticleSource('https://example.com/story', async () => 'a'.repeat(2 * 1024 * 1024 + 1));
  assert.equal(huge.status, 'needs_material');
});

test('long search snippets and access challenges are never article evidence', () => {
  for (const html of [`<title>搜索结果</title><main><p>${prose}</p><p>${prose}</p></main>`, `<title>安全验证</title><article><p>${prose}</p></article>`]) {
    assert.equal(extractArticlePage(html, 'https://example.com/search?q=change').text, '');
  }
});

test('ignores article markup embedded in scripts and comments', () => {
  for (const markup of [`<script>const template='<article><p>${prose}</p></article>';</script>`, `<!-- <article><p>${prose}</p></article> -->`]) assert.equal(extractArticlePage(`<title>登录</title>${markup}`,'https://example.com/login').text,'');
});
test('supported source search URL shapes never supply article evidence', () => {
  for (const url of ['https://search.bilibili.com/all?keyword=test','https://www.baidu.com/s?wd=test','https://www.zhihu.com/question/123','https://www.toutiao.com/trending/123/']) assert.equal(extractArticlePage(`<title>内容列表</title><main><p>${prose}</p></main>`,url).text,'');
});
test('non-global IPv6 special ranges are rejected', async () => {
  for (const address of ['2001:2::1','2001:20::1','3fff::1']) await assert.rejects(resolveArticleAddress('https://example.com',async () => [{address,family:6}]),/公网/);
});
