# Creative Canvas Creation Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the creation center and job detail so作品预览、当前步骤、下一步操作和成果内容成为主要界面层级。

**Architecture:** Keep all existing job API calls and polling in the two route pages. Extract deterministic presentation logic into one tested utility module, then move list, workflow, artifact, and context markup into focused feature components that consume existing `Job`, `JobOverview`, `CleanedScript`, and `HyperframesVideoOutput` types.

**Tech Stack:** React 19, TypeScript 5.8, React Router 7, Tailwind CSS 4, Lucide React, Axios, Node test runner

## Global Constraints

- Requires `2026-08-11-creative-canvas-foundation.md` to be fully implemented first.
- Preserve `/api/jobs/overview`, `/api/jobs/:id`, cleaned/transcript/video endpoints, polling cadence, delete/restore behavior, and the four-step workflow.
- Default to list view and persist the user's list/card choice locally.
- Do not display backend port, Task ID, paths, JSON, or full errors in the primary content hierarchy.
- Use Simplified Chinese; remove `Creative workspace` and other decorative English eyebrow copy.
- Failed regeneration must not hide a prior valid artifact.
- The video player keeps a stable 9:16 frame and retains preview, download, and publishing entry behavior.
- `action`, `cameraMotion`, and `visualLayers` remain available only inside per-shot “制作信息”.
- Use the shared `StatusIndicator`, `IconButton`, `EmptyState`, `InlineNotice`, `ConfirmDialog`, and shell from the foundation plan.

---

### Task 1: Centralize Job Presentation Logic

**Files:**
- Create: `renderer/src/features/jobs/jobPresentation.ts`
- Create: `renderer/src/features/jobs/jobPresentation.test.ts`
- Modify: `renderer/src/pages/JobListPage.tsx`
- Modify: `renderer/src/pages/JobDetailPage.tsx`

**Interfaces:**
- Produces: `JobVisualState`, `ArtifactKey`, `ArtifactState`, `ArtifactAvailability`, `WorkflowStepView`, `filterJobOverviews`, `selectActiveJob`, `getJobVisualState`, `buildWorkflowSteps`, `buildArtifactStates`, `readStoredViewMode`, `writeStoredViewMode`, and formatters.
- Consumes: existing `Job`, `JobOverview`, `JobFilterStatus`, `PipelineStep`, `PipelineStepState`, and `ViewMode`.

- [ ] **Step 1: Write failing presentation tests**

Create fixtures for queued, running, failed, and done jobs, then assert:

```typescript
assert.equal(getJobVisualState(runningJob).label, '处理中');
assert.equal(getJobVisualState(failedJob).tone, 'danger');
assert.equal(selectActiveJob([doneOverview, runningOverview])?.id, runningOverview.id);
assert.deepEqual(
  filterJobOverviews([runningOverview, doneOverview], '系统', 'processing').map((job) => job.id),
  [runningOverview.id],
);
assert.equal(buildWorkflowSteps(blockedJob, null)[2].actionLabel, '等待 AI 洗稿完成');
assert.equal(buildArtifactStates(videoJob).find((item) => item.key === 'video')?.state, 'ready');
```

Also assert `readStoredViewMode()` returns `'list'` for missing, inaccessible, or invalid storage and returns `'card'` only for the exact stored value.

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
node --import tsx --test renderer/src/features/jobs/jobPresentation.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the exact presentation contracts**

Define:

```typescript
export type JobVisualState = {
  label: '待执行' | '处理中' | '已完成' | '失败';
  tone: 'info' | 'processing' | 'success' | 'danger';
  busy: boolean;
};

export type ArtifactKey = 'transcript' | 'script' | 'shots' | 'video';
export type ArtifactState = 'ready' | 'processing' | 'waiting' | 'failed';

export interface ArtifactAvailability {
  transcriptReady: boolean;
  rewriteReady: boolean;
  shotsReady: boolean;
  videoReady: boolean;
  transcriptError?: string | null;
  rewriteError?: string | null;
  videoError?: string | null;
}

export interface WorkflowStepView {
  key: PipelineStep;
  index: number;
  label: string;
  status: PipelineStepState['status'];
  blocked: boolean;
  actionLabel: string;
  progress?: number;
  error?: string;
}

export const JOB_VIEW_MODE_KEY = 'douyin-ai-video.job-view-mode';

export function filterJobOverviews(
  jobs: JobOverview[],
  query: string,
  filter: JobFilterStatus,
): JobOverview[];

export function buildArtifactStates(
  job: Job,
  availability: ArtifactAvailability,
): Array<{ key: ArtifactKey; label: string; state: ArtifactState }>;
```

