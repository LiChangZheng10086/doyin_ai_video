import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateWritingResult, ArticleWritingService, ArticleWritingError } from './article-writing.js';

const article: any = { keyword: '项目变化', requirements: {}, selectedTopic: 'topic-1', topics: [], sources: [{ id: 's1', text: '项目周三开放了导出，离线编辑仍在开发。', included: true, status: 'readable' }], facts: [{ id: 'f1', sourceId: 's1', quote: '项目周三开放了导出', claim: '项目已开放导出' }], outline: { thesis: '变化', sections: [] } };

test('evidence must quote its actual included source', () => {
  const valid = validateWritingResult('evidence', { facts: [{ claim: '开放导出', sourceId: 's1', quote: '项目周三开放了导出' }], issues: [] }, article);
  assert.equal(valid.facts[0].id, 'fact-1');
  for (const fact of [{ claim: '伪造', sourceId: 'missing', quote: '原文' }, { claim: '伪造', sourceId: 's1', quote: '已支持离线编辑' }]) {
    assert.throws(() => validateWritingResult('evidence', { facts: [fact], issues: [] }, article), /来源|摘录/);
  }
});

test('writing retries empty and truncated output before accepting a validated result', async () => {
  let attempts = 0;
  const signal = new AbortController().signal;
  const valid = { facts: [{ claim: '开放导出', sourceId: 's1', quote: '项目周三开放了导出' }], issues: [] };
  const writer = new ArticleWritingService({ resolveAiConfig: async () => ({ provider: 'deepseek', apiKey: 'fixture', model: 'fixture', maxOutputTokens: 2400 }), createClient: () => ({ chat: { completions: { create: async (params: any, options: any) => {
    attempts++;
    assert.equal(params.max_tokens, 2400);
    assert.deepEqual(params.thinking, { type: 'disabled' });
    assert.equal(options.signal, signal);
    return { choices: [{ message: { content: attempts === 1 ? '' : attempts === 2 ? 'unfinished-output' : JSON.stringify(valid) }, finish_reason: attempts === 2 ? 'length' : 'stop' }] };
  } } } }) as any });
  const result = await writer.run('evidence', article, signal);
  assert.equal(attempts, 3);
  assert.equal(result.facts[0].quote, valid.facts[0].quote);
});

test('evidence selects source excerpt IDs and resolves exact original bytes without omitting source text', async () => {
  const sourceText = '资料开头。\n' + '原始资料 和空格📝。'.repeat(160) + '资料结尾。';
  const input = { ...article, sources: [{ ...article.sources[0], text: sourceText }] };
  let expectedQuote = '';
  const writer = new ArticleWritingService({ resolveAiConfig: async () => ({ apiKey: 'fixture', model: 'fixture' }), createClient: () => ({ chat: { completions: { create: async (params: any) => {
    const source = JSON.parse(params.messages.find((m: any) => m.role === 'user').content).sources[0];
    assert.equal(source.excerpts.map((e: any) => e.text).join(''), sourceText);
    assert.ok(source.excerpts.every((e: any) => e.text.length <= 1000));
    const excerpt = source.excerpts.at(-1);
    expectedQuote = excerpt.text.trim();
    return { choices: [{ message: { content: JSON.stringify({ facts: [{ claim: '资料有结尾', sourceId: source.id, quoteId: excerpt.id }], issues: [] }) }, finish_reason: 'stop' }] };
  } } } }) as any });
  const result = await writer.run('evidence', input);
  assert.equal(result.facts[0].quote, expectedQuote);
  assert.ok(sourceText.includes(result.facts[0].quote));
});

test('evidence rejects unknown excerpt IDs without fabricating an accepted quote', async () => {
  let attempts = 0;
  const writer = new ArticleWritingService({ resolveAiConfig: async () => ({ apiKey: 'fixture', model: 'fixture' }), createClient: () => ({ chat: { completions: { create: async () => {
    attempts++;
    return { choices: [{ message: { content: JSON.stringify({ facts: [{ claim: '开放导出', sourceId: 's1', quoteId: 'unknown' }], issues: [] }) }, finish_reason: 'stop' }] };
  } } } }) as any });
  await assert.rejects(writer.run('evidence', article), (error: any) => error.code === 'ai_quote_invalid');
  assert.equal(attempts, 3);
});

test('invalid evidence is regenerated with fixed feedback and never repaired into an accepted quote', async () => {
  let attempts = 0;
  const writer = new ArticleWritingService({ resolveAiConfig: async () => ({ apiKey: 'fixture', model: 'fixture' }), createClient: () => ({ chat: { completions: { create: async (params: any) => {
    attempts++;
    if (attempts === 2) {
      assert.match(params.messages.at(-1).content, /ai_quote_invalid/);
      assert.ok(!JSON.stringify(params.messages).includes('invented-private-quote'));
      assert.ok(JSON.stringify(params.messages).includes(article.sources[0].text));
    }
    return { choices: [{ message: { content: JSON.stringify({ facts: [{ claim: '开放导出', sourceId: 's1', quote: attempts === 1 ? 'invented-private-quote' : '项目周三开放了导出' }], issues: [] }) }, finish_reason: 'stop' }] };
  } } } }) as any });
  const result = await writer.run('evidence', article);
  assert.equal(attempts, 2);
  assert.equal(result.facts[0].quote, '项目周三开放了导出');
});

