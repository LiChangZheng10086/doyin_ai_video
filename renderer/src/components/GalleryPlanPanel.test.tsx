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
});