Move the existing pure status, workflow, timeline, phase, shot-layout, duration, range, retention, and date formatters out of `JobDetailPage.tsx`. `buildArtifactStates` must use both step status and loaded artifact/error state, so “步骤成功但文件缺失” becomes a failed artifact instead of ready. Do not alter other business results except to normalize UI labels to Simplified Chinese and `生成分镜`.

- [ ] **Step 4: Make both pages consume the utility without changing markup yet**

Replace local duplicate helpers with imports. Keep output behavior unchanged for this step. Remove only helpers proven unused by TypeScript.

- [ ] **Step 5: Verify and commit**

```bash
node --import tsx --test renderer/src/features/jobs/jobPresentation.test.ts
npm run build:renderer
git add renderer/src/features/jobs renderer/src/pages/JobListPage.tsx renderer/src/pages/JobDetailPage.tsx
git commit -m "refactor: centralize job presentation logic"
```

### Task 2: Rebuild the Creation Center Around Works and Next Actions

**Files:**
- Create: `renderer/src/features/jobs/ContentPreview.tsx`
- Create: `renderer/src/features/jobs/ActiveJobStrip.tsx`
- Create: `renderer/src/features/jobs/JobListToolbar.tsx`
- Create: `renderer/src/features/jobs/JobListView.tsx`
- Create: `renderer/src/features/jobs/JobCardView.tsx`
- Create: `renderer/src/features/jobs/jobList.test.tsx`
- Modify: `renderer/src/pages/JobListPage.tsx`
- Delete: `renderer/src/components/JobCard.tsx` only after `rg "JobCard" renderer/src` proves no remaining import.

**Interfaces:**
- `ContentPreviewProps`: `{ title: string; imageUrl?: string; compact?: boolean }`.
- `ActiveJobStripProps`: `{ job: JobOverview; onOpen(id: string): void }`.
- `JobListToolbarProps`: `{ query, filter, viewMode, polling, onQueryChange, onFilterChange, onViewModeChange }`.
- Both result views consume `{ jobs, deletingId, onOpen, onRequestDelete }`.

- [ ] **Step 1: Write failing list component tests**

Render a representative running job and assert:

```tsx
const active = renderToStaticMarkup(<ActiveJobStrip job={runningOverview} onOpen={noop} />);
assert.match(active, />当前创作</);
assert.match(active, />生成分镜</);
assert.match(active, /68%/);

const list = renderToStaticMarkup(
  <JobListView jobs={[runningOverview]} deletingId={null} onOpen={noop} onRequestDelete={noop} />,
);
for (const heading of ['作品', '更新时间', '状态', '下一步', '操作']) assert.match(list, new RegExp(`>${heading}<`));
assert.doesNotMatch(list, /Task ID|localhost|后端服务运行中/);
```

Render `ContentPreview` with and without `imageUrl`; assert the image path uses `<img>` and fallback contains the supplied title but no generic decorative label.

- [ ] **Step 2: Run the test and verify failure**

Run `node --import tsx --test renderer/src/features/jobs/jobList.test.tsx`.

Expected: FAIL because the feature components do not exist.

- [ ] **Step 3: Implement the preview, active strip, and toolbar**

- `ContentPreview` uses `aspect-[9/16]`, a stable width, `object-cover`, lazy loading, and an `onError` fallback.
- `ActiveJobStrip` renders only one selected active job with preview, current step, real `job.steps?.[currentStep]?.progress`, and one “继续创作” action. If progress is absent, render an indeterminate bar and no numeric percentage.
- `JobListToolbar` contains search, five status buttons, view switch icon buttons, and an inline polling indicator. It does not use a floating fixed element.
- View switch labels are “列表视图” and “卡片视图”; selected state uses `aria-pressed`.

- [ ] **Step 4: Implement list and card views**

Desktop list columns are exactly preview/title, updated time, status, next step, and actions. At widths below `lg`, each row becomes a two-line work item rather than preserving a squeezed grid. Card view keeps preview, title/source, two-line summary, one compact artifact-status row, and a footer action.

Deletion opens the shared `ConfirmDialog`; the trash icon is not visible until row hover/focus or the card overflow menu is opened.

- [ ] **Step 5: Integrate the page**

Keep `refreshOverviews`, API initialization, polling, API key warning, and `CreateJobDialog` unchanged. Replace only presentation state and markup:

```tsx
const activeJob = selectActiveJob(overviews);
const [viewMode, setViewMode] = useState<ViewMode>(() => readStoredViewMode(window.localStorage));

const changeViewMode = (mode: ViewMode) => {
  setViewMode(mode);
  writeStoredViewMode(window.localStorage, mode);
};
```

