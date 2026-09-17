import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { PrimaryRail } from './PrimaryRail.js';
import { PRIMARY_NAV_ITEMS, SECONDARY_NAV_ITEMS } from './navigation.js';

const noop = () => {};

/** 导航里全部可见文案（从数据源派生，导航增删项时这里自动跟上）。 */
const ALL_LABELS = [...PRIMARY_NAV_ITEMS, ...SECONDARY_NAV_ITEMS].map((item) => item.label);

function render(expanded: boolean): string {
  return renderToStaticMarkup(
    React.createElement(MemoryRouter, {
      children: React.createElement(PrimaryRail, { expanded, onToggle: noop }),
    }),
  );
}

test('collapsed rail keeps the icon-only look', () => {
  const markup = render(false);

  for (const label of ALL_LABELS) {
    // 可见文字节点不应出现（aria-label / title 属性仍然保留，便于悬停提示与无障碍）
    assert.doesNotMatch(markup, new RegExp(`>${label}<`), `收起时不应显示「${label}」文字`);
    assert.match(markup, new RegExp(`aria-label="${label}"`));
  }
});

test('expanded rail renders every navigation label', () => {
  const markup = render(true);

  for (const label of ALL_LABELS) {
    assert.match(markup, new RegExp(`>${label}<`), `展开时应显示「${label}」文字`);
  }
});

test('rail exposes an accessible toggle that reflects the current state', () => {
  const collapsed = render(false);
  assert.match(collapsed, /aria-expanded="false"/);
  assert.match(collapsed, /aria-label="展开侧栏"/);

  const expanded = render(true);
  assert.match(expanded, /aria-expanded="true"/);
  assert.match(expanded, /aria-label="收起侧栏"/);
});

test('rail width comes from the shared --rail-w variable only', () => {
  for (const expanded of [false, true]) {
    const markup = render(expanded);
    assert.match(markup, /md:w-\[var\(--rail-w\)\]/);
    // 宽度真源只允许有一个：不得再写死 56px / 64px 偏移
    assert.doesNotMatch(markup, /md:w-\[56px\]/);
    assert.doesNotMatch(markup, /xl:w-16/);
  }
});
