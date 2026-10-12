import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOTSPOT_SOURCES, fetchHotspotSource, parseHotspotSource, validHotspotItem } from './hotspot-sources.js';

const rssItem = (link: string, date = '2026-10-10T10:00:00Z', title = 'Official &amp; AI') => `<item><title>${title}</title><link>${link}</link><pubDate>${date}</pubDate><description><![CDATA[<p>Original <b>summary</b></p><script>bad()</script>]]></description></item>`;
const rss = (items: string) => `<?xml version="1.0"?><rss version="2.0"><channel>${items}</channel></rss>`;

test('official RSS sorts by publication time, keeps stable URL IDs, plain summaries and no invented heat', () => {
  const newer = rssItem('https://openai.com/index/new/', '2026-10-11T10:00:00Z');
  const items = parseHotspotSource('openai', rss(rssItem('https://openai.com/index/old/') + newer + newer));
  assert.equal(items.length, 2);
  assert.equal(items[0].itemId, 'https://openai.com/index/new/');
  assert.equal(items[0].title, 'Official & AI');
  assert.equal(items[0].summary, 'Original summary');
  assert.equal(items[0].publishedAt, '2026-10-11T10:00:00.000Z');
  assert.deepEqual(items.map(item => item.rank), [1, 2]);
  assert.ok(items.every(item => !item.heat));
  assert.equal(HOTSPOT_SOURCES.filter(source => !('category' in source)).length, 5);
});

test('Atom chooses alternate article links and original published time rather than update time', () => {
  const items = parseHotspotSource('deepmind', '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>HF</title><link rel="self" href="https://deepmind.google/api/entry"/><link rel="alternate" href="https://deepmind.google/blog/article"/><published>2026-10-10T18:00:00+08:00</published><updated>2026-10-12T10:00:00Z</updated><summary type="html">&lt;p&gt;Hello&lt;/p&gt;</summary></entry></feed>');
  assert.equal(items[0].url, 'https://deepmind.google/blog/article');
  assert.equal(items[0].publishedAt, '2026-10-10T10:00:00.000Z');
  assert.equal(items[0].summary, 'Hello');
});

test('RSS rejects DTD, challenge pages, missing dates, unsafe/off-domain links and invalid persisted metadata', () => {
  for (const raw of ['<!DOCTYPE rss SYSTEM "file:///etc/passwd">' + rss(rssItem('https://openai.com/index/a/')), '<html>Verify</html>', rss(rssItem('http://openai.com/a')), rss(rssItem('https://openai.com.evil.example/a')), rss(rssItem('https://user:pass@openai.com/a')), rss(rssItem('https://openai.com/a', 'not a date')), rss(rssItem('https://openai.com/a').replace(/<pubDate>.*?<\/pubDate>/, ''))]) assert.throws(() => parseHotspotSource('openai', raw));
  const valid = { sourceId: 'openai', itemId: 'https://openai.com/a', title: 'Article', url: 'https://openai.com/a', rank: 1, publishedAt: '2026-10-10T10:00:00.000Z' };
  assert.equal(validHotspotItem(valid, 'openai'), true);
  assert.equal(validHotspotItem({ ...valid, publishedAt: undefined }, 'openai'), false);
  assert.equal(validHotspotItem({ ...valid, heat: '100' }, 'openai'), false);
  const items = parseHotspotSource('openai', rss(Array.from({length: 120}, (_, i) => rssItem(`https://openai.com/a/${i}`)).join('')));
  assert.equal(items.length, 100);
});

test('official RSS fetch uses fixed source, bounded XML response, no cookies and no redirects', async () => {
  const items = await fetchHotspotSource('openai', async (url, init) => {
    assert.equal(String(url), 'https://openai.com/news/rss.xml');
    assert.equal(init?.redirect, 'error'); assert.ok(init?.signal);
    assert.equal(new Headers(init?.headers).get('cookie'), null);
    assert.equal(new Headers(init?.headers).get('user-agent'), 'Mozilla/5.0');
    return new Response(rss(rssItem('https://openai.com/a')));
  });
  assert.equal(items.length, 1);
  await fetchHotspotSource('microsoft-research', async (_url, init) => {
    assert.equal(new Headers(init?.headers).get('user-agent'), null);
    return new Response(rss(rssItem('https://www.microsoft.com/en-us/research/blog/qa/')));
  });
  await assert.rejects(fetchHotspotSource('openai', async () => new Response('x'.repeat(1024 * 1024 + 1))));
});