Remove the purple English eyebrow, backend port notice, fixed polling pill, and page-level `window.confirm`. Loading becomes a list-shaped skeleton; API failure retains prior data and uses `InlineNotice`.

- [ ] **Step 6: Verify and commit**

```bash
node --import tsx --test renderer/src/features/jobs/jobPresentation.test.ts renderer/src/features/jobs/jobList.test.tsx
npm test
npm run build:renderer
git add renderer/src/features/jobs renderer/src/pages/JobListPage.tsx renderer/src/components/JobCard.tsx
git commit -m "feat: make the creation center content first"
```

### Task 3: Build the Unified Workflow Console

**Files:**
- Create: `renderer/src/features/jobs/WorkflowConsole.tsx`
- Create: `renderer/src/features/jobs/WorkflowStepper.tsx`
- Create: `renderer/src/features/jobs/workflowConsole.test.tsx`
- Modify: `renderer/src/pages/JobDetailPage.tsx`

**Interfaces:**
- `WorkflowConsoleProps`: `{ job, runningStep, actionError, onRunStep(step), onRestore? }`.
- `WorkflowStepperProps`: `{ steps: WorkflowStepView[]; currentStep?: PipelineStep }`.
- Consumes `buildWorkflowSteps` and current-step copy from Task 1.

- [ ] **Step 1: Write failing workflow tests**

Cover pending, running, succeeded, failed, and blocked states:

```tsx
const failed = renderToStaticMarkup(
  <WorkflowConsole job={failedJob} runningStep={null} actionError={null} onRunStep={noop} />,
);
assert.match(failed, />重试 AI 洗稿</);
assert.match(failed, /AI 域名无法解析/);
assert.equal((failed.match(/data-primary-action/g) ?? []).length, 1);

const blocked = renderToStaticMarkup(
  <WorkflowConsole job={blockedJob} runningStep={null} actionError={null} onRunStep={noop} />,
);
assert.match(blocked, />等待 AI 洗稿完成</);
assert.match(blocked, /disabled=""/);
```

Assert the four step labels each appear exactly once; this guards against restoring duplicate step cards.

- [ ] **Step 2: Run the test and verify failure**

Run `node --import tsx --test renderer/src/features/jobs/workflowConsole.test.tsx`.

Expected: FAIL because the components do not exist.

- [ ] **Step 3: Implement one control surface**

`WorkflowConsole` renders:

1. Current action eyebrow in Simplified Chinese.
2. One title and one sentence of state-specific explanation.
3. Real step count and real generation progress when provided.
4. One primary button, or one disabled button with an explicit blocking reason.
5. One horizontal/scrollable `WorkflowStepper` below the main row.

Do not render the old standalone Hero plus four step cards. A failed step uses red notice text but keeps the same console geometry. Restore is shown only for a trashed job.

- [ ] **Step 4: Integrate the console and title bar**

Keep existing route loading, step execution, delete, and restore callbacks. Replace the old hero and workflow card grid with `WorkflowConsole`. The title bar shows back, work title, update time, and a `MoreHorizontal` menu for delete/restore; deletion uses `ConfirmDialog`.

- [ ] **Step 5: Verify and commit**

```bash
node --import tsx --test renderer/src/features/jobs/workflowConsole.test.tsx
npm run build:renderer
git add renderer/src/features/jobs renderer/src/pages/JobDetailPage.tsx
git commit -m "feat: unify job workflow controls"
```

### Task 4: Split the Artifact Workspace into Focused Views

**Files:**
- Create: `renderer/src/features/jobs/artifacts/ArtifactNavigator.tsx`
- Create: `renderer/src/features/jobs/artifacts/TranscriptArtifact.tsx`
- Create: `renderer/src/features/jobs/artifacts/RewriteArtifact.tsx`
- Create: `renderer/src/features/jobs/artifacts/ShotArtifact.tsx`
- Create: `renderer/src/features/jobs/artifacts/VideoArtifact.tsx`
- Create: `renderer/src/features/jobs/artifacts/artifacts.test.tsx`
- Create: `renderer/src/features/jobs/JobContextSidebar.tsx`
- Modify: `renderer/src/pages/JobDetailPage.tsx`

**Interfaces:**
- `ArtifactNavigatorProps`: `{ active, items, onChange }`, using `ArtifactKey` and `ArtifactState` from Task 1.
- Artifact views consume the exact existing response types; no new API response type is introduced.
- `JobContextSidebarProps`: `{ job: Job }`.

- [ ] **Step 1: Write failing artifact tests**

Render all four navigation states and assert selected tab semantics:

