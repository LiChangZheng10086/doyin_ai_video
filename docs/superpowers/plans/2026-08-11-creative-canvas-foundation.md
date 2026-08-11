# Creative Canvas Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the shared visual tokens, UI primitives, responsive application shell, and test coverage that every Creative Canvas page will use.

**Architecture:** Keep React Router and the existing startup/session state machine in `App.tsx`, but move normal-running chrome into focused `shell` components. Shared UI primitives remain presentation-only and accept explicit props; domain pages continue to own API calls and business state.

**Tech Stack:** React 19, TypeScript 5.8, React Router 7, Tailwind CSS 4, Lucide React, Node test runner, React server rendering

## Global Constraints

- Preserve all existing routes, APIs, task states, permissions, local data, and Electron bridge behavior.
- Use Simplified Chinese for interface copy; retain only necessary proper nouns such as `Skills` and model names.
- Use `lucide-react` for functional icons; do not add Emoji icons.
- Use blue `#2563EB` for primary actions and violet `#7C3AED` only for AI/Skill emphasis.
- Ordinary controls and cards use 6-8px radii; modal dialogs may use 12px.
- Do not add a component library or replace Tailwind CSS.
- Desktop navigation is a fixed left rail; viewports below 768px use bottom navigation.
- Status must never rely on color alone; include text or an icon.
- Respect `prefers-reduced-motion`; mobile targets are at least 44px and desktop targets at least 36px.
- This plan must land before the creation, collection, or operations plans.

---

### Task 1: Make Renderer Tests and Type Checking Part of the Default Gate

**Files:**
- Modify: `package.json`
- Test: `renderer/src/components/LocalUsersSettings.test.tsx`

**Interfaces:**
- Consumes: Node's existing `--import tsx --test` runner.
- Produces: `npm test` discovers both `renderer/src/**/*.test.ts` and `renderer/src/**/*.test.tsx`; `npm run check` checks backend and renderer TypeScript.

- [ ] **Step 1: Prove the existing TSX test is skipped**

Run:

```bash
npm test 2>&1 | tee /tmp/douyin-tests-before.txt
rg "PIN dialog static structure" /tmp/douyin-tests-before.txt
```

Expected: the `rg` command exits non-zero because the current script does not include `.test.tsx` files.

- [ ] **Step 2: Extend the default test glob**

Change the `test` script to:

```json
"test": "node --import tsx --test \"src/**/*.test.ts\" \"electron/**/*.test.ts\" \"renderer/src/**/*.test.ts\" \"renderer/src/**/*.test.tsx\""
```

- [ ] **Step 3: Wire the existing renderer TypeScript configuration into the default check**

The repository already contains `tsconfig.renderer.json`. Keep its compiler options unchanged and update package scripts:

```json
"check": "npm run check:backend && npm run check:renderer",
"check:backend": "tsc -p tsconfig.json --noEmit",
"check:renderer": "tsc -p tsconfig.renderer.json --noEmit"
```

- [ ] **Step 4: Verify the TSX test and both type checks now run**

Run:

```bash
npm test 2>&1 | tee /tmp/douyin-tests-after.txt
rg "PIN dialog static structure" /tmp/douyin-tests-after.txt
npm run check
```

Expected: the named test is present, the full suite passes, and both backend/renderer type checks exit 0. If the new renderer check exposes existing errors, fix only genuine type errors without changing runtime behavior and include those files in this task's commit.

- [ ] **Step 5: Commit**

```bash
git add package.json renderer/src
git commit -m "test: gate renderer components and types"
```

### Task 2: Establish Creative Canvas Tokens and Global Focus Rules

**Files:**
- Modify: `renderer/src/index.css`
- Delete: `renderer/src/styles/globals.css`
- Test: `renderer/src/styles/theme.test.ts`

**Interfaces:**
- Consumes: Tailwind 4 `@theme` tokens already referenced as `tech-*` classes.
- Produces: backward-compatible `tech-*` aliases plus new canvas tokens and global focus/reduced-motion behavior.

- [ ] **Step 1: Write the failing token contract test**

