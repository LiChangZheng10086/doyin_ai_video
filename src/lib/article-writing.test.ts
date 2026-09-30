import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateWritingResult, ArticleWritingService } from './article-writing.js';

const article: any = { keyword: '项目变化', requirements: {}, selectedTopic: 'topic-1', topics: [], sources: [{ id: 's1', text: '项目周三开放了导出，离线编辑仍在开发。', included: true, status: 'readable' }], facts: [{ id: 'f1', sourceId: 's1', quote: '项目周三开放了导出', claim: '项目已开放导出' }], outline: { thesis: '变化', sections: [] } };

test('evidence must quote its actual included source', () => {
  const valid = validateWritingResult('evidence', { facts: [{ claim: '开放导出', sourceId: 's1', quote: '项目周三开放了导出' }], issues: [] }, article);
  assert.equal(valid.facts[0].id, 'fact-1');
  for (const fact of [{ claim: '伪造', sourceId: 'missing', quote: '原文' }, { claim: '伪造', sourceId: 's1', quote: '已支持离线编辑' }]) {
    assert.throws(() => validateWritingResult('evidence', { facts: [fact], issues: [] }, article), /来源|摘录/);
  }
});

test('drafts and revisions reject nonexistent fact references and empty text', () => {
  const draft = { title: '变化', sections: [{ heading: '实际变化', paragraphs: ['导出已开放。'], factIds: ['f1'] }] };
  assert.equal(validateWritingResult('draft', draft, article).sections[0].paragraphs[0], '导出已开放。');
  assert.throws(() => validateWritingResult('draft', { ...draft, sections: [{ paragraphs: ['句子'], factIds: ['ghost'] }] }, article), /引用/);
  assert.throws(() => validateWritingResult('draft', { ...draft, sections: [{ paragraphs: [], factIds: ['f1'] }] }, article), /段落/);
});

test('diagnosis needs three distinct usable directions', () => {
  assert.throws(() => validateWritingResult('diagnose', { topics: [] }, article), /三个/);
  const result = validateWritingResult('diagnose', { topics: [1, 2, 3].map(n => ({ title: `方向${n}`, audience: '读者', question: '关心什么', thesis: '主张', hook: '开头', angle: '解释', researchQuestions: ['查证'] })) }, article);
  assert.equal(result.topics[2].id, 'topic-3');
});

test('AI configuration failure is explicit and never returns local fallback prose', async () => {
  const writer = new ArticleWritingService({ resolveAiConfig: async () => null });
  await assert.rejects(writer.run('diagnose', article), /AI/);
});
