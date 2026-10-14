import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GalleryOperation } from '../../../src/lib/gallery-types';

test('operation renders real stage units and restored pause controls', async () => {
  const { GalleryOperationPanel } = await import('./GalleryOperationPanel');
  const operation: GalleryOperation = { id: 'op', kind: 'candidates', stage: 'ocr', completed: 3, total: 12, status: 'running', startedAt: '', updatedAt: '' };
  const render = (status: GalleryOperation['status']) => renderToStaticMarkup(<GalleryOperationPanel operation={{ ...operation, status }} disabled={false} onPause={() => {}} onResume={() => {}} />);
  assert.match(render('running'), /<progress[^>]*value="3"[^>]*max="12"/); assert.match(render('running'), /3 \/ 12.*25%/);
  assert.match(render('running'), /暂停/); assert.match(render('pausing'), /暂停中/); assert.match(render('paused'), /已暂停/); assert.match(render('paused'), /继续/);
  assert.match(render('interrupted'), /已中断/); assert.match(render('interrupted'), /重新发起/);
  const recovery = renderToStaticMarkup(<GalleryOperationPanel operation={{ ...operation, status: 'interrupted', recovery: { input: { kind: 'candidates', version: 1 }, version: 1, sourceFingerprint: 'source' } }} disabled={false} onPause={() => {}} onResume={() => {}} />);
  assert.match(recovery, />继续</); assert.match(recovery, /核对来源/);
  const error = renderToStaticMarkup(<GalleryOperationPanel operation={{ ...operation, status: 'failed', error: '来源变化' }} disabled={false} onPause={() => {}} onResume={() => {}} />);
  assert.match(error, /来源变化/);
});
