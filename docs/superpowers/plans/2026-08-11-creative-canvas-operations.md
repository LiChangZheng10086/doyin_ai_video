# Creative Canvas Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign publishing, settings, and trash as efficient operational surfaces, replace browser-native prompts with accessible in-app dialogs, and complete cross-application visual and accessibility verification.

**Architecture:** Keep publishing rules in the existing tested `utils/publishing.ts` and all data mutations in route-level callbacks. Add small presentation helpers and focused feature components for packages, platform tasks, settings sections, local users, and trash; use shared overlay primitives for all edits and destructive confirmations.

**Tech Stack:** React 19, TypeScript 5.8, React Router 7, Zustand 5, Tailwind CSS 4, Lucide React, Node test runner, Playwright visual inspection

## Global Constraints

- Requires `2026-08-11-creative-canvas-foundation.md`; execute after creation and collection plans for the final cross-app gate.
- Preserve all publishing state transitions, role permissions, optimistic revision checks, platform limits, notifications, Electron actions, API key behavior, Douyin login, local ASR, storage paths, local users, and trash retention.
- The publishing page remains dense and operational; do not turn each page section into a decorative card.
- Default publishing view is “待处理”; only common filters stay visible.
- Replace `window.prompt`, `window.confirm`, and `window.alert` in touched pages with contextual forms, `ConfirmDialog`, or `InlineNotice`.
- Keep Simplified Chinese copy; remove `Publishing Center` and `Creator settings` decorative eyebrows.
- Recovery is the primary trash action; permanent deletion is visually secondary and always confirmed.
- Use foundation shell, status, icon-button, empty-state, notice, dialog, and bottom-sheet components.

---

### Task 1: Add Tested Publishing Presentation Rules

**Files:**
- Create: `renderer/src/features/publishing/publishingPresentation.ts`
- Create: `renderer/src/features/publishing/publishingPresentation.test.ts`
- Modify: `renderer/src/utils/publishing.ts`

**Interfaces:**
- Produces: `PublishingFilterCount`, `PublishingAssetView`, `PublishingPrimaryAction`, `getPublishingFilterCounts`, `getPublishingAssetView`, `getPublishingNextStep`, `getPublishingPrimaryAction`, and `PUBLISHING_PRIMARY_FILTERS`. Each primary count is the number of packages containing at least one matching task, not the number of tasks.
- Consumes existing `PUBLISH_FILTERS`, `getPublishingActionIds`, `PublishingPackageDetail`, `PublishTask`, and `LocalUserRole`.

- [ ] **Step 1: Write failing presentation tests**

Cover healthy-ready, scheduled, all-published, missing-cover, broken-video, failed, cancelled, and trashed packages:

```typescript
assert.equal(getPublishingNextStep(readyDetail), '打开抖音并完成发布');
assert.equal(getPublishingNextStep(missingCoverDetail), '补充封面后再发布');
assert.equal(getPublishingAssetView(brokenDetail.package.assetHealth).tone, 'danger');
assert.equal(getPublishingPrimaryAction(readyDetail, readyTask, 'publisher'), 'open-platform');
assert.equal(getPublishingPrimaryAction(publishedDetail, publishedTask, 'publisher'), 'create-version');
assert.equal(getPublishingPrimaryAction(trashedDetail, trashedTask, 'publisher'), undefined);
assert.deepEqual(PUBLISHING_PRIMARY_FILTERS.map((item) => item.id), ['action', 'scheduled', 'published', 'failed']);
```

Assert filter counts aggregate package tasks without double-counting a package in the visible badge value.

- [ ] **Step 2: Run the test and verify failure**

Run `node --import tsx --test renderer/src/features/publishing/publishingPresentation.test.ts`.

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement presentation-only rules**

Do not duplicate permission logic. `getPublishingPrimaryAction` calls `getPublishingActionIds` and selects the first available ID in this exact priority:

```typescript
const priority: PublishingActionId[] = [
  'open-platform',
  'mark-published',
  'restore',
  'restore-package',
  'create-version',
  'schedule',
];
```

`getPublishingNextStep` differentiates `broken_video`, `missing_cover`, ready, failed, scheduled, published, cancelled, and trashed. Keep the complete `PUBLISH_FILTERS` export for the advanced filter sheet; add only a primary subset.