Create `renderer/src/styles/theme.test.ts`:

```typescript
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('creative canvas tokens and accessibility rules are defined globally', async () => {
  const css = await readFile(new URL('../index.css', import.meta.url), 'utf8');
  assert.match(css, /--color-canvas:\s*#F6F8FB/i);
  assert.match(css, /--color-brand-blue:\s*#2563EB/i);
  assert.match(css, /--color-brand-violet:\s*#7C3AED/i);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /letter-spacing:\s*0/);
});
```

- [ ] **Step 2: Run the test and verify failure**

Run:

```bash
node --import tsx --test renderer/src/styles/theme.test.ts
```

Expected: FAIL because `--color-canvas` and the global accessibility rules do not exist.

- [ ] **Step 3: Replace the global token definitions**

Keep current `tech-*` names as aliases so unmigrated pages remain intact, and add these exact rules to `renderer/src/index.css`:

```css
@import "tailwindcss";

@theme {
  --color-brand-blue: #2563EB;
  --color-brand-blue-dark: #1E40AF;
  --color-brand-violet: #7C3AED;
  --color-canvas: #F6F8FB;
  --color-surface: #FFFFFF;
  --color-border: #DCE3EC;
  --color-text-primary: #172033;
  --color-text-secondary: #667085;

  --color-tech-blue: #2563EB;
  --color-tech-blue-light: #3B82F6;
  --color-tech-blue-dark: #1E40AF;
  --color-tech-purple: #7C3AED;
  --color-tech-purple-light: #A78BFA;
  --color-tech-purple-dark: #5B21B6;
  --color-tech-cyan: #0891B2;
  --color-tech-bg: #F6F8FB;
  --color-tech-surface: #FFFFFF;
  --color-tech-border: #DCE3EC;
  --color-tech-text: #172033;
  --color-tech-muted: #667085;
}

:root {
  color: #172033;
  background: #F6F8FB;
  font-synthesis: none;
}

* { box-sizing: border-box; letter-spacing: 0; }
html { background: #F6F8FB; }
body {
  min-width: 320px;
  min-height: 100vh;
  margin: 0;
  background: #F6F8FB;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
button, input, textarea, select { font: inherit; }
button, summary { -webkit-tap-highlight-color: transparent; }
:focus-visible { outline: 2px solid #2563EB; outline-offset: 2px; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    scroll-behavior: auto !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

Delete the unused `renderer/src/styles/globals.css`; confirm it has no imports before deletion with `rg "styles/globals" renderer/src`.

- [ ] **Step 4: Run focused and renderer build checks**

Run:

```bash
node --import tsx --test renderer/src/styles/theme.test.ts
npm run build:renderer
```

Expected: PASS and the renderer builds without unresolved legacy token classes.

- [ ] **Step 5: Commit**

```bash
git add renderer/src/index.css renderer/src/styles/theme.test.ts renderer/src/styles/globals.css
git commit -m "style: establish creative canvas tokens"
```

### Task 3: Add Shared Status and Feedback Primitives

**Files:**
- Create: `renderer/src/components/ui/StatusIndicator.tsx`
- Create: `renderer/src/components/ui/IconButton.tsx`
- Create: `renderer/src/components/ui/EmptyState.tsx`
- Create: `renderer/src/components/ui/InlineNotice.tsx`
- Create: `renderer/src/components/ui/feedback.test.tsx`

**Interfaces:**
- Produces: `StatusTone`, `StatusIndicator`, `IconButton`, `EmptyState`, and `InlineNotice` for all later plans.
- `StatusIndicator` signature: `({ tone, label, icon?, busy?, compact? }: StatusIndicatorProps) => JSX.Element`.
- `IconButton` extends native button props and requires `label: string`.
- `EmptyState` accepts `icon`, `title`, optional `description`, and optional `action`.
- `InlineNotice` accepts `tone: Exclude<StatusTone, 'neutral' | 'ai'>`, `title`, and children.

- [ ] **Step 1: Write failing static markup tests**

Create `renderer/src/components/ui/feedback.test.tsx`:

```tsx
import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { EmptyState } from './EmptyState.js';
import { IconButton } from './IconButton.js';
import { InlineNotice } from './InlineNotice.js';
import { StatusIndicator } from './StatusIndicator.js';

