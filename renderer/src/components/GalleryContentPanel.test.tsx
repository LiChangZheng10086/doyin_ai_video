import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GalleryContentPlan } from '../../../src/lib/gallery-types';

const plan: GalleryContentPlan = { id: 'text', targetLines: 8, transcriptHash: 't', sourceFingerprint: 's', estimatedImages: 36, method: 'ai', createdAt: '', items: [
  { id: 'a', segmentIndex: 0, text: '<原句>', start: 0, end: 2, selected: true, reason: '核心内容' },
  { id: 'b', segmentIndex: 1, text: '译文', originalText: 'Original', start: 2, end: 4, selected: false, reason: '重复建议' },
] };
test('content list preserves originals, times, excluded choices and blocks over 35 before candidate work', async () => {
  const { GalleryContentPanel } = await import('./GalleryContentPanel');
  const html = renderToStaticMarkup(<GalleryContentPanel plan={plan} disabled={false} onSave={async () => {}} onOrganize={() => {}} onGenerate={() => {}} />);
  assert.match(html, /&lt;原句&gt;/); assert.match(html, /0.0–2.0/); assert.match(html, /Original/); assert.match(html, /重复建议/);
  assert.match(html, /预计.*36.*张/); assert.match(html, /超过.*35.*张/); assert.match(html, /保留 1.*剔除 1/);
  assert.match(html, /恢复全部内容/); assert.match(html, /认可文字，生成候选/);
  assert.match(html, /disabled=""[^>]*>认可文字，生成候选/);
  const boundary = renderToStaticMarkup(<GalleryContentPanel plan={{ ...plan, estimatedImages: 35 }} disabled={false} onSave={async () => {}} onOrganize={() => {}} onGenerate={() => {}} />);
  assert.doesNotMatch(boundary, /超过 35 张/);
});
