import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ArticleTemplatePicker } from './ArticleTemplatePicker.js';
test('six-template picker shows actual article preview, bounded reading controls and explicit future-only defaults',()=>{
 const html=renderToStaticMarkup(<ArticleTemplatePicker value="tech-explainer" layoutVersion={2} onChange={()=>{}} previewTitle="当前真实稿件" previewHtml="<section><p>真实事实内容</p></section>"/>);
 for(const text of ['科技解读','实操教程','商务简报','深度长文','图片故事','清单推荐','模板主题色','正文字号','正文行距','设为新文章默认','恢复默认设置','真实事实内容'])assert.ok(html.includes(text));
 assert.doesNotMatch(html,/清楚解释一个问题|章节标题 · 阅读示例/);
 assert.match(html,/sandbox=""/);
});
test('legacy selected templates remain visible and have no fabricated article sample',()=>{
 const html=renderToStaticMarkup(<ArticleTemplatePicker value="minimal-read" onChange={()=>{}}/>);
 assert.ok(html.includes('旧文章不会自动升级'));assert.ok(html.includes('尚无初稿'));assert.ok(!html.includes('srcDoc='));
});
