import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

test('whole gallery plan shows all source quotes and exclusions before confirmation', async () => {
  const { GalleryPlanPanel } = await import('./GalleryPlanPanel.js');
  const image = { mainTime: 1, times: [1], bandTop: 0.8, bandBottom: 0.9, mainFraction: 0.5 };
  const plan = { id: 'p', sourceFingerprint: 's', transcriptHash: 't', images: [{ title: '第一个主题', image,
    quotes: [{ segmentIndex: 0, text: '<script>原话</script>', start: 0, end: 2 }] }], warnings: ['候选画面需核对'], excluded: [{ segmentIndex: 1, reason: '未检测到可用字幕' }] };
  const html = renderToStaticMarkup(<GalleryPlanPanel plan={plan} imageUrls={['http://localhost/preview.png']} confirmed={false} disabled={false} onConfirmChange={() => {}} onGenerate={() => {}} />);
  assert.match(html, /建议生成 1 张/);
  assert.match(html, /&lt;script&gt;原话&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /未检测到可用字幕/);
  assert.match(html, /按此方案生成整套图集/);
  assert.match(html, /disabled=""/);
  assert.doesNotMatch(html, /type="number"/);
  const blocked = renderToStaticMarkup(<GalleryPlanPanel plan={{ ...plan, blockedReason: '大部分内容未匹配，不能生成' }} imageUrls={[]} confirmed={true} disabled={false} onConfirmChange={() => {}} onGenerate={() => {}} />);
  assert.match(blocked, /大部分内容未匹配，不能生成/);
});

test('legacy candidate plans over 35 remain viewable but cannot be confirmed or rendered', async () => {
  const { GalleryPlanPanel } = await import('./GalleryPlanPanel.js');
  const image = { mainTime: 1, times: [1], bandTop: .8, bandBottom: .9, mainFraction: .5 };
  const plan = { id: 'p', sourceFingerprint: 's', transcriptHash: 't', warnings: [], excluded: [], images: Array.from({ length: 36 }, () => ({ title: '原句', image, quotes: [] })) };
  const html = renderToStaticMarkup(<GalleryPlanPanel plan={plan} imageUrls={[]} confirmed={true} disabled={false} onConfirmChange={() => {}} onGenerate={() => {}} />);
  assert.match(html, /超过 35 张/);
  assert.match(html, /第 36 张/);
  assert.match(html, /disabled=""[^>]*>按此方案生成整套图集/);
});

test('translated plan shows merged layout text separately from all original caption times', async () => {
  const { GalleryPlanPanel } = await import('./GalleryPlanPanel.js');
  const plan = { id: 'p', mode: 'translated' as const, transcriptHash: 't', sourceFingerprint: 's', warnings: [], excluded: [], images: [{ title: '开场',
    image: { mainTime: .5, times: [.5], bandTop: .75, bandBottom: .95, mainFraction: .48, translatedCaptions: ['大家好，今天聊一聊'] },
    quotes: [{ segmentIndex: 0, text: '大家好', originalText: 'Hello', start: 0, end: 1 }, { segmentIndex: 1, text: '今天聊一聊', originalText: 'Today', start: 1, end: 2 }] }] };
  const html = renderToStaticMarkup(<GalleryPlanPanel plan={plan} imageUrls={[]} confirmed={false} disabled={false} onConfirmChange={() => {}} onGenerate={() => {}} />);
  assert.match(html, /1 条排版/);
  assert.match(html, /2 条原字幕/);
  assert.match(html, /大家好，今天聊一聊/);
  assert.match(html, /Hello/);
  assert.match(html, /Today/);
  assert.match(html, /0\.0～1\.0 秒/);
  assert.match(html, /1\.0～2\.0 秒/);
});
