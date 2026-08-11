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
  assert.equal(isNavigationItemActive('/jobs/abc', PRIMARY_NAV_ITEMS[0]), true);
  assert.equal(isNavigationItemActive('/collections/abc', PRIMARY_NAV_ITEMS[1]), true);
  assert.equal(isNavigationItemActive('/skills', PRIMARY_NAV_ITEMS[2]), true);
  assert.equal(isNavigationItemActive('/publishing', PRIMARY_NAV_ITEMS[3]), true);
  assert.equal(isNavigationItemActive('/settings', SECONDARY_NAV_ITEMS[1]), true);
  assert.equal(isNavigationItemActive('/other', PRIMARY_NAV_ITEMS[0]), false);
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
    React.createElement(MemoryRouter, { children: React.createElement(PrimaryRail) }),
  );
  assert.match(markup, /aria-label="主导航"/);
  for (const label of ['作品', '合集', 'Skills', '发布', '垃圾桶', '设置']) {
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
