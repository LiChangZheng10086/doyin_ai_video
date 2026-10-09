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