test('status and notices expose text in addition to semantic color', () => {
  const status = renderToStaticMarkup(<StatusIndicator tone="processing" label="生成中" busy />);
  const notice = renderToStaticMarkup(<InlineNotice tone="warning" title="缺少封面">发布前补充封面</InlineNotice>);
  assert.match(status, />生成中</);
  assert.match(status, /role="status"/);
  assert.match(notice, /role="status"/);
  assert.match(notice, />缺少封面</);
});

test('icon buttons have an accessible label and empty states accept one action', () => {
  const button = renderToStaticMarkup(<IconButton label="刷新" icon={RefreshCw} />);
  const empty = renderToStaticMarkup(<EmptyState icon={AlertTriangle} title="没有作品" action={<button>创建作品</button>} />);
  assert.match(button, /aria-label="刷新"/);
  assert.match(button, /title="刷新"/);
  assert.match(empty, />没有作品</);
  assert.equal((empty.match(/<button/g) ?? []).length, 1);
});
```

- [ ] **Step 2: Run the test and verify failure**

Run:

```bash
node --import tsx --test renderer/src/components/ui/feedback.test.tsx
```

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement the explicit primitive contracts**

Use this shared tone type and map in `StatusIndicator.tsx`:

```tsx
export type StatusTone = 'neutral' | 'info' | 'processing' | 'success' | 'warning' | 'danger' | 'ai';

const toneClasses: Record<StatusTone, string> = {
  neutral: 'border-tech-border bg-white text-tech-muted',
  info: 'border-blue-200 bg-blue-50 text-blue-700',
  processing: 'border-cyan-200 bg-cyan-50 text-cyan-700',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  warning: 'border-amber-200 bg-amber-50 text-amber-700',
  danger: 'border-red-200 bg-red-50 text-red-700',
  ai: 'border-purple-200 bg-purple-50 text-purple-700',
};
```

`IconButton` must render a native `<button type="button">`, the Lucide component at size 17, `aria-label={label}`, and `title={label}`. `EmptyState` must render an unframed centered section with at most the single supplied action. `InlineNotice` must render a left-border notice using `role="alert"` only for `danger`, otherwise `role="status"`.

- [ ] **Step 4: Run focused and full renderer tests**

Run:

```bash
node --import tsx --test renderer/src/components/ui/feedback.test.tsx
npm test
npm run build:renderer
```

Expected: all tests and build pass.

- [ ] **Step 5: Commit**

```bash
git add renderer/src/components/ui
git commit -m "feat: add shared UI feedback primitives"
```

### Task 4: Add Reusable Confirmation Dialog and Mobile Sheet

**Files:**
- Create: `renderer/src/components/ui/ConfirmDialog.tsx`
- Create: `renderer/src/components/ui/BottomSheet.tsx`
- Create: `renderer/src/components/ui/overlays.test.tsx`

**Interfaces:**
- Produces: `ConfirmDialogProps` and `BottomSheetProps` consumed by all page plans.
- `ConfirmDialogProps`: `{ open, title, description, confirmLabel, cancelLabel?, tone?, busy?, onConfirm, onClose }`.
- `BottomSheetProps`: `{ open, title, children, onClose }`.

- [ ] **Step 1: Write failing overlay semantics tests**

Create tests that render both components and assert these exact behaviors:

```tsx
const dialog = renderToStaticMarkup(
  <ConfirmDialog open title="永久删除作品" description="删除后无法恢复" confirmLabel="永久删除" tone="danger" onConfirm={noop} onClose={noop} />,
);
assert.match(dialog, /role="dialog"/);
assert.match(dialog, /aria-modal="true"/);
assert.match(dialog, /永久删除作品/);
assert.match(dialog, /data-tone="danger"/);