- [ ] **Step 4: Verify and commit**

```bash
node --import tsx --test renderer/src/features/publishing/publishingPresentation.test.ts renderer/src/utils/publishing.test.ts
npm run build:renderer
git add renderer/src/features/publishing renderer/src/utils/publishing.ts
git commit -m "feat: add publishing presentation rules"
```

### Task 2: Rebuild the Publishing Workbench

**Files:**
- Create: `renderer/src/features/publishing/PublishingToolbar.tsx`
- Create: `renderer/src/features/publishing/PublishingPackageRow.tsx`
- Create: `renderer/src/features/publishing/PlatformTaskPanel.tsx`
- Create: `renderer/src/features/publishing/PublishingActionDialog.tsx`
- Create: `renderer/src/features/publishing/publishingComponents.test.tsx`
- Modify: `renderer/src/pages/PublishingPage.tsx`

**Interfaces:**
- `PublishingToolbarProps`: `{ status, counts, search, platform, dueRange, advancedFilters, onStatusChange, onSearchChange, onPlatformChange, onDueRangeChange, onOpenAdvanced, onClear }`.
- `PublishingPackageRowProps`: `{ detail, role, expanded, busy, onToggle, onAction }`.
- `PlatformTaskPanelProps`: `{ detail, task, role, busy, onAction }`.
- `PublishingActionDialog` consumes a discriminated `PublishingDialogState` and calls `onSubmit(result: PublishingDialogResult)`.

- [ ] **Step 1: Define and test dialog state**

Use this exact union:

```typescript
export type PublishingDialogState =
  | { kind: 'edit-content'; detail: PublishingPackageDetail; task: PublishTask }
  | { kind: 'schedule'; action: 'schedule' | 'restore'; detail: PublishingPackageDetail; task: PublishTask }
  | { kind: 'failure'; detail: PublishingPackageDetail; task: PublishTask }
  | { kind: 'withdraw'; detail: PublishingPackageDetail; task: PublishTask }
  | { kind: 'confirm'; action: 'open-platform' | 'mark-published' | 'cancel' | 'create-version' | 'trash-package'; detail: PublishingPackageDetail; task: PublishTask };

export type PublishingDialogResult =
  | { kind: 'edit-content'; title: string; description: string; hashtags: string[] }
  | { kind: 'schedule'; action: 'schedule' | 'restore'; scheduledAt: string | null }
  | { kind: 'failure'; reason: string }
  | { kind: 'withdraw'; reason: string }
  | { kind: 'confirm'; action: 'open-platform' | 'mark-published' | 'cancel' | 'create-version' | 'trash-package' };
```

Render each kind. Assert edit fields have labels and current values, schedule uses `datetime-local`, reason dialogs require a textarea, and destructive confirms expose `data-tone="danger"`. Assert no rendered markup contains the words `window.prompt` or native browser instructions.

- [ ] **Step 2: Run the component test and verify failure**

Run `node --import tsx --test renderer/src/features/publishing/publishingComponents.test.tsx`.

Expected: FAIL because the components do not exist.

- [ ] **Step 3: Implement the compact toolbar**

The always-visible row contains four primary status tabs with counts, search, platform, due range (`all | today | overdue`), and “更多筛选”. The sheet contains source job ID, version, creator ID, cancelled/broken/trash statuses, and clear action. URL query `status` behavior remains compatible.

- [ ] **Step 4: Implement package and platform layouts**

Collapsed package rows show cover, title, version, asset health, creator/time, next step, and compact platform states. Expanded content uses a platform-task column and a publication-copy/action column. Keep the existing Blob URL creation/revocation for covers. Put audit history, internal source ID, withdraw, and trash actions behind disclosures or a menu.

Only `getPublishingPrimaryAction` is visually primary. Copy actions use icon buttons with tooltips. Missing cover uses warning, broken video uses danger, and failed platform tasks show the actual `lastError`.

- [ ] **Step 5: Replace native prompts and confirms**