```tsx
assert.match(navigatorMarkup, /role="tablist"/);
assert.match(navigatorMarkup, /aria-selected="true"/);
for (const label of ['转录', 'AI 洗稿', '分镜', '视频成片']) assert.match(navigatorMarkup, new RegExp(`>${label}<`));
```

Render a shot containing `headline`, `captionLines`, `sourceKeyPoints`, `action`, `cameraMotion`, and `visualLayers`. Assert headline/caption/coverage are visible, while `cameraMotion` appears only inside a `<details>` whose summary is “制作信息”. Render a video output and assert the player has `controls`, a 9:16 wrapper, “无声动效版”, download, and “加入发布中心”.

- [ ] **Step 2: Run the test and verify failure**

Run `node --import tsx --test renderer/src/features/jobs/artifacts/artifacts.test.tsx`.

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Move existing artifact rendering without changing data loading**

- `TranscriptArtifact`: source/model/duration summary, full transcript, collapsible segments.
- `RewriteArtifact`: title, summary, numbered key points, `shortVideoScript` or `cleanScript`, quality notes.
- `ShotArtifact`: story responsibility, layout, duration, headline, supporting text, caption lines, visual items, coverage indexes; production fields only in `<details>`.
- `VideoArtifact`: preserve current Blob URL cleanup, stream URL, playback error fallback, download, metrics, path in advanced details, and publishing dialog entry.

Each artifact owns only presentation or artifact-local effects. Page-level API requests remain in `JobDetailPage`.

- [ ] **Step 4: Build the context sidebar and mobile drawer**

Move Timeline and Advanced Info into `JobContextSidebar`. Desktop displays a 320px sidebar. Below 1280px, render a single “活动与信息” button opening `BottomSheet`; do not squeeze the artifact canvas.

- [ ] **Step 5: Integrate the two-column workspace**

Replace the old outcome cards with:

```tsx
<div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
  <section className="min-w-0">
    <ArtifactNavigator active={activeArtifact} items={artifactStates} onChange={setActiveArtifact} />
    {renderActiveArtifact()}
  </section>
  <JobContextSidebar job={job} />
</div>
```

Select the first ready artifact on initial load, preferring AI 洗稿, then transcript, shots, video; if the user changes tabs, do not reset their selection on polling refresh.

- [ ] **Step 6: Verify and commit**

```bash
node --import tsx --test renderer/src/features/jobs/artifacts/artifacts.test.tsx
npm test
npm run build:renderer
git add renderer/src/features/jobs renderer/src/pages/JobDetailPage.tsx
git commit -m "feat: make job artifacts the primary workspace"
```

### Task 5: Creation Workflow Visual and Regression Gate

**Files:**
- Modify only files from Tasks 1-4 when verification reveals a defect.

**Interfaces:**
- Produces: independently shippable creation-center and job-detail redesign.

- [ ] **Step 1: Run automated gates**

```bash
npm run check
npm test
npm run build:renderer
```

Expected: all commands exit 0.

- [ ] **Step 2: Run copy and leakage scans**

```bash
rg -n "Creative workspace|视频提示词|SHOT [0-9]|后端服务运行中" renderer/src/pages/JobListPage.tsx renderer/src/pages/JobDetailPage.tsx renderer/src/features/jobs
rg -n "cameraMotion|visualLayers|action" renderer/src/features/jobs/artifacts/ShotArtifact.tsx
```

Expected: the first command returns no user-facing obsolete copy. The second returns matches only inside the “制作信息” details implementation.

- [ ] **Step 3: Inspect four representative states**

Start the desktop app with `npm run dev` and inspect:

- 1440x900: list default, one active-work strip, no backend port, details uses main artifact canvas plus sidebar.
- 1024x768: rail remains; context opens through “活动与信息”.
- 390x844: bottom navigation remains visible; filters open in a sheet; workflow console and video player do not overflow.
- Failed regeneration: current error and retry appear while the last valid artifact remains visible.

- [ ] **Step 4: Capture screenshots**

Save screenshots under:

```text
output/playwright/creative-canvas/jobs-list-1440.png
output/playwright/creative-canvas/jobs-list-390.png
output/playwright/creative-canvas/job-detail-1440.png
output/playwright/creative-canvas/job-detail-390.png
```

Do not commit screenshots unless the repository already tracks `output/playwright` artifacts.

- [ ] **Step 5: Commit verification fixes only if needed**

```bash
git status --short
git diff --check
git add renderer/src/pages/JobListPage.tsx renderer/src/pages/JobDetailPage.tsx renderer/src/features/jobs
git commit -m "fix: close creation workflow UI regressions"
```
