import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MODERN_WECHAT_LAYOUTS, validateWechatLayoutOptions } from './wechat-templates.js';
import { renderWechatArticleHtml } from './wechat-article.js';
const draft={title:'真实标题',sections:[{heading:'概念',paragraphs:['现有事实。','<blockquote>引用原句</blockquote>','<pre><code>const answer = 42;\nconsole.log(answer);</code></pre>']},{heading:'边界',paragraphs:['仍需核对。']}]};
test('six structural templates preserve text, images and references without scripts or CSS classes',()=>{
 assert.equal(MODERN_WECHAT_LAYOUTS.length,6);
 const structures=new Set<string>();
 for(const layout of MODERN_WECHAT_LAYOUTS){
  const html=renderWechatArticleHtml(draft,{layoutTemplate:layout.id,layoutVersion:2,images:[{slot:1,caption:'图片说明'}],references:['官方资料 https://example.com']});
  for(const text of ['现有事实','引用原句','const answer','console.log','仍需核对','图片说明','官方资料'])assert.ok(html.includes(text));
  assert.match(html,/\{\{wechat-image-1\}\}/);assert.doesNotMatch(html,/<script|<style|class=|onclick/);
  structures.add(html.replace(/style="[^"]*"/g,''));
 }
 assert.ok(structures.size>=4,'templates must change layout structure, not only colors');
});
test('custom options are bounded CSS values and legacy saved business styles remain unchanged',()=>{
 assert.throws(()=>validateWechatLayoutOptions({themeColor:'red;position:fixed'}),/主题色/);
 assert.throws(()=>validateWechatLayoutOptions({fontSize:40}),/字号/);
 assert.throws(()=>validateWechatLayoutOptions({lineHeight:0.4}),/行距/);
 assert.throws(()=>validateWechatLayoutOptions({customCss:'evil'}),/未知/);
 const old=renderWechatArticleHtml(draft,{layoutTemplate:'business-brief'});
 assert.match(old,/text-indent:2em/);
 const modern=renderWechatArticleHtml(draft,{layoutTemplate:'business-brief',layoutVersion:2,layoutOptions:{themeColor:'#006655',fontSize:17,lineHeight:1.9}});
 assert.notEqual(old,modern);assert.match(modern,/#006655/);assert.match(modern,/font-size:17px/);assert.match(modern,/line-height:1.9/);
 assert.equal(renderWechatArticleHtml(draft,{layoutTemplate:'business-brief'}),old);
});