Change `handleTaskAction` so actions that need input set `dialogState`; typed dialog submission calls the same existing API methods and the existing `run()` lock. Keep `navigator.clipboard`, `desktop.openExternal`, `desktop.showItemInFolder`, notifications, and role checks unchanged.

For opening a platform with a missing cover, use a warning `ConfirmDialog`; do not call `window.confirm`. Surface operation failures through the page `InlineNotice`, not `window.alert`.

- [ ] **Step 6: Verify and commit**

```bash
node --import tsx --test renderer/src/features/publishing/publishingPresentation.test.ts renderer/src/features/publishing/publishingComponents.test.tsx renderer/src/utils/publishing.test.ts
npm test
npm run build:renderer
git add renderer/src/features/publishing renderer/src/pages/PublishingPage.tsx
git commit -m "feat: redesign the publishing workbench"
```

### Task 3: Align the Publish Package Wizard

**Files:**
- Modify: `renderer/src/components/CreatePublishPackageDialog.tsx`
- Create: `renderer/src/components/CreatePublishPackageDialog.test.tsx`

**Interfaces:**
- Preserve the existing `CreatePublishPackageDialog` props, publishing preview calls, `PublishingWizardState`, reducer actions, field validation, and package creation input.
- Consume shared status, notice, icon-button, and overlay primitives.
- `CreatePublishPackageDialogViewProps` is defined as:

```typescript
export interface CreatePublishPackageDialogViewProps {
  state: PublishingWizardState;
  activePlatform: PublishPlatform;
  busy: boolean;
  error: string;
  created: PublishingPackageDetail | null;
  assetInspection: PublishingAssetInspection | null;
  assetLoading: boolean;
  assetError: string;
  onActivePlatformChange(platform: PublishPlatform): void;
  onDispatch(action: PublishingWizardAction): void;
  onAdvance(): void;
  onBack(): void;
  onCreate(): void;
  onClose(): void;
  onOpenPublishing(): void;
}
```

- [ ] **Step 1: Write failing wizard structure tests**

Render each of the five reducer states with exported pure `CreatePublishPackageDialogView` props and assert:

```tsx
for (const label of ['成片', '平台', '文案', '排期', '确认']) assert.match(markup, new RegExp(`>${label}<`));
assert.match(markup, /role="dialog"/);
assert.match(markup, /aria-modal="true"/);
assert.match(markup, /aria-current="step"/);
```

In the copy state, assert every field has a visible label and character count. In confirmation, assert platform, title, schedule, and asset health are read-only. In success, assert the only primary action leads to the publishing workbench.

- [ ] **Step 2: Run the focused test and verify failure**

Run `node --import tsx --test renderer/src/components/CreatePublishPackageDialog.test.tsx`.

Expected: FAIL because `CreatePublishPackageDialogView` and the required semantics do not exist.

- [ ] **Step 3: Split stateful container from pure wizard view**

Keep existing API calls and reducer in `CreatePublishPackageDialog`. Export a pure `CreatePublishPackageDialogView` receiving current wizard state, busy/error/result state, and callbacks. Use a horizontal step indicator on desktop and compact “步骤 X/5” label on mobile. Platform choices use checkboxes/cards; copy fields retain real limits and inline errors; schedule uses labeled `datetime-local`; confirmation is read-only.

- [ ] **Step 4: Apply responsive and accessibility behavior**

The wizard uses a centered 12px-radius surface at desktop and a full-height bottom sheet below 640px. Lock background scroll, trap focus, restore focus on close, and preserve draft state while navigating backward. Do not add automatic publishing or platform credentials.

- [ ] **Step 5: Verify and commit**

```bash
node --import tsx --test renderer/src/components/CreatePublishPackageDialog.test.tsx renderer/src/utils/publishing.test.ts
npm test
npm run build:renderer
git add renderer/src/components/CreatePublishPackageDialog.tsx renderer/src/components/CreatePublishPackageDialog.test.tsx
git commit -m "style: align the publishing package wizard"
```

### Task 4: Split Settings into Focused IDE-Style Sections

