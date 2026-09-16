# 侧栏可折叠 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让桌面端左侧主导航栏可以展开/收起；展开时显示导航项文字，收起时保持现有纯图标外观，并记住用户的选择。

**Architecture:** 折叠状态由 `AppShell` 持有（`useState` + localStorage 初始值），通过 props 传给 `PrimaryRail`。侧栏宽度收敛为单一 CSS 自定义属性 `--rail-w`，由 `AppShell` 根节点按状态声明，`PrimaryRail` / 内容区 / 两个顶栏变体一律消费它，消除现在分散在四处的硬编码偏移。

**Tech Stack:** React 19、TypeScript、Tailwind CSS v4（使用 `[--var:value]` 任意属性与 `w-[var(--rail-w)]` 任意值）、lucide-react、Node 内置 test runner（`node --import tsx --test`）。

**Spec:** `docs/superpowers/specs/2026-09-16-collapsible-rail-design.md`

## Global Constraints

- 收起态视觉必须与改动前**逐像素一致**：`md` 56px、`xl` 64px，展开态统一 208px。
- 侧栏宽度只允许有一个真源（`--rail-w`）；任何地方都不得再写死 `56px` / `64px` 的偏移。
- 不引入新的 zustand store；UI 偏好沿用「localStorage + 组件状态」。
- localStorage 读写必须容错：读失败回落 `false`（收起），写失败静默忽略。
- `AppShell` 取初始值前必须判断 `typeof window !== 'undefined'`（组件测试在 Node 中静态渲染，没有 `window`）。
- 不改 `navigation.ts` 的导航数据、路由与权限；不动移动端底部导航。
- 不做 hover 自动展开、不做窄窗口自动收起。
- 提交时只暂存本特性的文件。

### Task 1: 折叠偏好读写工具（测试先行）

**Files:**
- Create: `renderer/src/utils/railPreference.ts`
- Test: `renderer/src/utils/railPreference.test.ts`

**Interfaces:**
- Consumes: 浏览器 `Storage`（结构类型，便于注入假实现）
- Produces: `readStoredRailExpanded(storage: Storage): boolean`、`writeStoredRailExpanded(storage: Storage, expanded: boolean): void`

- [ ] **Step 1: 写失败用例**

沿用 `renderer/src/features/jobs/jobPresentation.test.ts:113` 对 `readStoredViewMode` 的三条口径：

- 键缺失 → `false`（默认收起）
- 存入 `'1'` → `true`；存入任意非法值（如 `'yes'`、`''`）→ `false`
- `storage.getItem` 抛错 → `false`（不冒泡）
- `writeStoredRailExpanded(storage, true)` 写入布尔语义值；`storage.setItem` 抛错时不抛异常

- [ ] **Step 2: 运行聚焦测试确认失败**

