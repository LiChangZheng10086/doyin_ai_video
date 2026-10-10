import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseArticleInput,recommendArticleLayout} from './article-input.js';
test('automatic input keeps complete text, distinguishes URLs and ideas, and rejects unsafe links',()=>{
 const body='项目支持导出，离线编辑仍未开放。'.repeat(80);
 assert.equal(parseArticleInput(body).text,body);assert.equal(parseArticleInput(body).kind,'text');
 assert.equal(parseArticleInput('想写一篇关于离线编辑的文章').kind,'idea');
 assert.deepEqual(parseArticleInput('https://example.com/article').urls,['https://example.com/article']);
 const mixed=parseArticleInput('教程灵感\nhttps://example.com/guide\nhttps://example.com/guide');assert.equal(mixed.kind,'mixed');assert.equal(mixed.urls.length,1);assert.ok(mixed.text.includes('教程灵感'));
 for(const value of ['https://localhost/foo','http://example.com/a','https://127.0.0.1/a','https://user:pass@example.com/a','https://example.com:3000/a','file:///private/data'])assert.throws(()=>parseArticleInput(value));
 assert.throws(()=>parseArticleInput('x'.repeat(30001)));assert.throws(()=>parseArticleInput(''));
 assert.throws(()=>parseArticleInput([1,2,3,4].map(n=>'https://example.com/'+n).join('\n')));
});
test('template recommendations preserve explicit preferences and identify common purposes',()=>{
 assert.equal(recommendArticleLayout('安装教程').id,'practical-guide');assert.equal(recommendArticleLayout('工具推荐清单').id,'resource-list');
 assert.equal(recommendArticleLayout('行业新闻简报').id,'business-brief');assert.equal(recommendArticleLayout('深入分析与观点').id,'deep-reading');
 assert.equal(recommendArticleLayout('图片故事与案例').id,'image-story');assert.equal(recommendArticleLayout('AI工具原理').id,'tech-explainer');
});

test('Chinese sentence boundaries after a link preserve all surrounding source text',()=>{
 const parsed=parseArticleInput('参考 https://example.com/article。该功能仍未开放。');assert.deepEqual(parsed.urls,['https://example.com/article']);assert.ok(parsed.text.includes('该功能仍未开放。'));
});