**Files:**
- Create: `renderer/src/features/settings/settingsModel.ts`
- Create: `renderer/src/features/settings/SettingsNavigation.tsx`
- Create: `renderer/src/features/settings/ModelsSettings.tsx`
- Create: `renderer/src/features/settings/ModelsSettingsView.tsx`
- Create: `renderer/src/features/settings/DouyinSettings.tsx`
- Create: `renderer/src/features/settings/AsrSettings.tsx`
- Create: `renderer/src/features/settings/StorageSettings.tsx`
- Create: `renderer/src/features/settings/AdvancedSettings.tsx`
- Create: `renderer/src/features/settings/settings.test.tsx`
- Modify: `renderer/src/pages/SettingsPage.tsx`

**Interfaces:**
- `settingsModel.ts` owns and exports `AIKeyConfig`, `AIKeyForm`, `AIKeyTestResult`, `SettingsSection`, `SETTINGS_SECTIONS`, `emptyKeyForm`, and `getProviderDefaults`.
- `SettingsNavigationProps`: `{ active, onChange }`.
- Each section owns its local request/form state and exposes no API-specific callbacks to `SettingsPage`. `ModelsSettingsView` is a pure exported presentation component receiving the current form/configuration props from `ModelsSettings`.
- Use these grouped view interfaces to keep the prop contract stable:

```typescript
export interface ModelsSettingsViewState {
  apiKeys: AIKeyConfig[];
  formOpen: boolean;
  editingKeyId: string | null;
  testingKeyId: string | null;
  draft: AIKeyForm;
  testResult: AIKeyTestResult | null;
  keyResults: Record<string, AIKeyTestResult>;
  testing: boolean;
  saving: boolean;
}

export interface ModelsSettingsViewActions {
  startAdd(): void;
  startEdit(key: AIKeyConfig): void;
  closeForm(): void;
  changeDraft(next: AIKeyForm): void;
  changeProvider(provider: AIKeyConfig['provider']): void;
  testDraft(): void;
  saveDraft(): void;
  retest(id: string): void;
  activate(id: string): void;
  requestRemove(id: string): void;
}
```

- [ ] **Step 1: Write failing settings model and navigation tests**

Assert section order is exactly models, douyin, asr, storage, users, advanced. Assert provider defaults preserve the current custom URL/model and set exact DeepSeek/OpenAI defaults. Render navigation and assert the selected button has `aria-current="page"`.

Render `ModelsSettingsView` with a static configuration and no-op handlers; assert name, provider, model, connection validity, latest test time, edit, retest, and activate actions are present. Render the edit form state and assert the API key hint says “留空则保留原 API Key”.

- [ ] **Step 2: Run the focused test and verify failure**

Run `node --import tsx --test renderer/src/features/settings/settings.test.tsx`.

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Move AI configuration behavior into ModelsSettings**

Move existing load, add, edit, test, retest, activate, and remove handlers into the stateful `ModelsSettings` container without changing Electron IPC signatures. Render the pure `ModelsSettingsView` with state and handlers. Use `ConfirmDialog` for remove. The form order is name, provider, Base URL when custom, model, API key. “测试连接” precedes “保存”; inline test feedback remains directly below the affected form/configuration.

- [ ] **Step 4: Move the remaining sections unchanged in behavior**

- `DouyinSettings`: QR login, manual Cookie input, status refresh.
- `AsrSettings`: local whisper.cpp facts only.
- `StorageSettings`: existing paths; use `window.electron.getAppPaths()` when available rather than hard-coded display values.
- `AdvancedSettings`: security/process information, app version, backend/runtime diagnostics, and a separate “恢复与重置” danger area.

Remove English section titles `Models / API Keys`, `ASR`, `Storage`, `Advanced` from visible headings; use “模型与 API”, “本地转录”, “存储”, “高级”. Proper model names remain unchanged.

- [ ] **Step 5: Reduce SettingsPage to section orchestration**

`SettingsPage` owns only `activeSection` and renders:

```tsx
<div className="grid gap-5 lg:grid-cols-[240px_minmax(0,1fr)]">
  <SettingsNavigation active={activeSection} onChange={setActiveSection} />
  <main className="min-w-0">{renderSettingsSection(activeSection)}</main>
</div>
```

Below `lg`, navigation becomes a horizontal selector or a labeled `<select>`; it must not squeeze to 240px beside content.

- [ ] **Step 6: Verify and commit**

