import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseResearchContent, parseExaCandidates } from './research-content.js';

const prose = '这份公开报道解释项目推出的新功能，并介绍适用范围和仍需验证的问题。'.repeat(12);
test('article containers are evidence; topic/search/question pages only offer candidates', () => {
  const article = parseResearchContent({url:'https://news.example.com/article/1',provider:'direct',format:'html',body:`<title>功能报道</title><article><p>${prose}</p></article>`});
  assert.equal(article.kind,'article'); assert.equal(article.text,prose); assert.equal(article.status,'readable');
  const topic = parseResearchContent({url:'https://www.toutiao.com/trending/123/',provider:'jina',format:'markdown',body:`Title: 热点\n\nMarkdown Content:\n## 事件详情\n${prose}\n[相关报道标题](https://www.toutiao.com/article/456/)`});
  assert.equal(topic.kind,'topic'); assert.equal(topic.text,''); assert.equal(topic.candidates[0]?.url,'https://www.toutiao.com/article/456/');
  assert.equal(parseResearchContent({url:'https://www.zhihu.com/question/123',provider:'jina',format:'markdown',body:`Title: 问题\n\nMarkdown Content:\n${prose}`}).status,'needs_material');
});
test('target 403, login and navigation text cannot be imported; unsafe links are removed', () => {
  const auth=parseResearchContent({url:'https://news.example.com/article/1',provider:'jina',format:'markdown',body:'Title: Access Denied\nMarkdown Content:\nPlease sign in to view this content. Verify you are human before continuing. Complete the CAPTCHA to access our website. This security check protects the website from automated traffic. '.repeat(4)});
  assert.equal(auth.status,'needs_material');assert.equal(auth.error?.code,'blocked');
  const failed=parseResearchContent({url:'https://news.example.com/article/1',provider:'jina',format:'markdown',body:`Title: 新闻\nWarning: Target URL returned error 403: Forbidden\nMarkdown Content:\n${prose}`});
  assert.equal(failed.kind,'unreadable'); assert.equal(failed.text,''); assert.equal(failed.error?.code,'blocked');
  const nav=parseResearchContent({url:'https://news.example.com/article/1',provider:'jina',format:'markdown',body:`Title: 登录\nMarkdown Content:\n${prose}`});assert.equal(nav.text,'');
  const topic=parseResearchContent({url:'https://www.baidu.com/s?wd=test',provider:'jina',format:'markdown',body:'Title: 搜索\nMarkdown Content:\n[新闻报道标题](javascript:alert(1))\n[新闻报道标题](https://127.0.0.1/x)'});
  assert.deepEqual(topic.candidates,[]);
});
test('body truncation and structured search results preserve source dates; unknown output fails', () => {
  const read=parseResearchContent({url:'https://news.example.com/article/1',provider:'jina',format:'markdown',body:`Title: 新闻\nMarkdown Content:\n${prose.repeat(80)}`});
  assert.equal(read.text.length,20000);assert.equal(read.truncated,true);assert.equal(read.publishedAt,undefined);
  const rows=parseExaCandidates({structuredContent:{results:[{title:'报道',url:'https://news.example.com/a',publishedDate:'2026-10-08T00:00:00Z',text:prose.repeat(4)}]}});
  assert.equal(rows.length,1);assert.equal(rows[0].snippet?.length,1000);assert.equal(rows[0].publishedAt,'2026-10-08T00:00:00Z');
  assert.throws(()=>parseExaCandidates({content:[{type:'text',text:'上游格式变化'}]}),/格式/);
  assert.throws(()=>parseExaCandidates({structuredContent:{results:[{headline:'changed',link:'https://news.example.com/a'}]}}),/格式/);
  assert.deepEqual(parseExaCandidates({structuredContent:{results:[]}}),[]);
  const mixed=parseExaCandidates({content:[{type:'text',text:'Title: 公开报道\nURL: https://news.example.com/a\nPublished: N/A\nAuthor: 测试\nHighlights:\n来源摘录。\n\nTitle: 非HTTPS来源\nURL: http://news.example.com/b\nPublished: N/A\nHighlights:\n另一份摘录。'}]});assert.equal(mixed.length,1);
  const missing=parseResearchContent({url:'https://news.example.com/a',provider:'jina',format:'markdown',body:`Title: News\nWarning: Target URL returned error 404: Not Found\nMarkdown Content:\n${prose}`});assert.equal(missing.kind,'unreadable');
});
