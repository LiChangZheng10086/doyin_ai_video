/**
 * 导航/退出拦截的判定（纯函数，只在这里定义一份）。
 *
 * 为什么单独成模块：① 组件文件里导出非组件值是**破坏 React Fast Refresh** 的写法
 * （Vite 会报 `Could not Fast Refresh (... export is incompatible)`，改这两个页面时热更会退化成整页刷新）；
 * ② 这三个判定都是「界面会不会把自己锁死」的关键不变式，必须有用例守。
 *
 * 它们共同的来历：2026-10-01 用户报「在文章创作页无法切换到其他页面」——
 * 页面看上去完全正常、也没有任何提示，但点任何导航都没反应。
 * 三处都不是崩溃、不是报错，而是**拦截器/弹窗缺了一个出口**。
 */

/**
 * 对标页「编辑尚未保存」的判定 —— 决定 `useBlocker` 要不要拦下导航。
 *
 * ⚠️ **折叠起来的「新建对标组」表单不算未保存编辑**。
 * 它的输入已经逐字进 sessionStorage（重新展开即可恢复），把它算进 dirty
 * 只会制造一种最难查的故障：页面上**看不到任何待保存的内容**，导航却被静默全部拦下。
 */
export function benchmarkDirty(state: {
  settings: boolean;
  editor: boolean;
  creating: boolean;
  newName: string;
  newAudience: string;
  newKeywords: string;
}): boolean {
  return (
    state.settings ||
    state.editor ||
    (state.creating && Boolean(state.newName.trim() || state.newAudience.trim() || state.newKeywords.trim()))
  );
}

/**
 * 文章详情页 blocker 处于 `blocked` 时该 `proceed` 还是 `reset`。
 *
 * ⚠️ 必须**总是**返回一个动作。早先这里是 `if (busy) return;` —— 请求在途时既不前进也不复位，
 * blocker 就**永远停在 `blocked`**：此后每一次导航都被静默吞掉、连一次提示都不弹。
 * 与素材页 / 热点页同一口径：忙时不打断离开，但**一定 `reset`** 把拦截解除。
 */
export function blockedNavigationAction(input: {
  busy: boolean;
  dirty: boolean;
  confirm: (message: string) => boolean;
}): 'proceed' | 'reset' {
  if (input.busy) return 'reset';
  if (!input.dirty) return 'proceed';
  return input.confirm('编辑尚未保存，保留本地草稿并离开？') ? 'proceed' : 'reset';
}

/**
 * 文章包弹窗的关闭决策。
 *
 * ⚠️ 不变式：**任何状态下都必须有可能关闭**。Modal 打开时会给 `#root` 设 `inert`
 * （整个应用不可点），而 Esc / 点遮罩 / 右上角 X 三条退路在 busy 时都被 Modal 自己封死，
 * 唯一通道就是 footer 的「取消」→ 这个函数。早先这里是 `if (busy) return;`，
 * 于是请求挂住时（默认超时 16 分钟）应用变成既关不掉也点不动的死胡同。
 * 忙时改为**显式确认后可关**：后台请求不中断，结果仍能在发布中心看到。
 */
export function articleDialogCloseDecision(input: {
  busy: boolean;
  promptBusy: boolean;
  dirty: boolean;
  created: boolean;
  confirm: (message: string) => boolean;
}): 'close' | 'stay' {
  if (input.busy || input.promptBusy) {
    return input.confirm('操作仍在进行。关闭不会中断后台请求，结果可在发布中心查看。确定关闭？') ? 'close' : 'stay';
  }
  if (!input.created && input.dirty && !input.confirm('文章或提示词有未保存内容，放弃并关闭？')) return 'stay';
  return 'close';
}
