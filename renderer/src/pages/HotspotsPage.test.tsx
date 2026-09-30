import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HotspotBoardCard } from './HotspotsPage.js';
import type { HotspotBoard } from '../../../src/lib/hotspots.js';

test('stale board shows original fetch time, error, safe source link and escapes upstream titles', () => {
  const board: HotspotBoard = { source: { id: 'toutiao', name: '今日头条', label: '热榜', home: 'https://www.toutiao.com/' }, items: [{ sourceId: 'toutiao', itemId: '123', title: '<script>上游内容</script>', url: 'https://www.toutiao.com/trending/123/', rank: 3, heat: '456' }], fetchedAt: '2026-09-30T01:00:00.000Z', checkedAt: '2026-09-30T02:00:00.000Z', status: 'stale', delivery: 'cache', error: '来源暂不可用' };
  const html = renderToStaticMarkup(<HotspotBoardCard board={board} favorites={[]} busy={false} onToggle={() => {}} onSelectSource={() => {}} />);
  assert.match(html, /旧榜单/); assert.match(html, /来源暂不可用/); assert.match(html, /dateTime="2026-09-30T01:00:00.000Z"/i);
  assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
  assert.match(html, /rel="noopener noreferrer"/); assert.match(html, /收藏/);
});

test('an expired displayed snapshot cannot retain a green freshness badge', () => {
  const board: HotspotBoard = { source: { id: 'douyin', name: '抖音', label: '热搜榜', home: 'https://www.douyin.com/hot' }, items: [], fetchedAt: '2026-09-30T01:00:00.000Z', expiresAt: '2026-09-30T01:10:00.000Z', status: 'fresh', delivery: 'cache' };
  const html = renderToStaticMarkup(<HotspotBoardCard board={board} now={Date.parse('2026-09-30T01:10:00.000Z')} favorites={[]} busy={false} onToggle={() => {}} onSelectSource={() => {}} />);
  assert.match(html, /旧榜单/); assert.doesNotMatch(html, /缓存有效/);
});

test('unavailable source offers recovery rather than an empty successful list', () => {
  const board: HotspotBoard = { source: { id: 'douyin', name: '抖音', label: '热搜榜', home: 'https://www.douyin.com/hot' }, items: [], status: 'unavailable', delivery: 'cache', error: '来源返回空响应' };
  const html = renderToStaticMarkup(<HotspotBoardCard board={board} favorites={[]} busy={false} onToggle={() => {}} onSelectSource={() => {}} />);
  assert.match(html, /暂不可用/); assert.match(html, /打开来源/); assert.match(html, /来源返回空响应/);
});

test('a search with no matching entries does not suggest a source failure', () => {
  const board: HotspotBoard = { source: { id: 'douyin', name: '抖音', label: '热搜榜', home: 'https://www.douyin.com/hot' }, items: [], fetchedAt: '2026-09-30T01:00:00.000Z', status: 'fresh', delivery: 'cache' };
  const html = renderToStaticMarkup(<HotspotBoardCard board={board} favorites={[]} busy={false} onToggle={() => {}} onSelectSource={() => {}} />);
  assert.match(html, /没有匹配的标题/); assert.doesNotMatch(html, /请稍后刷新/);
});