const closed = renderToStaticMarkup(<BottomSheet open={false} title="筛选" onClose={noop}>内容</BottomSheet>);
assert.equal(closed, '');
```

- [ ] **Step 2: Run the test and verify failure**

Run `node --import tsx --test renderer/src/components/ui/overlays.test.tsx`.

Expected: FAIL because the components do not exist.

- [ ] **Step 3: Implement focus, Escape, and scroll locking**

Both components must:

- Return `null` while closed.
- Render a backdrop and `role="dialog" aria-modal="true"` surface while open.
- Save `document.activeElement`, focus the first interactive child, and restore focus on cleanup.
- `BottomSheet` and non-danger confirmation dialogs close on `Escape`; `ConfirmDialog` with `tone="danger"` ignores `Escape` and requires an explicit cancel or confirm action.
- Set `document.body.style.overflow = 'hidden'` while open and restore the prior value on cleanup.
- Keep Tab/Shift+Tab inside the dialog using a local list of `button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])`.
- Use 12px radius for the confirmation surface; the sheet is bottom-aligned below 768px and centered above it.

- [ ] **Step 4: Verify overlays**

Run:

```bash
node --import tsx --test renderer/src/components/ui/overlays.test.tsx
npm run build:renderer
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add renderer/src/components/ui/ConfirmDialog.tsx renderer/src/components/ui/BottomSheet.tsx renderer/src/components/ui/overlays.test.tsx
git commit -m "feat: add accessible overlay primitives"
```

### Task 5: Replace the Top-Heavy Header with the Responsive App Shell

**Files:**
- Create: `renderer/src/components/shell/navigation.ts`
- Create: `renderer/src/components/shell/PrimaryRail.tsx`
- Create: `renderer/src/components/shell/MobileNavigation.tsx`
- Create: `renderer/src/components/shell/UtilityBar.tsx`
- Create: `renderer/src/components/shell/AppShell.tsx`
- Create: `renderer/src/components/shell/shell.test.tsx`
- Modify: `renderer/src/App.tsx`
- Modify: `renderer/src/components/Layout.tsx`
- Modify: `renderer/src/components/ApiKeyStatusIndicator.tsx`
- Modify: `renderer/src/components/CookieStatusIndicator.tsx`

**Interfaces:**
- `navigation.ts` produces `NavigationItem`, `MobileNavigationItem`, `PRIMARY_NAV_ITEMS`, `SECONDARY_NAV_ITEMS`, `MOBILE_NAV_ITEMS`, and `isNavigationItemActive(pathname, item)`.
- `AppShell` signature: `({ children, onRequestRecovery }: { children: ReactNode; onRequestRecovery(): void }) => JSX.Element`.
- `Layout` becomes a page-canvas width wrapper and keeps the existing `{ children: ReactNode }` contract.

- [ ] **Step 1: Write navigation and shell tests**

Use these route expectations in `shell.test.tsx`:

```tsx
assert.equal(isNavigationItemActive('/jobs/abc', PRIMARY_NAV_ITEMS[0]), true);
assert.equal(isNavigationItemActive('/collections/abc', PRIMARY_NAV_ITEMS[1]), true);
assert.equal(isNavigationItemActive('/skills', PRIMARY_NAV_ITEMS[2]), true);
assert.equal(isNavigationItemActive('/publishing', PRIMARY_NAV_ITEMS[3]), true);
assert.equal(isNavigationItemActive('/settings', SECONDARY_NAV_ITEMS[1]), true);
assert.equal(MOBILE_NAV_ITEMS.at(-1)?.label, '更多');
```

Render `PrimaryRail` inside `MemoryRouter` and assert it contains exactly one `<nav aria-label="主导航">`, icon links for 作品、合集、Skills、发布, and lower links for 垃圾桶、设置. Render `MobileNavigation` and assert it uses `aria-label="移动导航"` and includes “更多”.

- [ ] **Step 2: Run the tests and verify failure**

Run:

```bash
node --import tsx --test renderer/src/components/shell/shell.test.tsx
```

Expected: FAIL because the shell modules do not exist.

- [ ] **Step 3: Implement the navigation model**

Define the exact route lists:

```typescript
export const PRIMARY_NAV_ITEMS = [
  { to: '/', label: '作品', icon: LayoutDashboard, matchPrefixes: ['/jobs/'] },
  { to: '/collections', label: '合集', icon: Users, matchPrefixes: ['/collections/'] },
  { to: '/skills', label: 'Skills', icon: Brain, matchPrefixes: [] },
  { to: '/publishing', label: '发布', icon: Send, matchPrefixes: [] },
] satisfies NavigationItem[];

