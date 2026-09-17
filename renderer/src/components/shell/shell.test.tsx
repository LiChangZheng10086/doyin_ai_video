import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import {
  PRIMARY_NAV_ITEMS,
  SECONDARY_NAV_ITEMS,
  MOBILE_NAV_ITEMS,
  isNavigationItemActive,
} from './navigation.js';
import { PrimaryRail } from './PrimaryRail.js';
import { MobileNavigation } from './MobileNavigation.js';

test('isNavigationItemActive matches exact routes and prefix rules', () => {
  // 按 `to` 查找而不是按下标：导航增删项时这条用例不该被无关地打破
  const find = (to: string) => PRIMARY_NAV_ITEMS.find((item) => item.to === to)!;

  assert.equal(isNavigationItemActive('/jobs/abc', find('/')), true);
  assert.equal(isNavigationItemActive('/collections/abc', find('/collections')), true);
  assert.equal(isNavigationItemActive('/skills', find('/skills')), true);
  assert.equal(isNavigationItemActive('/assets', find('/assets')), true);
  assert.equal(isNavigationItemActive('/publishing', find('/publishing')), true);
  assert.equal(isNavigationItemActive('/settings', SECONDARY_NAV_ITEMS[1]), true);
  assert.equal(isNavigationItemActive('/other', find('/')), false);
});

test('MOBILE_NAV_ITEMS ends with more', () => {
  const last = MOBILE_NAV_ITEMS.at(-1);
  assert.equal(last?.label, '更多');
  if ('key' in last!) {
    assert.equal(last.key, 'more');
  }
});

test('PrimaryRail renders nav with icon links', () => {
  const markup = renderToStaticMarkup(
    React.createElement(MemoryRouter, {
      children: React.createElement(PrimaryRail, { expanded: false, onToggle: () => {} }),
    }),
  );
  assert.match(markup, /aria-label="主导航"/);
  for (const label of ['作品', '合集', 'Skills', '素材', '发布', '垃圾桶', '设置']) {
    assert.match(markup, new RegExp(`aria-label="${label}"`));
  }
});

test('MobileNavigation renders with correct aria label', () => {
  const markup = renderToStaticMarkup(
    React.createElement(MemoryRouter, { children: React.createElement(MobileNavigation, { onOpenMore: () => {} }) }),
  );
  assert.match(markup, /aria-label="移动导航"/);
  assert.match(markup, />更多</);
});
