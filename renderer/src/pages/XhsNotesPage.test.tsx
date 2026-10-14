import React from 'react';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { XhsNotesPage } from './XhsNotesPage.js';

test('standalone Xhs creation starts with full source text and requires no video or job', t => {
  const previous = (globalThis as any).React; (globalThis as any).React = React;
  t.after(() => { if (previous === undefined) delete (globalThis as any).React; else (globalThis as any).React = previous; });
  const html = renderToStaticMarkup(<MemoryRouter><XhsNotesPage /></MemoryRouter>);
  assert.match(html, /其他平台原文/);
  assert.doesNotMatch(html, /maxLength=/);
  assert.match(html, /保存原文，开始创作/);
  assert.match(html, /disabled=""[^>]*>[^<]*<svg[\s\S]*保存原文，开始创作/);
  assert.doesNotMatch(html, /来源作品|视频转录/);
});
