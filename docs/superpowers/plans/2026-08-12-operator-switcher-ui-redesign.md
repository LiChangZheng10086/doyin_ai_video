# 操作者切换入口 UI 重设计实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将顶部操作者区域改为紧凑身份按钮和可访问的切换菜单，同时保持现有会话、权限和 PIN 流程不变。

**Architecture:** 继续由 `OperatorSwitcher` 负责操作者状态和切换行为，只替换可见入口与菜单结构。菜单使用组件本地状态、按钮和菜单项实现，管理员切换仍复用现有 PIN Portal；`AppShell`、状态指示器和后端接口不改。

**Tech Stack:** React 19、TypeScript、Zustand、Tailwind CSS、lucide-react、Node test runner、React server rendering。

## Global Constraints

- API 已连接状态和抖音登录状态保持不变。
- 不改变本地用户数据结构、权限判断、PIN 验证和会话接口。
- 不再使用原生 `<select>` 作为操作者入口。
- 桌面和移动端复用同一操作者数据与行为。
- 保留 Escape 关闭、焦点返回、无障碍标签和切换中的禁用状态。

### Task 1: 建立操作者入口回归测试

**Files:**
- Create: `renderer/src/components/OperatorSwitcher.test.tsx`
- Modify: `renderer/src/components/OperatorSwitcher.tsx` only as needed for testable exports

**Interfaces:**
- Consumes: `LocalUser` data and existing `useOperatorStore` behavior.
- Produces: static markup assertions for the compact identity trigger, menu semantics, role labels, and absence of the native select.

- [x] **Step 1: Write the failing test**

使用 `renderToStaticMarkup` 验证操作者入口包含 `aria-haspopup="menu"`、当前角色标签、菜单项语义和 `ChevronDown` 对应的入口，同时断言不包含 `<select`。

- [x] **Step 2: Run the focused test to verify it fails**

Run: `node --import tsx --test renderer/src/components/OperatorSwitcher.test.tsx`

Expected: FAIL because the current component still renders a native select and has no menu trigger.

- [x] **Step 3: Commit the test-only checkpoint**

由于当前工作区已有其他未提交改动，本任务最终只暂存计划、组件和新测试文件，避免混入无关文件；测试先以失败状态确认边界，随后与实现一起提交：

```bash
git add renderer/src/components/OperatorSwitcher.test.tsx
git commit -m "test: define operator switcher menu contract"
```

### Task 2: 实现紧凑身份按钮和操作者菜单

**Files:**
- Modify: `renderer/src/components/OperatorSwitcher.tsx`
- Test: `renderer/src/components/OperatorSwitcher.test.tsx`

**Interfaces:**
- Consumes: existing `users`, `currentUser`, `switchUser`, `signOut`, `onRequestRecovery`.
- Produces: a button trigger with menu semantics and menu actions that call the existing store methods.

- [x] **Step 1: Add menu state and focus references**

增加 `menuOpen` 状态、触发按钮 ref 和菜单 ref；使用 document-level `mousedown` 与 `keydown` 监听，在点击外部或 Escape 时关闭菜单。菜单关闭时把焦点返回触发按钮。

- [x] **Step 2: Replace the duplicated text/select layout**

将当前用户名文本、用户图标和 `<select>` 替换为：圆形首字母头像、用户名、角色小标签、`ChevronDown` 的紧凑按钮。按钮设置 `aria-haspopup="menu"`、`aria-expanded` 和明确标签，长用户名使用 `truncate`。

- [x] **Step 3: Render the menu items**

菜单展示当前操作者信息、所有启用用户、当前用户选中状态和退出操作。普通用户直接调用 `switchUser`；管理员先设置 `pendingAdmin` 并打开现有 PIN 弹窗；退出调用现有 `signOut`。未登录时保留“选择操作者”和“重置本地用户”。

- [x] **Step 4: Preserve PIN dialog behavior**

保留当前 PIN Portal、焦点陷阱、错误信息、取消和成功后的焦点返回，仅把触发按钮改为新的身份入口。

- [x] **Step 5: Run focused tests**

Run: `node --import tsx --test renderer/src/components/OperatorSwitcher.test.tsx`

Expected: PASS; markup exposes menu semantics and no native select.

- [x] **Step 6: Commit the focused UI change**

```bash
git add renderer/src/components/OperatorSwitcher.tsx renderer/src/components/OperatorSwitcher.test.tsx
git commit -m "feat: redesign operator switcher menu"
```

### Task 3: 全量验证桌面和移动入口

**Files:**
- Modify: none unless validation exposes a regression in `AppShell.tsx`
- Test: existing renderer tests and new `OperatorSwitcher.test.tsx`

**Interfaces:**
- Consumes: the redesigned `OperatorSwitcher` through `UtilityBarDesktop` and `AppShell` mobile BottomSheet.
- Produces: verified desktop and mobile rendering with unchanged API and login indicators.

- [x] **Step 1: Run type checks**

Run: `npm run check`

Expected: backend and renderer TypeScript checks pass.

- [x] **Step 2: Run the complete test suite**

Run: `npm test`

Expected: all existing tests and the operator switcher tests pass.

- [x] **Step 3: Build the renderer**

Run: `npm run build:renderer`

Expected: Vite build succeeds; existing chunk-size warning is acceptable if no new error appears.

- [x] **Step 4: Inspect the final diff**

Run: `git diff --check` and `git status --short`.

Expected: no whitespace errors; only the intended operator UI files are changed by this feature, while pre-existing unrelated worktree changes remain untouched.
