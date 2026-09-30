import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ImagePromptPanel } from './ImagePromptPanel.js';

test('image prompt panel exposes labeled generation settings and a separate optimize mode', () => {
 const html = renderToStaticMarkup(<ImagePromptPanel onAssetsChanged={async () => {}} />);
 for (const text of ['生成提示词','优化已有提示词','主题或文章','用途','比例','输出语言','已保存的提示词','生成成功的图片']) assert.ok(html.includes(text), text);
 assert.match(html, /role="alert"/);
 assert.match(html, /16:9/);
});
