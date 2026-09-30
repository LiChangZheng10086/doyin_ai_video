import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContentPreview } from './ContentPreview.js';
function luminance(channel: number) { const value = channel / 255; return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; }
test('white thumbnails have enough dark coverage throughout compact and regular title areas', () => {
  for (const compact of [true, false]) {
    const html = renderToStaticMarkup(<ContentPreview compact={compact} title="测试标题" imageUrl="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3Crect fill='white' width='100%25' height='100%25'/%3E%3C/svg%3E" />);
    const alpha = html.match(/bg-black\/(\d+)/)?.[1]; assert.ok(alpha, '标题整个区域必须有统一遮罩，不能依赖透明渐变');
    const background = 255 * (1 - Number(alpha) / 100);
    const text = 0.2126 * luminance(230) + 0.7152 * luminance(234) + 0.0722 * luminance(240);
    assert.ok((text + 0.05) / (luminance(background) + 0.05) >= 4.5, '白图上的标题应达到 AA');
  }
});
