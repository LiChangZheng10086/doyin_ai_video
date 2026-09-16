# 抖创工坊 侧栏可折叠 设计规格

**状态：** APPROVED
**批准日期：** 2026-09-16
**日期：** 2026-09-16
**产品：** 抖创工坊
**范围：** 桌面端左侧主导航栏支持展开/收起；展开时显示导航项文字
**实施边界：** 只改侧栏宽度与布局耦合、折叠状态与持久化；不改导航数据、路由、权限与移动端底部导航

## 1. 背景与结论

用户反馈：左侧主导航栏固定不变，希望它能展开/收起，展开时显示对应图标的文字。

现状（`renderer/src/components/shell/`）：

- `PrimaryRail.tsx:35` 的 `nav` 宽度写死为 `w-14 md:w-[56px] xl:w-16`，导航项是 48×48 的纯图标链接（`justify-center`），只有 `title` 与 `aria-label` 提供文字，界面上看不到 label。
- 侧栏宽度**被硬编码在四处**，这是本次改动的主要风险：

| 位置 | 现有写法 |
| --- | --- |
| `PrimaryRail.tsx:35` | `w-14 md:w-[56px] xl:w-16` |
| `AppShell.tsx:35`（内容区） | `md:ml-[56px] xl:ml-16` |
| `UtilityBar.tsx:15`（窄屏顶栏） | `left-0 md:left-[56px] xl:left-16` |
| `UtilityBar.tsx:28`（桌面顶栏） | `left-14 md:left-[56px] xl:left-16` |

若只把侧栏加宽而不同步这四处偏移，内容会被压住或露出缝隙。

- 侧栏仅在 `md:` 以上存在（`AppShell.tsx:24` 的 `hidden md:block`），`< md` 走底部 `MobileNavigation`，因此本特性是桌面端特性。
- 导航数据（`navigation.ts`）的 `PRIMARY_NAV_ITEMS` / `SECONDARY_NAV_ITEMS` 已带 `label`（作品 / 合集 / Skills / 发布 / 垃圾桶 / 设置），无需改动数据源。

## 2. 已确认设计决策

| 决策 | 结果 |
| --- | --- |
| 展开方式 | 侧栏顶部折叠按钮点击切换（非 hover 自动展开） |
| 展开时布局 | **推挤**内容区（不做覆盖式浮层） |
| 默认状态 | 收起 —— 与现有视觉完全一致 |
| 状态持久化 | localStorage，沿用 `readStoredViewMode` 的写法 |
| 展开宽度 | 208px（`--rail-w`） |
| 收起宽度 | 保持现有细节：`md` 56px / `xl` 64px |
| 窄窗口 | 不自动收起（避免与手动切换互相打架） |
| 文字标签 | 展开时图标与文字同排 |
| 移动端 | 完全不涉及 |

## 3. 布局耦合：宽度单一真源

引入 CSS 自定义属性 `--rail-w`，由 `AppShell` 根节点声明，其余三处消费。Tailwind 为 v4，支持 `[--var:value]` 任意属性与 `w-[var(--rail-w)]` 任意值。

```jsx
// AppShell 根节点：唯一所有者
<div className={`min-h-screen bg-canvas ${railExpanded
  ? '[--rail-w:208px]'
  : 'md:[--rail-w:56px] xl:[--rail-w:64px]'}`}>
```

| 位置 | 改为 |
| --- | --- |
| `PrimaryRail` | `md:w-[var(--rail-w)]` |
| `AppShell` 内容区 | `md:ml-[var(--rail-w)]` |
| `UtilityBar`（窄屏顶栏） | `left-0 md:left-[var(--rail-w)]` |
| `UtilityBarDesktop` | `left-14 md:left-[var(--rail-w)]` |

**收起态刻意保留 `md:56px / xl:64px`**，使默认外观与改动前逐像素一致；展开态在两种断点下统一 208px。

过渡：侧栏 `transition-[width]`，消费方 `transition-[margin]` / `transition-[left]`，避免宽度突变。

## 4. 状态与持久化

- 状态由 `AppShell` 用 `useState` 持有（初始值读 localStorage），向 `PrimaryRail` 传 `expanded` 与 `onToggle`。
- **不引入新的 zustand store**：本项目的 zustand 仅用于操作者身份，UI 偏好一直是「localStorage + 组件状态」（`JobListPage` 的 `viewMode` 即此模式）。
- 新增工具模块 `renderer/src/utils/railPreference.ts`：