test('five upstream formats keep ranking, original heat and links without mixing platform metrics', () => {
  const fixtures: [string, unknown, string, string][] = [
    ['douyin', { data: { word_list: [{ sentence_id: '123', word: '抖音话题', hot_value: 900 }] } }, '抖音话题', 'https://www.douyin.com/hot/123'],
    ['zhihu', { data: [{ target: { title_area: { text: '知乎问题' }, metrics_area: { text: '800 万热度' }, link: { url: 'https://www.zhihu.com/question/123' } } }] }, '知乎问题', 'https://www.zhihu.com/question/123'],
    ['bilibili', { code: 0, list: [{ keyword: 'B站话题', show_name: 'B站话题', heat_score: 32 }] }, 'B站话题', 'https://search.bilibili.com/all?keyword=B%E7%AB%99%E8%AF%9D%E9%A2%98'],
    ['baidu', `<!--s-data:${JSON.stringify({ data: { cards: [{ content: [{ isTop: true, word: '置顶', rawUrl: 'https://www.baidu.com/s?wd=top' }, { word: '百度话题', rawUrl: 'https://www.baidu.com/s?wd=news', hotScore: '123' }] }] } })}-->`, '百度话题', 'https://www.baidu.com/s?wd=news'],
    ['toutiao', { data: [{ ClusterIdStr: '123', Title: '头条话题', HotValue: '456' }] }, '头条话题', 'https://www.toutiao.com/trending/123/'],
  ];
  for (const [source, payload, title, url] of fixtures) {
    const items = parseHotspotSource(source, payload);
    assert.equal(items.length, 1); assert.equal(items[0].title, title); assert.equal(items[0].url, url); assert.equal(items[0].rank, 1);
  }
  assert.equal(parseHotspotSource('zhihu', fixtures[1][1])[0].heat, '800 万热度');
});

test('stored item IDs must be strings rather than coercible values', () => {
  assert.equal(validHotspotItem({ sourceId: 'toutiao', itemId: 123, title: '标题', url: 'https://www.toutiao.com/trending/123/', rank: 1 }, 'toutiao'), false);
});

test('empty, challenge pages, wrong structures and unsafe links fail closed', () => {
  for (const payload of ['', '<html>请登录</html>', { data: [] }, { data: [{ target: { title_area: { text: '危险' }, link: { url: 'javascript:alert(1)' } } }] },
    { data: [{ target: { title_area: { text: '伪造' }, link: { url: 'https://evil.example/question/1' } } }] }]) {
    assert.throws(() => parseHotspotSource('zhihu', payload));
  }
  assert.throws(() => parseHotspotSource('../config', {}));
});

test('invalid entries are skipped without changing original ranks, duplicates removed and output bounded', () => {
  const data = [{ ClusterIdStr: '', Title: '缺ID' }, { ClusterIdStr: '1', Title: '第一条' }, { ClusterIdStr: '1', Title: '重复' }, ...Array.from({ length: 150 }, (_, i) => ({ ClusterIdStr: String(i + 2), Title: `条目${i}` }))];
  const items = parseHotspotSource('toutiao', { data });
  assert.equal(items.length, 100); assert.equal(items[0].rank, 2); assert.equal(items[0].title, '第一条');
});

test('fetch rejects HTTP errors, oversized streams and upstream invalid JSON', async () => {
  for (const response of [new Response('blocked', { status: 403 }), new Response('x'.repeat(1024 * 1024 + 1)), new Response('not json')]) {
    await assert.rejects(fetchHotspotSource('toutiao', async () => response));
  }
});

test('douyin uses only current anonymous cookie and never follows redirects', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const items = await fetchHotspotSource('douyin', async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith('https://login.douyin.com')) return new Response('', { headers: { 'set-cookie': 'anonymous=example-token; Path=/; HttpOnly' } });
    assert.equal(new Headers(init?.headers).get('cookie'), 'anonymous=example-token');
    return Response.json({ data: { word_list: [{ sentence_id: '123', word: '话题' }] } });
  });
  assert.equal(items[0].title, '话题'); assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.init?.redirect === 'error' && call.init.signal));
});