```bash
node --import tsx --test renderer/src/features/settings/settings.test.tsx
npm test
npm run build:renderer
git add renderer/src/features/settings renderer/src/pages/SettingsPage.tsx
git commit -m "refactor: split settings into focused sections"
```

### Task 5: Split Local User Management Without Changing Permissions

**Files:**
- Create: `renderer/src/features/settings/users/LocalUsersSettings.tsx`
- Create: `renderer/src/features/settings/users/LocalUserForm.tsx`
- Create: `renderer/src/features/settings/users/LocalUserRow.tsx`
- Create: `renderer/src/features/settings/users/LocalUserPinDialog.tsx`
- Move and update: `renderer/src/components/LocalUsersSettings.test.tsx` to `renderer/src/features/settings/users/LocalUsersSettings.test.tsx`
- Modify: `renderer/src/pages/SettingsPage.tsx`
- Delete: `renderer/src/components/LocalUsersSettings.tsx`

**Interfaces:**
- Preserve exported contracts `LocalUsersSettings`, `LocalUserCreateAction`, `LocalUserRowActions`, and `LocalUserPinDialog` so current tests and page behavior remain valid.
- Consume `useOperatorStore` and existing local-user API methods unchanged.

- [ ] **Step 1: Move tests before implementation**

Move the existing tests to the feature folder and keep all public imports from `./LocalUsersSettings.js`. `LocalUsersSettings.tsx` re-exports `LocalUserCreateAction`, `LocalUserRowActions`, and `LocalUserPinDialog` from their focused files. Add assertions that destructive/reset actions are not primary-colored and that dialogs keep `role="dialog"`, `aria-modal`, labels, and password fields.

- [ ] **Step 2: Run moved tests and verify failure**

Run `node --import tsx --test renderer/src/features/settings/users/LocalUsersSettings.test.tsx`.

Expected: FAIL because feature modules do not exist.

- [ ] **Step 3: Split presentation while preserving state transitions**

Move the existing mutation queue, refresh, role/PIN rules, and API calls into `LocalUsersSettings.tsx`. Extract only the create form, user row, and PIN dialog presentation. Keep the exact safeguards for the current administrator and last active administrator.

Use the shared `ConfirmDialog` for deactivate/role-change confirmations. Keep PIN validation and recovery behavior unchanged.

- [ ] **Step 4: Update imports and delete the old module**

Update `SettingsPage` to import the new feature component. Confirm no old imports remain:

```bash
rg -n "components/LocalUsersSettings|\.\/LocalUsersSettings" renderer/src
```

Expected: only the new feature-local test/component relationships remain.

- [ ] **Step 5: Verify and commit**

```bash
node --import tsx --test renderer/src/features/settings/users/LocalUsersSettings.test.tsx renderer/src/utils/localUsers.test.ts renderer/src/store/operator.test.ts
npm test
npm run build:renderer
git add renderer/src/features/settings/users renderer/src/pages/SettingsPage.tsx renderer/src/components/LocalUsersSettings.tsx renderer/src/components/LocalUsersSettings.test.tsx
git commit -m "refactor: isolate local user settings"
```

### Task 6: Make Trash a Recovery-First List

**Files:**
- Create: `renderer/src/features/trash/TrashItem.tsx`
- Create: `renderer/src/features/trash/trashPresentation.ts`
- Create: `renderer/src/features/trash/trash.test.tsx`
- Modify: `renderer/src/pages/TrashPage.tsx`

**Interfaces:**
- `TrashItemProps`: `{ job, busy, onOpen, onRestore, onRequestPermanentDelete }`.
- `getTrashRetention(expiresAt, now?)` returns `{ label, urgent, expired }`.

- [ ] **Step 1: Write failing retention and component tests**

Assert 12.2 days rounds up to “剩余 13 天自动清理”, a past date returns “即将自动清理”, and missing date returns “保留期未知”. Render an active job and assert permanent delete is disabled with a readable reason. Render a normal job and assert “恢复” appears before “永久删除”.

- [ ] **Step 2: Run the test and verify failure**

Run `node --import tsx --test renderer/src/features/trash/trash.test.tsx`.

Expected: FAIL because the feature modules do not exist.

