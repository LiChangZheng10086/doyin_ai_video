import assert from 'node:assert/strict';
import { test } from 'node:test';
import { articleLengthFeedback } from './article-length.js';
const draft={sections:[{heading:'不统计标题',paragraphs:[' 中文， A📝 \n','第二段。']}]};
test('article length counts prose Unicode characters including punctuation, excluding whitespace and headings',()=>{
  assert.equal(articleLengthFeedback(draft,'9～9字').count,9);
  assert.equal(articleLengthFeedback(draft,'9～9字').withinRange,true);
});
test('only unambiguous positive character ranges become enforced bounds',()=>{
  for(const range of ['8-10字','8～10','8 至 10 字','8字到10字'])assert.equal(articleLengthFeedback(draft,range).withinRange,true);
  for(const length of ['', '1500字左右','标题20字，正文1200-1600字','1600-1200字','0-10字','1.2-1.6万字'])assert.equal(articleLengthFeedback(draft,length).withinRange,undefined);
  assert.equal(articleLengthFeedback(draft,'10-20字').withinRange,false);
  assert.match(articleLengthFeedback(draft,'1500字左右').message,/人工核对/);
});
