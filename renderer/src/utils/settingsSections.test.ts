import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loginSectionOf, settingsSections } from './settingsSections.js';

/**
 * 设置页分组定义 + 「渠道 → 登录分组」映射的门禁。
 *
 * 第二个才是重点：**两套 id 不同名**（分组的「小红书」是 `xhs`，运行环境的渠道是
 * `xiaohongshu`），直接互用会让「去登录」跳到错误的分组。
 */

test('设置页有 8 个分组，id 唯一，且新增的「运行环境」在列', () => {
  assert.equal(settingsSections.length, 8, '本次新增「运行环境」：7 → 8');
  const ids = settingsSections.map((section) => section.id);
  assert.equal(new Set(ids).size, ids.length, 'id 不许重复（重复会让左栏出现两个无法区分的高亮）');
  assert.ok(ids.includes('runtime'));
});

test('「运行环境」排在登录分组**之前** —— 它是总览，先看哪儿坏了再决定去哪一组修', () => {
  const ids = settingsSections.map((section) => section.id);
  assert.ok(ids.indexOf('runtime') < ids.indexOf('douyin'));
  assert.ok(ids.indexOf('runtime') < ids.indexOf('toutiao'));
  assert.ok(ids.indexOf('runtime') < ids.indexOf('xhs'));
});

test('每个分组都有 label 与 description（左栏两行都靠它们）', () => {
  for (const section of settingsSections) {
    assert.ok(section.label.length > 0, `${section.id} 缺 label`);
    assert.ok(section.description.length > 0, `${section.id} 缺 description`);
  }
});

test('⚠️ loginSectionOf：小红书渠道 id 是 xiaohongshu，而分组 id 是 xhs（两套 id 不同名）', () => {
  assert.equal(loginSectionOf('douyin'), 'douyin');
  assert.equal(loginSectionOf('toutiao'), 'toutiao');
  assert.equal(loginSectionOf('xiaohongshu'), 'xhs');
  // 反向守卫：映射的每个结果都必须是真实存在的分组 id
  for (const channel of ['douyin', 'toutiao', 'xiaohongshu'] as const) {
    const target = loginSectionOf(channel);
    assert.ok(
      settingsSections.some((section) => section.id === target),
      `loginSectionOf('${channel}') 指向了不存在的分组 ${target}`,
    );
  }
});

test('三个渠道各自映射到**不同**的分组（不许两个渠道落到同一组）', () => {
  const targets = (['douyin', 'toutiao', 'xiaohongshu'] as const).map(loginSectionOf);
  assert.equal(new Set(targets).size, 3);
});