export const SECONDARY_NAV_ITEMS = [
  { to: '/trash', label: '垃圾桶', icon: Trash2, matchPrefixes: [] },
  { to: '/settings', label: '设置', icon: Settings, matchPrefixes: [] },
] satisfies NavigationItem[];
```

`MOBILE_NAV_ITEMS` contains the four primary items and a non-route “更多” control opening a `BottomSheet` with settings, trash, API/抖音 status, version, and operator controls.

Define the non-route item explicitly:

```typescript
export type MobileNavigationItem = NavigationItem | {
  key: 'more';
  label: '更多';
  icon: typeof MoreHorizontal;
};

export const MOBILE_NAV_ITEMS: MobileNavigationItem[] = [
  ...PRIMARY_NAV_ITEMS,
  { key: 'more', label: '更多', icon: MoreHorizontal },
];
```

- [ ] **Step 4: Implement AppShell and UtilityBar**

`AppShell` owns the fixed rail, `UtilityBar`, content offset, mobile navigation, and mobile “更多” sheet. `UtilityBar` renders current context derived from `useLocation()`:

```typescript
export function getPageContext(pathname: string): { title: string; subtitle: string } {
  if (pathname.startsWith('/jobs/')) return { title: '作品详情', subtitle: '创作流程与成果' };
  if (pathname.startsWith('/collections/')) return { title: '合集详情', subtitle: '创作者内容库' };
  if (pathname === '/collections') return { title: '合集', subtitle: '创作者内容库' };
  if (pathname === '/skills') return { title: 'Skills', subtitle: '知识资产' };
  if (pathname === '/publishing') return { title: '发布工作台', subtitle: '人工交付队列' };
  if (pathname === '/settings') return { title: '设置', subtitle: '连接与本地环境' };
  if (pathname === '/trash') return { title: '垃圾桶', subtitle: '恢复已删除作品' };
  return { title: '创作中心', subtitle: '从视频到文稿、分镜与成片' };
}
```

Add `compact?: boolean` to `ApiKeyStatusIndicator` and `CookieStatusIndicator`. Compact mode renders a status dot/icon and short label such as “AI 已连接” or “抖音已登录”; failures remain links to settings with their full reason available through `title`. Desktop UtilityBar uses compact mode plus `OperatorSwitcher`. Do not show version or server port. Mobile shows only the page title and a “更多” button.

- [ ] **Step 5: Integrate the shell without changing startup behavior**

In `App.tsx`, leave initialization, bootstrap, recovery, `BrowserRouter`, `PublishingDuePoller`, and every `<Route>` unchanged. Replace only the existing `Navigation` header wrapper with:

```tsx
<AppShell onRequestRecovery={() => setRecoveryRequested(true)}>
  <Routes>
    <Route path="/" element={<JobListPage />} />
    <Route path="/jobs/:id" element={<JobDetailPage />} />
    <Route path="/collections" element={<CollectionListPage />} />
    <Route path="/collections/:id" element={<CollectionDetailPage />} />
    <Route path="/skills" element={<SkillListPage />} />
    <Route path="/publishing" element={<PublishingPage />} />
    <Route path="/trash" element={<TrashPage />} />
    <Route path="/settings" element={<SettingsPage />} />
  </Routes>
