import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { GalleryWorkspace } from './GalleryDetailPage.js';
import type { Gallery } from '../../../src/lib/gallery-types.js';
import { GalleryTranslationPanel } from '../components/GalleryTranslationPanel.js';

test('translation defaults to the entire long video instead of the first two minutes', () => {
  const gallery = { id: 'g', translation: undefined } as Gallery;
  const html = renderToStaticMarkup(<GalleryTranslationPanel gallery={gallery} duration={948.834} disabled={false} dirty={false} onTranslate={() => {}} onEdit={() => {}} />);
  assert.match(html, /value="948.834"/);
  assert.match(html, /完整视频/);
  assert.doesNotMatch(html, /默认选取前两分钟/);
});

test('gallery workspace exposes independent copy generation, source warnings and server character limits', () => {
  const gallery: Gallery = { id: 'g', sourceJobId: 'job', version: 1, title: '标题', description: '文📝案', hashtags: [], status: 'draft',
    images: [{ mainTime: 1, times: [1], bandTop: .8, bandBottom: .9, mainFraction: .5 }], createdAt: '', updatedAt: '',
    copyError: '文案来源变化', copyReference: { transcriptHash: 't', sourceFingerprint: 'f', notes: ['收入识别不清'] } };
  const source = { width: 320, height: 480, duration: 5, copyLimits: { titleMax: 20, descriptionMax: 1000, hashtagMax: 10 } };
  const render = (g: Gallery) => renderToStaticMarkup(<RouterProvider router={createMemoryRouter([{ path: '/', element: <GalleryWorkspace initial={g} source={source} transcript={{ segments: [{ start: 0, end: 2, text: '原句' }], transcript: '原句' }} /> }])} />);
  const html = render(gallery);
  assert.match(html, /自动创作整套图文/);
  assert.match(html, /<option value="custom">自定义<\/option>/);
  assert.match(html, /重新生成文案/);
  assert.match(html, /3\s*\/\s*1000/);
  assert.match(html, /文案来源变化/);
  assert.match(html, /收入识别不清/);
  assert.match(html, /文案.*不.*重新生成图片/);
  assert.match(render({ ...gallery, description: '', copyReference: undefined, copyError: undefined }), /生成图文文案/);
});

test('translated workspace exposes range, bilingual editable text and a distinct gallery mode', () => {
 const g: Gallery = {id:'g',sourceJobId:'job',version:2,mode:'translated',title:'中文',description:'',hashtags:[],status:'draft',images:[{mainTime:1,times:[1],bandTop:.8,bandBottom:.9,mainFraction:.5}],createdAt:'',updatedAt:'',translation:{start:0,end:4,transcriptHash:'h',sourceFingerprint:'s',cues:[{segmentIndex:0,original:'Never give up.',text:'永不放弃。',start:0,end:4}]}};
 const html=renderToStaticMarkup(<RouterProvider router={createMemoryRouter([{path:'/',element:<GalleryWorkspace initial={g} source={{width:640,height:360,duration:3600}} transcript={{transcript:'Never give up.',segments:[{start:0,end:4,text:'Never give up.'}]}}/>}])}/>);
 assert.match(html,/中文译文图集/); assert.match(html,/翻译开始/); assert.match(html,/Never give up/); assert.match(html,/永不放弃/); assert.match(html,/翻译完整视频/); assert.match(html,/当前译文仅覆盖部分视频/); assert.doesNotMatch(html,/高级调整 · 手动换句/);
});

test('returning to a paused gallery restores progress controls and locks gallery editing', () => {
  const gallery: Gallery = { id: 'g', sourceJobId: 'job', version: 3, title: '标题', description: '', hashtags: [], status: 'running',
    images: [{ mainTime: 1, times: [1], bandTop: .8, bandBottom: .9, mainFraction: .5 }], createdAt: '', updatedAt: '',
    contentPlan: { id: 'content', transcriptHash: 't', sourceFingerprint: 's', targetLines: 8, estimatedImages: 1, method: 'manual', createdAt: '', items: [{ id: 'a', segmentIndex: 0, text: '原句', start: 0, end: 2, selected: true, reason: '' }] },
    operation: { id: 'op', kind: 'candidates', status: 'paused', stage: 'ocr', completed: 2, total: 5, startedAt: '', updatedAt: '' } };
  const html = renderToStaticMarkup(<RouterProvider router={createMemoryRouter([{ path: '/', element: <GalleryWorkspace initial={gallery} source={{ width: 320, height: 480, duration: 5 }} transcript={{ segments: [{ start: 0, end: 2, text: '原句' }], transcript: '原句' }} /> }])} />);
  assert.match(html, /已暂停/); assert.match(html, /<progress[^>]*value="2"[^>]*max="5"/); assert.match(html, />继续<\/button>/);
  assert.match(html, /图集文字方案/); assert.match(html, /disabled=""[^>]*>保存草稿/);
  assert.doesNotMatch(html, /创作不限制图片总数/);
});

test('saved custom target is restored with the textual plan on return', () => {
  const gallery: Gallery = { id: 'g', sourceJobId: 'job', version: 3, title: '', description: '', hashtags: [], status: 'draft',
    images: [{ mainTime: 1, times: [1], bandTop: .8, bandBottom: .9, mainFraction: .5 }], createdAt: '', updatedAt: '',
    contentPlan: { id: 'p', transcriptHash: 't', sourceFingerprint: 's', targetLines: 12, estimatedImages: 1, method: 'manual', createdAt: '', items: [{ id: 'a', segmentIndex: 0, text: '原句', start: 0, end: 2, selected: true, reason: '' }] } };
  const html = renderToStaticMarkup(<RouterProvider router={createMemoryRouter([{ path: '/', element: <GalleryWorkspace initial={gallery} source={{ width: 320, height: 480, duration: 5 }} transcript={{ transcript: '原句', segments: [{ start: 0, end: 2, text: '原句' }] }} /> }])} />);
  assert.match(html, /aria-label="自定义条数"[^>]*value="12"/);
  assert.doesNotMatch(html, /目标条数已改变/);
});

test('returning to a prepared translated range keeps the explicit advanced range choice', () => {
  const gallery: Gallery = { id: 'g', sourceJobId: 'job', version: 3, mode: 'translated', title: '', description: '', hashtags: [], status: 'draft',
    images: [{ mainTime: 1, times: [1], bandTop: .8, bandBottom: .9, mainFraction: .5 }], createdAt: '', updatedAt: '',
    translation: { start: 2, end: 4, transcriptHash: 't', sourceFingerprint: 's', cues: [{ segmentIndex: 1, original: 'Original', text: '原句', start: 2, end: 4 }] },
    contentPlan: { id: 'p', transcriptHash: 't', sourceFingerprint: 's', targetLines: 8, estimatedImages: 1, method: 'manual', createdAt: '', items: [{ id: 'a', segmentIndex: 1, text: '原句', start: 2, end: 4, selected: true, reason: '' }] } };
  const html = renderToStaticMarkup(<RouterProvider router={createMemoryRouter([{ path: '/', element: <GalleryWorkspace initial={gallery} source={{ width: 320, height: 480, duration: 5 }} transcript={{ transcript: 'Original', segments: [{ start: 2, end: 4, text: 'Original' }] }} /> }])} />);
  assert.match(html, /翻译所选片段/);
  assert.doesNotMatch(html, /当前译文仅覆盖部分视频/);
});
