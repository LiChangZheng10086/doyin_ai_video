import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TranscriptArtifact } from './TranscriptArtifact.js';

test('suspect transcript remains visible with a warning and never claims verified accuracy', () => {
  const html = renderToStaticMarkup(<TranscriptArtifact transcript={{ transcript: '重复台词', qualityIssues: ['异常循环重复'] } as any} />);
  assert.match(html, /异常循环重复/);
  assert.match(html, /role="alert"/);
  assert.doesNotMatch(html, /这是从视频音频提取并转录的真实内容/);
});

test('YouTube caption provenance is shown separately from audio recognition', () => {
 const html = renderToStaticMarkup(<TranscriptArtifact transcript={{transcript:'Keep going.',provider:'youtube-authored-captions',model:'youtube-json3',language:'en'}}/>);
 assert.match(html,/YouTube 人工字幕/); assert.doesNotMatch(html,/本地模型从视频音频识别/); assert.match(html,/原文/);
});

test('proofreading status and original correction comparison are visible', () => {
  const html = renderToStaticMarkup(<TranscriptArtifact transcript={{ transcript: '章尾钩子', provider: 'whisper.cpp',
    proofreading: { status: 'succeeded', checkedAt: 'now', model: 'test-model', changes: [{ segmentIndex: 0, before: '章尾勾子', after: '章尾钩子' }],
      original: { text: '章尾勾子', transcript: '章尾勾子', segments: [] } } }} />);
  assert.match(html, /AI 已校对/); assert.match(html, /1 处/); assert.match(html, /章尾勾子/);
  assert.match(html, /修改前原文/); assert.match(html, /test-model/);
});

for (const status of ['failed', 'skipped'] as const) test(`proofreading ${status} explicitly retains original transcript`, () => {
  const html = renderToStaticMarkup(<TranscriptArtifact transcript={{ transcript: '原文', provider: 'whisper.cpp',
    proofreading: { status, checkedAt: 'now', changes: [], reason: '校对服务不可用' } }} />);
  assert.match(html, /校对未完成/); assert.match(html, /校对服务不可用/); assert.match(html, /原文/); assert.doesNotMatch(html, /AI 已校对/);
});