</AppShell>
```

Change `Layout` to:

```tsx
export function Layout({ children }: LayoutProps) {
  return <div className="mx-auto w-full max-w-[1440px] px-4 py-5 sm:px-6 lg:px-8 lg:py-7">{children}</div>;
}
```

- [ ] **Step 6: Verify shell behavior and build**

Run:

```bash
node --import tsx --test renderer/src/components/shell/shell.test.tsx
npm test
npm run build:renderer
```

Then start `npm run dev` and inspect widths 1440, 1024, and 390. Expected: desktop uses one fixed rail and one 56px utility bar; 390px uses bottom navigation with no horizontal overflow; startup/bootstrap screens remain full-screen without shell chrome.

- [ ] **Step 7: Commit**

```bash
git add renderer/src/App.tsx renderer/src/components/Layout.tsx renderer/src/components/ApiKeyStatusIndicator.tsx renderer/src/components/CookieStatusIndicator.tsx renderer/src/components/shell
git commit -m "feat: add responsive creative canvas shell"
```

### Task 6: Align Shared Setup, Creation, and Connection Flows

**Files:**
- Modify: `renderer/src/components/CreateJobDialog.tsx`
- Modify: `renderer/src/components/ApiKeyWarning.tsx`
- Modify: `renderer/src/components/CookieHint.tsx`
- Modify: `renderer/src/components/LocalUserSetup.tsx`
- Modify: `renderer/src/components/OperatorSwitcher.tsx`
- Create: `renderer/src/components/sharedFlows.test.tsx`

**Interfaces:**
- Preserve every existing public prop and callback for the five components.
- Consume `InlineNotice`, `IconButton`, and shared overlay focus/scroll behavior where applicable.

- [ ] **Step 1: Write failing shared-flow structure tests**

Render open `CreateJobDialog` in URL, share-text, and user-page modes; assert one `role="dialog"`, labeled mode controls with `aria-pressed`, a visible input label, cancel, and submit. Render `ApiKeyWarning` and assert dialog semantics plus exactly one link/action to settings. Render logged-in and missing `CookieHint` states and assert status text accompanies color. Render `LocalUserSetup` and assert the PIN fields retain labels, password input types, and error region.

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
node --import tsx --test renderer/src/components/sharedFlows.test.tsx
```

Expected: at least one new semantic/responsive assertion fails against the old shared flows.

- [ ] **Step 3: Apply the Creative Canvas dialog pattern**

- `CreateJobDialog`: keep three modes and all submission logic; use a compact segmented mode control, visible labels, one error notice, and a mobile full-height sheet below 640px.
- `ApiKeyWarning`: use the shared confirmation-dialog surface with “前往设置” as the only primary action.
- `CookieHint`: use `InlineNotice` tones and keep its current compact prop.
- `LocalUserSetup`: retain the full-screen setup/recovery state machine; update only tokens, labels, focus order, and stable dimensions.
- `OperatorSwitcher`: retain PIN verification and session behavior; compact desktop mode shows name and role, while mobile-more mode renders the full selector and sign-out action.

No API calls, validation rules, or navigation destinations change.

- [ ] **Step 4: Verify and commit**

```bash
node --import tsx --test renderer/src/components/sharedFlows.test.tsx renderer/src/store/operator.test.ts
npm test
npm run check
npm run build:renderer
git add renderer/src/components
git commit -m "style: align shared setup and creation flows"
```

### Task 7: Foundation Regression Gate

**Files:**
- Modify only if verification finds a defect in files changed by Tasks 1-5.

**Interfaces:**
- Produces: a stable base branch for all three dependent page plans.

- [ ] **Step 1: Run all automated gates**

```bash
npm run check
npm test
npm run build:renderer
```

Expected: all commands exit 0.

- [ ] **Step 2: Run the no-regression scans**

```bash
rg -n "🎬|📋|⚙️|✨|📊|Creative workspace|Batch Collection|Publishing Center" renderer/src/components/shell renderer/src/App.tsx
rg -n "v0\.1\.0|localhost:.*serverPort|后端服务运行中" renderer/src/components/shell renderer/src/App.tsx
```

Expected: no matches in the new shell.

- [ ] **Step 3: Check the worktree and commit verification fixes only if needed**

```bash
git status --short
git diff --check
```

If verification required changes, commit only those changes:

```bash
git add renderer/src package.json
git commit -m "fix: close creative canvas foundation regressions"
```
