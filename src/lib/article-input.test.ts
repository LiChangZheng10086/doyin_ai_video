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

test('short questions and multiline outlines are ideas requiring public terms, while complete statements stay text',()=>{
 for(const value of ['什么是skills？ 如何创造skills？ 如何使用skills','什么是skills。如何创造skills。如何使用skills。','什么是skills\n如何创造skills\n如何使用skills','What are skills? How to create skills?','私人备忘录','如何处理我的私人账单？']){
  const p=parseArticleInput(value);assert.equal(p.kind,'idea',value);assert.equal(p.confirmPublicQuery,true);assert.equal(p.raw,value);
 }
 for(const value of ['今天与客户讨论预算。下周补充方案。','什么是skills？Skills 是可复用的能力包。','客户资料\n手机号与私人需求','这是完整正文。'.repeat(80)]){
  const p=parseArticleInput(value);assert.equal(p.kind,'text',value);assert.equal(p.confirmPublicQuery,undefined);assert.equal(p.text,value);
 }
 assert.equal(parseArticleInput('想写一篇关于导出功能的文章').confirmPublicQuery,undefined);
});