Run: `node --import tsx --test renderer/src/utils/railPreference.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现工具模块**

按键名 `douyin-ai-video.rail-expanded` 读写，读写各自包 try/catch；读取只认 `'1'` 为展开，其余一律 `false`。

- [ ] **Step 4: 运行聚焦测试确认通过**

Run: `node --import tsx --test renderer/src/utils/railPreference.test.ts`
Expected: PASS。

### Task 2: PrimaryRail 接入展开态与折叠按钮（测试先行）

**Files:**
- Modify: `renderer/src/components/shell/PrimaryRail.tsx`
- Test: `renderer/src/components/shell/PrimaryRail.test.tsx`（新建）

**Interfaces:**
- Consumes: `PRIMARY_NAV_ITEMS` / `SECONDARY_NAV_ITEMS`（已有 `label`）、`readStoredRailExpanded` 的语义
- Produces: `PrimaryRail({ expanded, onToggle })`；`nav` 宽度使用 `md:w-[var(--rail-w)]`

- [ ] **Step 1: 写失败用例**

用 `renderToStaticMarkup` + `MemoryRouter`（组件内部使用 `useLocation`）断言：

- `expanded: false` → 渲染结果**不含**任何导航 label（作品/合集/Skills/发布/垃圾桶/设置）
- `expanded: true` → 上述 6 个 label **全部出现**
- 折叠按钮存在，且 `aria-expanded` 随 `expanded` 变化；`aria-label` 分别为「展开侧栏」/「收起侧栏」
- `nav` 的 class 使用 `md:w-[var(--rail-w)]`，且**不再**出现 `md:w-[56px]` / `xl:w-16`

- [ ] **Step 2: 运行聚焦测试确认失败**

Run: `node --import tsx --test renderer/src/components/shell/PrimaryRail.test.tsx`
Expected: FAIL —— `PrimaryRail` 尚不接受 props，且标签不渲染。

- [ ] **Step 3: 实现**

`PrimaryRail` 接收 `{ expanded, onToggle }`：顶部 logo 行收起时居中、展开时 logo 与折叠按钮同排；导航项在 `expanded` 时渲染 `<span>{item.label}</span>`（图标左对齐、保留激活项左侧 3px 蓝色指示条），收起时保持现在的纯图标居中；宽度改为 `md:w-[var(--rail-w)]` 并加宽度过渡。

- [ ] **Step 4: 运行聚焦测试确认通过**

Run: `node --import tsx --test renderer/src/components/shell/PrimaryRail.test.tsx`
Expected: PASS。

### Task 3: AppShell 持有状态并声明 `--rail-w`（测试先行）

**Files:**
- Modify: `renderer/src/components/shell/AppShell.tsx`
- Modify: `renderer/src/components/shell/UtilityBar.tsx`
- Test: `renderer/src/components/shell/AppShell.test.tsx`（新建）

**Interfaces:**
- Consumes: `readStoredRailExpanded` / `writeStoredRailExpanded`（Task 1）、`PrimaryRail` 的 `expanded`/`onToggle`（Task 2）
- Produces: 根节点上的 `--rail-w`；内容区与两个顶栏改用 `var(--rail-w)`

- [ ] **Step 1: 写失败用例**

在 Node 中用 `renderToStaticMarkup` + `MemoryRouter` 渲染 `AppShell`：

- 无 `window` 时不抛错（静态渲染必须能跑通），且根节点带 `md:[--rail-w:56px] xl:[--rail-w:64px]`（默认收起）
- 传 `initialExpanded: true` 时根节点带 `[--rail-w:208px]`
- 内容区 class 使用 `md:ml-[var(--rail-w)]`，且**不再**出现 `md:ml-[56px]` / `xl:ml-16`

为可测试性，`AppShell` 接受一个可选 `initialExpanded?: boolean`（默认由 localStorage 决定），测试用它可以绕开 `window`。

- [ ] **Step 2: 运行聚焦测试确认失败**

Run: `node --import tsx --test renderer/src/components/shell/AppShell.test.tsx`
Expected: FAIL —— 根节点尚无 `--rail-w`，内容区仍是硬编码偏移。

- [ ] **Step 3: 实现 AppShell**

初始值：`initialExpanded ?? (typeof window !== 'undefined' ? readStoredRailExpanded(window.localStorage) : false)`；切换时 `setState` 并 `writeStoredRailExpanded`；根节点按状态声明 `--rail-w`；内容区偏移改 `md:ml-[var(--rail-w)]`。

- [ ] **Step 4: 实现 UtilityBar 两处偏移**

`UtilityBar`（窄屏顶栏）改 `left-0 md:left-[var(--rail-w)]`；`UtilityBarDesktop` 改 `left-14 md:left-[var(--rail-w)]`。两处都加 `transition-[left]`。

- [ ] **Step 5: 运行聚焦测试确认通过**

Run: `node --import tsx --test renderer/src/components/shell/AppShell.test.tsx renderer/src/components/shell/PrimaryRail.test.tsx`
Expected: PASS。

### Task 4: 全量验证与人工复核

**Files:**
- 无源码改动（验证步骤）

- [ ] **Step 1: 类型检查**

Run: `npm run check`
Expected: 双端 `tsc --noEmit` 退出码 0。

- [ ] **Step 2: 全量测试**

Run: `npm test`
Expected: 新增用例全部通过；除既有失败 `src/lib/publishing-service.test.ts` → `startup recovery reports asset phases before due handling and purge` 外无新增失败。基线 373 项（371 通过 / 1 跳过 / 1 失败）。

- [ ] **Step 3: 静态确认宽度真源唯一**

```bash
grep -rn "56px\]\|ml-16\|left-16" renderer/src/components/shell/
```

Expected: 只剩 `AppShell` 里声明 `--rail-w` 的那一处 `md:[--rail-w:56px] xl:[--rail-w:64px]`，其余偏移一律为 `var(--rail-w)`。

- [ ] **Step 4: 人工复核**

Vite HMR 生效，无需重启。在应用窗口（`md` 以上宽度）确认：

1. 默认收起，外观与改动前一致
2. 点顶部按钮展开 → 6 个导航 label 可见，图标左对齐，激活项蓝条仍在
3. 展开时内容区与两个顶栏一起右移，**无重叠、无缝隙**
4. 刷新后保持上次选择
5. 缩小到 `md` 以下 → 侧栏消失、底部导航出现，布局正常

- [ ] **Step 5: 只暂存本特性文件并提交**

```bash
git add renderer/src/utils/railPreference.ts renderer/src/utils/railPreference.test.ts \
        renderer/src/components/shell/PrimaryRail.tsx renderer/src/components/shell/PrimaryRail.test.tsx \
        renderer/src/components/shell/AppShell.tsx renderer/src/components/shell/AppShell.test.tsx \
        renderer/src/components/shell/UtilityBar.tsx
git commit -m "feat: 侧栏支持展开/收起，展开时显示导航文字"
```
