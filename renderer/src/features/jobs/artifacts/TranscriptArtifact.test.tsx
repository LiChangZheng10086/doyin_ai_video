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
