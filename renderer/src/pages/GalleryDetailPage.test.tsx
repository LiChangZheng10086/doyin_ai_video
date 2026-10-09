import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { GalleryWorkspace } from './GalleryDetailPage.js';
import type { Gallery } from '../../../src/lib/gallery-types.js';

test('gallery workspace exposes independent copy generation, source warnings and server character limits', () => {
  const gallery: Gallery = { id: 'g', sourceJobId: 'job', version: 1, title: '标题', description: '文📝案', hashtags: [], status: 'draft',
    images: [{ mainTime: 1, times: [1], bandTop: .8, bandBottom: .9, mainFraction: .5 }], createdAt: '', updatedAt: '',
    copyError: '文案来源变化', copyReference: { transcriptHash: 't', sourceFingerprint: 'f', notes: ['收入识别不清'] } };
  const source = { width: 320, height: 480, duration: 5, copyLimits: { titleMax: 20, descriptionMax: 1000, hashtagMax: 10 } };
  const render = (g: Gallery) => renderToStaticMarkup(<RouterProvider router={createMemoryRouter([{ path: '/', element: <GalleryWorkspace initial={g} source={source} transcript={{ segments: [{ start: 0, end: 2, text: '原句' }], transcript: '原句' }} /> }])} />);
  const html = render(gallery);
  assert.match(html, /自动创作整套图文/);
  assert.match(html, /重新生成文案/);
  assert.match(html, /3\s*\/\s*1000/);
  assert.match(html, /文案来源变化/);
  assert.match(html, /收入识别不清/);
  assert.match(html, /文案.*不.*重新生成图片/);
  assert.match(render({ ...gallery, description: '', copyReference: undefined, copyError: undefined }), /生成图文文案/);
});
