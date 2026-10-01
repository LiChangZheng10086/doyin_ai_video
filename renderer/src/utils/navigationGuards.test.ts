import assert from 'node:assert/strict';
import { test } from 'node:test';
import { benchmarkDirty, blockedNavigationAction, articleDialogCloseDecision } from './navigationGuards.js';

/**
 * 三处「界面把自己锁死」的回归。
 *
 * 共同症状：页面看上去完全正常、也没有任何提示，但**点任何导航都没反应**。
 * 之所以难查，是因为三处都不是崩溃、不是报错，而是「拦截器/弹窗缺了一个出口」。
 */

test('对标页：折叠起来的「新建对标组」表单不算未保存编辑（否则会在看不见任何待保存内容时拦死导航）', () => {
  const base = { settings: false, editor: false, creating: false, newName: '', newAudience: '', newKeywords: '' };
  assert.equal(benchmarkDirty(base), false);

  // ⚠️ 核心回归：表单收起了，但输入还留着（已进 sessionStorage，展开即可恢复）——不得算 dirty。
  assert.equal(benchmarkDirty({ ...base, creating: false, newName: '科技', newKeywords: 'AI' }), false);

  // 表单真的展开且填了内容，才算未保存编辑（此时它就在页面上，用户看得见）。
  assert.equal(benchmarkDirty({ ...base, creating: true, newName: '科技' }), true);
  assert.equal(benchmarkDirty({ ...base, creating: true, newKeywords: 'AI' }), true);
  assert.equal(benchmarkDirty({ ...base, creating: true, newAudience: '产品经理' }), true);

  // 只有空白字符等于没填。
  assert.equal(benchmarkDirty({ ...base, creating: true, newName: '   ', newKeywords: '\n' }), false);

  // 领域/门槛与账号编辑是浮层表单，与「新建组」是否展开无关。
  assert.equal(benchmarkDirty({ ...base, settings: true }), true);
  assert.equal(benchmarkDirty({ ...base, editor: true }), true);
});

test('文章详情页：busy 时也必须给出明确归宿，绝不能把 blocker 挂在 blocked 上', () => {
  // ⚠️ 核心回归：早先是 `if (busy) return;` —— 既不 proceed 也不 reset，
  // 此后每次导航都被静默吞掉且不弹提示。现在必须返回一个动作，且不打扰用户。
  let confirmCalls = 0;
  const confirm = () => { confirmCalls++; return true; };
  assert.equal(blockedNavigationAction({ busy: true, dirty: true, confirm }), 'reset');
  assert.equal(blockedNavigationAction({ busy: true, dirty: false, confirm }), 'reset');
  assert.equal(confirmCalls, 0, '忙时不该弹窗打断，但一定要把拦截解除');

  // 正常路径：有未保存编辑 → 由确认框决定去留。
  assert.equal(blockedNavigationAction({ busy: false, dirty: true, confirm: () => true }), 'proceed');
  assert.equal(blockedNavigationAction({ busy: false, dirty: true, confirm: () => false }), 'reset');

  // 没有未保存编辑 → 直接放行，不该弹窗。
  let asked = 0;
  assert.equal(blockedNavigationAction({ busy: false, dirty: false, confirm: () => { asked++; return true; } }), 'proceed');
  assert.equal(asked, 0);
});

test('文章包弹窗：busy 时必须仍关得掉（Modal 会给 #root 设 inert，关不掉＝整个应用点击失效）', () => {
  const clean = { busy: false, promptBusy: false, dirty: false, created: false };

  // ⚠️ 核心回归：请求挂住时（默认超时 16 分钟）也要有一条退路，但必须经用户明确确认。
  assert.equal(articleDialogCloseDecision({ ...clean, busy: true, dirty: true, confirm: () => true }), 'close');
  assert.equal(articleDialogCloseDecision({ ...clean, promptBusy: true, dirty: true, confirm: () => true }), 'close');
  assert.equal(articleDialogCloseDecision({ ...clean, busy: true, confirm: () => false }), 'stay', '用户没确认就不能静默关掉');

  // busy 优先：此时不该再问「放弃未保存内容？」那第二个问题。
  const asked: string[] = [];
  articleDialogCloseDecision({ ...clean, busy: true, dirty: true, confirm: (message) => { asked.push(message); return true; } });
  assert.equal(asked.length, 1);
  assert.match(asked[0]!, /不会中断后台请求/);

  // 不忙时保持原有语义：未创建且动过内容才确认放弃。
  assert.equal(articleDialogCloseDecision({ ...clean, dirty: true, confirm: () => false }), 'stay');
  assert.equal(articleDialogCloseDecision({ ...clean, dirty: true, confirm: () => true }), 'close');
  assert.equal(articleDialogCloseDecision({ ...clean, dirty: true, created: true, confirm: () => false }), 'close', '已创建后不再当作未保存编辑');
  assert.equal(articleDialogCloseDecision({ ...clean, confirm: () => true }), 'close');
});
