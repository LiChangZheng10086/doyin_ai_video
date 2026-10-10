import assert from 'node:assert/strict';import {test} from 'node:test';
import {renderArticleIllustrationHtml} from './article-illustrations.js';
test('local article illustrations use only escaped current text, with visible illustrative labels and no external resources',()=>{
 const a:any={draft:{title:'<script>alert(1)</script>',sections:[{heading:'步骤与边界',paragraphs:['导出已开放，离线仍未开放。'],factIds:['fact-1']}]},adopted:'draft',layoutTemplate:'tech-explainer',layoutVersion:2};
 const cover=renderArticleIllustrationHtml(a);assert.ok(cover.includes('&lt;script&gt;'));assert.ok(cover.includes('文章封面'));assert.ok(!cover.includes('<script>'));
 const body=renderArticleIllustrationHtml(a,0);assert.ok(body.includes('示意图'));assert.ok(body.includes('离线仍未开放'));assert.ok(body.includes('步骤与边界'));assert.doesNotMatch(body,/https?:|<img|<iframe|<script|@import/);
});