test('writing rejects all three invalid responses with the specific final error', async () => {
  let attempts = 0;
  const writer = new ArticleWritingService({ resolveAiConfig: async () => ({ apiKey: 'fixture', model: 'fixture' }), createClient: () => ({ chat: { completions: { create: async () => {
    attempts++;
    return { choices: [{ message: { content: '' }, finish_reason: 'stop' }] };
  } } } }) as any });
  await assert.rejects(writer.run('evidence', article), (error: unknown) => error instanceof ArticleWritingError && error.code === 'ai_output_empty');
  assert.equal(attempts, 3);
});

test('writing does not retry credentials or cancellation', async () => {
  for (const cancelled of [false, true]) {
    let attempts = 0;
    const controller = new AbortController();
    const writer = new ArticleWritingService({ resolveAiConfig: async () => ({ apiKey: 'fixture', model: 'fixture' }), createClient: () => ({ chat: { completions: { create: async () => {
      attempts++;
      if (!cancelled) throw Object.assign(new Error('private-auth-response'), { status: 401 });
      controller.abort();
      return { choices: [{ message: { content: '' }, finish_reason: 'stop' }] };
    } } } }) as any });
    await assert.rejects(writer.run('evidence', article, controller.signal), (error: any) => cancelled ? error.name === 'AbortError' : error.code === 'ai_access');
    assert.equal(attempts, 1);
  }
});

test('writing retries interrupted responses within the same three-attempt budget without changing the prompt', async () => {
  let attempts = 0, firstPrompt = '';
  const writer = new ArticleWritingService({ resolveAiConfig: async () => ({ apiKey: 'fixture', model: 'fixture' }), createClient: () => ({ chat: { completions: { create: async (params: any) => {
    attempts++;
    if (attempts === 1) firstPrompt = JSON.stringify(params);
    assert.equal(JSON.stringify(params), firstPrompt);
    if (attempts < 3) throw Object.assign(new Error('private-network-details'), { cause: { code: 'ERR_STREAM_PREMATURE_CLOSE' } });
    return { choices: [{ message: { content: JSON.stringify({ facts: [{ claim: '开放导出', sourceId: 's1', quote: '项目周三开放了导出' }], issues: [] }) }, finish_reason: 'stop' }] };
  } } } }) as any });
  const result = await writer.run('evidence', article);
  assert.equal(attempts, 3);
  assert.equal(result.facts[0].quote, '项目周三开放了导出');
});

test('persistent interrupted responses stop at three and disclose no transport details', async () => {
  let attempts = 0;
  const writer = new ArticleWritingService({ resolveAiConfig: async () => ({ apiKey: 'fixture', model: 'fixture' }), createClient: () => ({ chat: { completions: { create: async () => {
    attempts++;
    throw Object.assign(new Error('private-network-details'), { code: 'ERR_STREAM_PREMATURE_CLOSE' });
  } } } }) as any });
  await assert.rejects(writer.run('evidence', article), (error: any) => error.code === 'ai_connection_interrupted' && !error.message.includes('private-network-details'));
  assert.equal(attempts, 3);
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

test('DeepSeek writing disables thinking, obeys the configured output budget and forwards cancellation', async () => {
 let request:any,options:any;const signal=new AbortController().signal;
 const writer=new ArticleWritingService({resolveAiConfig:async()=>({provider:'deepseek',apiKey:'fixture',model:'fixture',maxOutputTokens:2400}),createClient:()=>({chat:{completions:{create:async(p:any,o:any)=>{request=p;options=o;return {choices:[{message:{content:JSON.stringify({facts:[{claim:'开放导出',sourceId:'s1',quote:'项目周三开放了导出'}],issues:[]})},finish_reason:'stop'}]};}}}}) as any});
 await writer.run('evidence',article,signal);assert.equal(request.max_tokens,2400);assert.deepEqual(request.thinking,{type:'disabled'});assert.equal(options.signal,signal);
});

for(const [name,content,reason,code] of [
 ['json','{"private":"secret-body"','stop','ai_json_invalid'],
 ['empty','','stop','ai_output_empty'],
 ['truncated','secret-body','length','ai_output_truncated'],
 ['structure',JSON.stringify({facts:'secret-body',issues:[]}),'stop','ai_structure_invalid'],
 ['facts',JSON.stringify({facts:[],issues:[]}),'stop','ai_facts_empty'],
 ['source',JSON.stringify({facts:[{claim:'主张',sourceId:'private-source',quote:'secret-body'}],issues:[]}),'stop','ai_source_invalid'],
 ['quote',JSON.stringify({facts:[{claim:'主张',sourceId:'s1',quote:'secret-body'}],issues:[]}),'stop','ai_quote_invalid'],
 ['missing-source',JSON.stringify({facts:[{claim:'主张',quote:'secret-body'}],issues:[]}),'stop','ai_source_invalid'],
] as const)test(`writing failure ${name} exposes only a fixed diagnostic code, never provider/private content`,async()=>{
 const service=new ArticleWritingService({resolveAiConfig:async()=>({apiKey:'fixture',model:'fixture'}),createClient:()=>({chat:{completions:{create:async()=>({choices:[{message:{content},finish_reason:reason}]})}}}) as any});
 await assert.rejects(service.run('evidence',article),(e:unknown)=>e instanceof ArticleWritingError&&e.code===code&&!/secret-body|private-source/.test(e.message));
});