```ts
export function readStoredRailExpanded(storage: Storage): boolean
export function writeStoredRailExpanded(storage: Storage, expanded: boolean): void
```

写法对齐 `features/jobs/jobPresentation.ts:170` 的 `readStoredViewMode`：**try/catch 吞掉隐私模式或配额异常，并回落到安全默认值**（`false` = 收起）。存储键形如 `douyin-ai-video.rail-expanded`。

注意 `AppShell` 会被组件测试在 Node 中渲染（`renderToStaticMarkup`），那里没有 `window`。因此 `AppShell` 取初始值时必须先判断 `typeof window !== 'undefined'` 再访问 `window.localStorage`，静态渲染时回落为收起态 —— 否则组件测试会直接抛错。

## 5. 交互与可访问性

- 折叠按钮位于侧栏顶部 logo 行：收起时居中显示 logo；展开时 logo 与按钮同排。
- 按钮属性：`aria-expanded={expanded}`、`aria-label`（「收起侧栏」/「展开侧栏」）、`title` 同文案。
- 导航项：展开时渲染 `<span>{item.label}</span>`；收起时不渲染文字，仅保留 `aria-label` 与 `title`（悬停提示继续可用）。
- 展开态保留激活项左侧那条 3px 蓝色指示条（现有语义不因展开而丢失）。

## 6. 明确不做

- 移动端底部导航（`< md` 无侧栏）
- 导航数据源 `navigation.ts` 与路由、权限
- hover 自动展开（已选择按钮切换）
- 窄于某断点自动收起
- 侧栏内容重构（分组、折叠子菜单等）

## 7. 测试与验证

| 类别 | 内容 |
| --- | --- |
| 工具模块 | `readStoredRailExpanded`：缺省 → `false`；`'1'` → `true`；**storage 抛错 → `false`**；`writeStoredRailExpanded` 正常写入且抛错时不冒泡 |
| `PrimaryRail` | 收起态不渲染任何导航 label；展开态渲染全部 6 个 label；折叠按钮 `aria-expanded` 随 `expanded` 变化 |
| `AppShell` | 根节点在两种状态下分别带 `[--rail-w:208px]` 与 `md:[--rail-w:56px] xl:[--rail-w:64px]` —— 宽度耦合全靠它，必须用断言守住 |

**验证命令**：`npm run check`、`npm test`。测试基线 373 项 / 371 通过 / 1 跳过 / 1 既有失败（`src/lib/publishing-service.test.ts`，与本特性无关）。

**渲染层无需重启**：Vite HMR 生效；本特性不涉及后端。

**人工验证**（`cdp_*` / `computer_*` 在本 DSH 版本尚未重启宿主，见交接文档第 9、10 节）：点击顶部按钮展开/收起、展开后 6 个 label 可见、内容区随宽度平移无重叠或缝隙、刷新后保持上次选择。若宿主已重启，可用 `cdp_shot` / `cdp_assert` 断言宽度。

## 8. 风险

| 风险 | 处理 |
| --- | --- |
| 四处宽度偏移不同步 | 收敛为单一 CSS 变量，并用 `AppShell` 断言守住该变量 |
| 展开后窄窗口内容过挤 | 不自动收起（保持可预期），由用户手动收回；已在决策表中说明 |
| localStorage 不可用（隐私模式） | 读失败回落 `false`、写失败静默忽略，与 `viewMode` 一致 |
| 收起态视觉回归 | 收起态显式保留 `md:56px / xl:64px`，不改变现有外观 |

## 9. 影响面

| 文件 | 改动 |
| --- | --- |
| `renderer/src/utils/railPreference.ts` | 新增：读写折叠偏好 |
| `renderer/src/utils/railPreference.test.ts` | 新增用例 |
| `renderer/src/components/shell/PrimaryRail.tsx` | 接收 `expanded`/`onToggle`；宽度改用 `--rail-w`；展开时渲染文字；新增折叠按钮 |
| `renderer/src/components/shell/AppShell.tsx` | 持有折叠状态；根节点声明 `--rail-w`；内容区偏移改用变量 |
| `renderer/src/components/shell/UtilityBar.tsx` | 两处顶栏偏移改用变量 |
| `renderer/src/components/shell/PrimaryRail.test.tsx` | 新增：组件级断言 |