- [ ] **Step 3: Implement the recovery-first row**

Display content preview, title, deletion time, retention, and a short asset scope statement. “恢复” uses the blue primary style. “查看” is secondary. “永久删除” is an overflow/danger action and never uses a filled red button.

- [ ] **Step 4: Integrate confirmation and inline feedback**

Replace `window.confirm` and `window.alert` with shared `ConfirmDialog` and `InlineNotice`. The confirmation description must state that video, audio, transcript, rewrite, shots, and output are removed. Preserve active-job deletion blocking from the backend and button state.

- [ ] **Step 5: Verify and commit**

```bash
node --import tsx --test renderer/src/features/trash/trash.test.tsx
npm test
npm run build:renderer
git add renderer/src/features/trash renderer/src/pages/TrashPage.tsx
git commit -m "feat: make trash recovery first"
```

### Task 7: Cross-Application Accessibility, Responsive, and Visual Gate

**Files:**
- Modify only previously touched renderer files when verification reveals defects.
- Update: `docs/user-manual.md` only if navigation labels or locations described there are now stale.

**Interfaces:**
- Produces: final acceptance evidence for the approved Creative Canvas specification.

- [ ] **Step 1: Run the full automated gate**

```bash
npm run check
npm test
npm run build:backend
npm run build:renderer
npm run build:electron
```

Expected: all commands exit 0.

- [ ] **Step 2: Scan for forbidden and stale UI patterns**

```bash
rg -n "Creative workspace|Batch Collection|Publishing Center|Creator settings|🎬|📋|⚙️|✨|📊" renderer/src
rg -n "window\.(prompt|confirm|alert)" renderer/src/pages/PublishingPage.tsx renderer/src/pages/SettingsPage.tsx renderer/src/pages/TrashPage.tsx
rg -n "rounded-(2xl|3xl)|tracking-tight|-tracking" renderer/src
```

Expected: no decorative English eyebrows, Emoji functional icons, native prompts in touched pages, oversized card radii, or negative letter spacing. Necessary proper nouns such as `Skills`, `OpenAI`, and model IDs are allowed.

- [ ] **Step 3: Verify keyboard workflows**

Using the running Electron app, complete these sequences without a mouse:

1. Navigate rail → create work → close dialog.
2. Open a job → switch artifact tabs → open/close “活动与信息”.
3. Open a collection → select an uncreated video → reach the batch action bar.
4. Open Skills → open viewer → switch tabs → close.
5. Open publishing → expand package → copy/open action → open/close edit dialog.
6. Open settings → change section → tab through form actions.
7. Open trash → open permanent-delete confirmation → cancel.

Expected: visible focus at every step, no focus escape from dialogs, Escape closes non-destructive overlays, and focus returns to the triggering control.

- [ ] **Step 4: Capture the required viewport matrix**

Capture each primary route at 1440x900, 1024x768, 768x1024, and 390x844. Store evidence in `output/playwright/creative-canvas/final/` using names `<route>-<width>x<height>.png`.

Expected in every image: no horizontal overflow, overlap, clipped button text, content hidden beneath fixed navigation/action bars, or layout movement caused by missing images. At 390px the app uses bottom navigation and sheets rather than a wrapped desktop rail/sidebar.

- [ ] **Step 5: Verify key real-data states**

- Valid collection avatar renders on list and detail.
- Missing cover and failed avatar use stable fallbacks.
- Running job shows real progress; unknown progress is not fabricated.
- Failed generation preserves old artifact.
- Existing Skill remains available during update failure.
- Publishing distinguishes missing cover, broken video, and task failure.
- Trash displays accurate remaining days and blocks active permanent deletion.

- [ ] **Step 6: Update user documentation if needed**

If `docs/user-manual.md` describes the old top navigation or old page labels, update only those sections to explain the desktop side rail, mobile bottom navigation, job artifact workspace, creator library, and publishing workbench. Do not rewrite unrelated operating instructions.

- [ ] **Step 7: Commit final fixes and documentation**

```bash
git diff --check
git status --short
git add renderer/src docs/user-manual.md
git commit -m "fix: complete creative canvas UI acceptance"
```

If no fixes or documentation changes are needed, do not create an empty commit.
