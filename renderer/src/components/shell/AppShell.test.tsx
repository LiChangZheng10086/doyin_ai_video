import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AppShell } from './AppShell.js';

function render(initialExpanded?: boolean): string {
  return renderToStaticMarkup(
    React.createElement(MemoryRouter, {
      children: React.createElement(AppShell, {
        children: '内容',
        ...(initialExpanded === undefined ? {} : { initialExpanded }),
      }),
    }),
  );
}

test('AppShell renders without a window and defaults to the collapsed rail width', () => {
  // Node 里没有 window，静态渲染必须能跑通（初始值要判断 typeof window）
  const markup = render();

  assert.match(markup, /md:\[--rail-w:56px\]/);
  assert.match(markup, /xl:\[--rail-w:64px\]/);
  assert.doesNotMatch(markup, /\[--rail-w:208px\]/);
});

test('AppShell declares the expanded rail width when opened', () => {
  const markup = render(true);

  assert.match(markup, /\[--rail-w:208px\]/);
  assert.doesNotMatch(markup, /md:\[--rail-w:56px\]/);
});

test('content area follows the shared rail width variable', () => {
  const markup = render();

  assert.match(markup, /md:ml-\[var\(--rail-w\)\]/);
  // 宽度真源只允许一个：不得再写死偏移
  assert.doesNotMatch(markup, /md:ml-\[56px\]/);
  assert.doesNotMatch(markup, /xl:ml-16/);
});
