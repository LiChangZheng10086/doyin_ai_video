import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MOBILE_NAV_ITEMS,
  MOBILE_MORE_ITEMS,
  PRIMARY_NAV_ITEMS,
  getPageContext,
  isNavigationItemActive,
} from './navigation.js';

test('hotspots is a primary destination and remains reachable through mobile more without crowding the bar', () => {
  const hotspot = PRIMARY_NAV_ITEMS.find(item => item.to === '/hotspots');
  assert.ok(hotspot);
  assert.equal(isNavigationItemActive('/hotspots', hotspot), true);
  assert.equal(getPageContext('/hotspots').title, '热点');
  assert.ok(MOBILE_MORE_ITEMS.some(item => item.to === '/hotspots'));
  assert.equal(MOBILE_NAV_ITEMS.length, 6);
});

test('assets page is reachable from the primary navigation', () => {
  const assets = PRIMARY_NAV_ITEMS.find((item) => item.to === '/assets');

  assert.ok(assets, '主导航应包含 /assets');
  assert.equal(assets.label, '素材');
  assert.equal(typeof assets.icon, 'object');
});

test('assets navigation item is active only on its own path', () => {
  const assets = PRIMARY_NAV_ITEMS.find((item) => item.to === '/assets')!;

  assert.equal(isNavigationItemActive('/assets', assets), true);

  for (const other of ['/', '/collections', '/skills', '/publishing', '/settings']) {
    assert.equal(isNavigationItemActive(other, assets), false, `${other} 不应激活素材`);
  }
});

test('assets page exposes a page context for the shell header', () => {
  const context = getPageContext('/assets');

  assert.ok(context.title.length > 0);
  assert.ok(context.subtitle.length > 0);
  assert.equal(context.title, '素材');
});

test('gallery creation is a primary route and details stay in its navigation context', () => {
  const gallery = PRIMARY_NAV_ITEMS.find(item => item.to === '/galleries');
  assert.ok(gallery);
  assert.equal(isNavigationItemActive('/galleries/example', gallery), true);
  assert.equal(isNavigationItemActive('/assets', gallery), false);
  assert.equal(getPageContext('/galleries/example').title, '图集创作');
});

// 加「素材」会让移动端底部导航从 5 格变 6 格。这里显式锁住这个事实：
// 如果以后觉得 6 格太挤，把素材移到 SECONDARY_NAV_ITEMS（移动端走「更多」抽屉）即可，
// 届时这条断言需要同步修改，而不是被无声改掉。
test('mobile navigation exposes six slots after adding assets', () => {
  assert.equal(MOBILE_NAV_ITEMS.length, 6);
  assert.ok(MOBILE_NAV_ITEMS.some((item) => 'to' in item && item.to === '/assets'));
});

test('articles and its workbench share a navigation destination available in mobile more', () => {
  const item = PRIMARY_NAV_ITEMS.find(i => i.to === '/articles'); assert.ok(item);
  assert.equal(isNavigationItemActive('/articles/id',item),true);
  assert.equal(getPageContext('/articles/id').title,'文章创作');
  assert.ok(MOBILE_MORE_ITEMS.some(i => i.to === '/articles'));
  assert.equal(MOBILE_NAV_ITEMS.length,6);
});
