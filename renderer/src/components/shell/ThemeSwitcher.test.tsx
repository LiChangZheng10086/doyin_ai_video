import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ThemeSwitcher } from './ThemeSwitcher.js';

test('top bar exposes the default and all choices without opening settings', () => {
  const html = renderToStaticMarkup(<ThemeSwitcher />);
  assert.match(html, /aria-label="界面主题"/);
  assert.match(html, /value="dark" selected/); assert.match(html, />浅色</); assert.match(html, />跟随系统</);
});
