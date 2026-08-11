# Creative Canvas Collections and Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn collections into creator content libraries with real identity, per-video progress, resumable Skill distillation, and traceable knowledge assets.

**Architecture:** Join existing collection records with existing job overviews in the renderer by Douyin `awemeId`, replacing the current aggregate-count/index guess with real job-step state. Keep streaming Skill generation and all APIs unchanged, while extracting collection queue and Skill content rendering into focused feature components.

**Tech Stack:** React 19, TypeScript 5.8, React Router 7, Tailwind CSS 4, Lucide React, Axios/fetch NDJSON stream, Node test runner

## Global Constraints

- Requires `2026-08-11-creative-canvas-foundation.md` first; may run after or independently of the creation-workflow plan.
- Preserve all collection, batch-step, transcript, Skill generation, rename, delete, auto-sync, and content APIs.
- Use the existing `/api/jobs/overview` response to show real child-job state; do not add a backend endpoint.
- Never infer an individual video's state from aggregate counts or row position.
- Display `avatarUrl` when it loads; use a first-character fallback only for missing or failed images.
- Skill progress must use real streamed values; unknown progress is indeterminate and must not be fabricated.
- Existing Skill content remains accessible while a new generation fails or remains in progress.
- Keep Simplified Chinese copy and Lucide icons; remove decorative English eyebrows and Emoji controls.
- Use shared foundation status, empty-state, dialog, bottom-sheet, and shell components.

---

### Task 1: Build Accurate Collection and Skill View Models

**Files:**
- Create: `renderer/src/features/collections/collectionPresentation.ts`
- Create: `renderer/src/features/collections/collectionPresentation.test.ts`
- Modify: `renderer/src/types/index.ts`

**Interfaces:**
- Produces: `CollectionVideoState`, `CollectionVideoView`, `SkillListItemView`, `getAwemeId`, `buildCollectionVideoViews`, `getCollectionProgress`, `getSkillProgressView`, and `buildSkillListItems`.
- Consumes: `CollectionOverview`, `DouyinVideoItem`, `JobOverview`, `SkillSummary`, and `SkillProgressEvent`.

- [ ] **Step 1: Add renderer-only view types**

Add these types to `collectionPresentation.ts`, not to API response interfaces:

```typescript
export type CollectionVideoState =
  | 'uncreated'
  | 'waiting'
  | 'processing'
  | 'transcribed'
  | 'cleaned'
  | 'scripted'
  | 'done'
  | 'failed';

export interface CollectionVideoView {
  item: DouyinVideoItem;
  job?: JobOverview;
  state: CollectionVideoState;
  stateLabel: string;
  tone: 'neutral' | 'info' | 'processing' | 'success' | 'danger' | 'ai';
}

export interface SkillListItemView extends SkillSummary {
  avatarUrl?: string;
  sourcePageUrl?: string;
  sourceVideoCount: number;
}

export function getCollectionProgress(progress: CollectionOverview['childJobProgress']): {
  completedStages: number;
  totalStages: number;
  percent: number;
};
```

- [ ] **Step 2: Write failing mapping tests**

Use a collection where only the second and fourth videos have jobs, and where `childJobIds` order differs from item order. Assert matching uses URL identity:

```typescript
const views = buildCollectionVideoViews(collection, [fourthJob, secondJob]);
assert.equal(views[0].state, 'uncreated');
assert.equal(views[1].job?.id, secondJob.id);
assert.equal(views[1].state, 'cleaned');
assert.equal(views[3].job?.id, fourthJob.id);
assert.equal(views[3].state, 'failed');
```

Also assert:

```typescript
assert.equal(getAwemeId('https://www.douyin.com/video/7345000000000000000'), '7345000000000000000');
assert.equal(getAwemeId('not-a-douyin-url'), undefined);
assert.equal(buildSkillListItems([skill], [collection])[0].avatarUrl, collection.avatarUrl);
assert.deepEqual(getCollectionProgress(collection.childJobProgress), {
  completedStages: 41,
  totalStages: 65 * 4,
  percent: 16,
});
```

- [ ] **Step 3: Run the focused test and verify failure**

Run `node --import tsx --test renderer/src/features/collections/collectionPresentation.test.ts`.

Expected: FAIL because the module does not exist.

- [ ] **Step 4: Implement deterministic mappings**

`getAwemeId` parses `/video/<digits>` with `URL`, then falls back to a regex for malformed legacy values. `buildCollectionVideoViews` builds a `Map<awemeId, JobOverview>` from `collection.childJobIds` and matching overview source URLs. If an overview is missing or its source URL cannot identify a video, do not guess by array index.

Derive state from real job steps in this order: failed; running; generated video; scripted; cleaned; transcribed; waiting. Use `job.preview.nextActionLabel` only for the next action, not for state classification.

`getSkillProgressView(event)` maps streamed stages to exactly three user stages:

```typescript
const stageMap = {
  collecting: 1, extracting: 1, extracting_item: 1, retrying: 1,
  analyze: 2, planned: 2,
  generating: 3, generating_item: 3, item_done: 3, item_failed: 3, done: 3, error: 3,
} as const;
```

Return the real `progress`, `current`, `total`, `itemId`, `itemLabel`, and error without replacement percentages.

- [ ] **Step 5: Verify and commit**

```bash
node --import tsx --test renderer/src/features/collections/collectionPresentation.test.ts
npm run build:renderer
git add renderer/src/features/collections renderer/src/types/index.ts
git commit -m "feat: derive real collection item progress"
```

### Task 2: Redesign the Collection Library with Real Creator Identity

**Files:**
- Create: `renderer/src/features/collections/CreatorAvatar.tsx`
- Create: `renderer/src/features/collections/CollectionLibraryItem.tsx`
- Create: `renderer/src/features/collections/collectionLibrary.test.tsx`
- Modify: `renderer/src/pages/CollectionListPage.tsx`

**Interfaces:**
- `CreatorAvatarProps`: `{ src?: string; name: string; size?: 'sm' | 'md' | 'lg' }`.
- `CollectionLibraryItemProps`: `{ collection, deleting, onOpen, onRequestDelete }`.

- [ ] **Step 1: Write failing creator identity tests**

Render `CreatorAvatar` with `src="https://example.test/avatar.jpg"` and assert `<img src="https://example.test/avatar.jpg" alt="饺子WTF的头像" loading="lazy" referrerPolicy="no-referrer">`. Render without `src` and assert the fallback displays “饺”. Render `CollectionLibraryItem` and assert nickname, “65 个作品”, last-updated time, and progress are present while “Batch Collection” and a full-width gradient header are absent.

- [ ] **Step 2: Run the test and verify failure**

Run `node --import tsx --test renderer/src/features/collections/collectionLibrary.test.tsx`.

Expected: FAIL because the components do not exist.

- [ ] **Step 3: Implement reliable avatar fallback**

`CreatorAvatar` owns `failed` state. The image is absolutely layered over a neutral fallback; `onError` sets `failed=true`. The fallback remains in the DOM so failed image loading never causes layout movement. Sizes are fixed at 32, 48, and 64px.

- [ ] **Step 4: Implement the creator library row/card**

The item displays avatar, nickname, source platform, work count, update time, overall four-stage completion, current Skill name/version state, and one “打开合集” action. Use a thin progress bar and no more than two compact status indicators. Deletion lives in an overflow button and opens shared `ConfirmDialog` in the page.

- [ ] **Step 5: Integrate the list page**

Retain API key validation, creation dialog, five-second refresh, and deletion API. Replace the three-column gradient-card grid with a content library list at desktop widths; at `xl` it may use two columns, but each item keeps the same horizontal identity-first structure. Replace the English eyebrow with the title “创作者内容库”. Loading uses list skeletons; refresh failure retains loaded collections and shows `InlineNotice`.

- [ ] **Step 6: Verify and commit**

```bash
node --import tsx --test renderer/src/features/collections/collectionLibrary.test.tsx
npm test
npm run build:renderer
git add renderer/src/features/collections renderer/src/pages/CollectionListPage.tsx
git commit -m "feat: make collections creator centered"
```

### Task 3: Rebuild Collection Detail as a Video Queue and Distillation Console

**Files:**
- Create: `renderer/src/features/collections/CreatorIdentity.tsx`
- Create: `renderer/src/features/collections/CollectionActionBar.tsx`
- Create: `renderer/src/features/collections/CollectionVideoQueue.tsx`
- Create: `renderer/src/features/collections/DistillationProgress.tsx`
- Create: `renderer/src/features/collections/collectionDetail.test.tsx`
- Modify: `renderer/src/pages/CollectionDetailPage.tsx`

**Interfaces:**
- `CreatorIdentityProps`: `{ collection, updating, updateMessage?, onSync }`.
- `CollectionActionBarProps`: `{ selectedCount, uncreatedCount, runningStep, hasTranscript, hasSkill, autoSync, onCreateJobs, onRunStep, onViewTranscripts, onGenerateSkill, onViewSkill, onToggleAutoSync }`.
- `CollectionVideoQueueProps`: `{ videos: CollectionVideoView[], selectedIds: Set<string>, onToggle, onToggleAll, onOpenJob }`.
- `DistillationProgressProps`: `{ progress: SkillProgressEvent | null, currentVideo?: CollectionVideoView, existingSkillName?: string, generating: boolean }`.

- [ ] **Step 1: Write failing collection-detail tests**

Render a queue containing uncreated, processing, cleaned, and failed videos. Assert each title is paired with its own state label and only uncreated videos have selectable checkboxes. Render `DistillationProgress` at streamed event `{ stage: 'extracting_item', current: 42, total: 65, progress: 63, itemId: 'job-42' }` and assert “第 42 / 65 条”, “63%”, and the current video title.

Render an error event with an existing Skill and assert both the error and “已有版本仍可使用” appear.

- [ ] **Step 2: Run the focused test and verify failure**

Run `node --import tsx --test renderer/src/features/collections/collectionDetail.test.tsx`.

Expected: FAIL because the components do not exist.

- [ ] **Step 3: Fetch real child job overviews**

In `CollectionDetailPage`, load collection and job overviews together:

```typescript
const [collectionData, jobOverviews] = await Promise.all([
  apiClient.getCollection(id),
  apiClient.getJobOverviews(),
]);
setCollection(collectionData);
setCollectionJobs(jobOverviews.filter((job) => collectionData.childJobIds.includes(job.id)));
```

Refresh both sources on the existing polling interval. Build `videoViews` with `buildCollectionVideoViews`; remove every aggregate-count/index-based per-row state calculation.

- [ ] **Step 4: Implement the creator identity and sticky action bar**

The identity section shows real avatar, nickname, source, collected/created counts, update time, and “同步新作品”. `CollectionActionBar` stays below the utility bar while scrolling on desktop and becomes a fixed bottom selection bar on mobile only when items are selected. Keep existing batch callbacks and Cookie hint behavior.

- [ ] **Step 5: Implement the video queue**

Each row uses a stable 9:16 thumbnail, two-line title, duration/date, one `StatusIndicator`, and an “打开” icon button when a job exists. Image errors use a neutral video placeholder. The queue scrolls with the page rather than an arbitrary 600px internal scroll area; only modal content may use its own scroll container.

- [ ] **Step 6: Implement the distillation console**

Render the three stages “逐视频提取”, “增量归并”, “生成 Skill”. The real progress bar uses `progress.progress` only when finite. During `extracting_item`, map `itemId` to a real video/job title. During `retrying`, show the retry message without resetting completed count. During `error`, keep the previous Skill link visible. Move generated item details behind a disclosure titled “本轮产物”.

- [ ] **Step 7: Preserve transcript and Skill dialogs while reducing the route file**

Keep the existing transcript aggregation, generation options, streaming callback, auto-sync, and Skill result behavior. Move only their presentation into feature components in Task 4; do not rewrite the fetch loop or API calls in this task.

- [ ] **Step 8: Verify and commit**

```bash
node --import tsx --test renderer/src/features/collections/collectionPresentation.test.ts renderer/src/features/collections/collectionDetail.test.tsx
npm run build:renderer
git add renderer/src/features/collections renderer/src/pages/CollectionDetailPage.tsx
git commit -m "feat: turn collection detail into a real work queue"
```

### Task 4: Share Skill Viewing and Redesign the Skills Library

**Files:**
- Create: `renderer/src/features/skills/MarkdownContent.tsx`
- Create: `renderer/src/features/skills/SkillViewer.tsx`
- Create: `renderer/src/features/skills/SkillLibraryItem.tsx`
- Create: `renderer/src/features/skills/skills.test.tsx`
- Modify: `renderer/src/pages/SkillListPage.tsx`
- Modify: `renderer/src/pages/CollectionDetailPage.tsx`

**Interfaces:**
- `MarkdownContentProps`: `{ content: string }`.
- `SkillViewerProps`: `{ open, content: SkillContentResponse | null, loading, error, onClose }`.
- `SkillLibraryItemProps`: `{ skill: SkillListItemView, onView, onOpenCollection, onRename, onRequestDelete }`.

- [ ] **Step 1: Write failing shared viewer tests**

Render Markdown containing headings, paragraphs, ordered/unordered lists, strong text, inline code, fenced code, blockquote, and links. Assert semantic elements are emitted and links use `target="_blank" rel="noreferrer"`.

Render `SkillViewer` and assert tab order begins with `SKILL.md`, while “原始来源” and “元信息” are last. Render a Skill library item and assert source avatar/nickname, coverage count, generation time, and auto-sync state appear. The current API has no Skill version number, so the UI must not fabricate `v1` or another version label.

- [ ] **Step 2: Run the test and verify failure**

Run `node --import tsx --test renderer/src/features/skills/skills.test.tsx`.

Expected: FAIL because shared Skill components do not exist.

- [ ] **Step 3: Extract one Markdown renderer**

Move the existing supported Markdown behavior from both pages into `MarkdownContent`. Preserve current escaping and supported syntax. Delete duplicated `RenderMarkdown` and `renderInline` implementations only after both pages consume the shared component.

- [ ] **Step 4: Implement one shared Skill viewer**

Use the shared overlay behavior, a stable tab model, scrollable content body, loading/error states, and no duplicate close controls. The same component is opened from Collection Detail and Skills.

- [ ] **Step 5: Join Skills with collection identity**

Load both existing endpoints in `SkillListPage`:

```typescript
const [{ skills }, collections] = await Promise.all([
  apiClient.getSkills(),
  apiClient.getCollections(),
]);
setSkillItems(buildSkillListItems(skills, collections));
```

No backend response changes are required. A missing collection still renders the Skill with a neutral fallback avatar and “来源合集不可用”.

- [ ] **Step 6: Rebuild the library UI**

Use a compact list or two-column grid. Name and source identity are primary; generation time and coverage are secondary. “查看” is the only always-visible primary action. “打开合集”, “重命名”, and “删除” move to a menu, with delete using `ConfirmDialog`. Remove the purple-blue icon block and inline hover-only rename control. If a future API adds an explicit version field, it can be displayed without changing this layout.

- [ ] **Step 7: Verify and commit**

```bash
node --import tsx --test renderer/src/features/skills/skills.test.tsx
npm test
npm run build:renderer
git add renderer/src/features/skills renderer/src/pages/SkillListPage.tsx renderer/src/pages/CollectionDetailPage.tsx
git commit -m "feat: connect skills to creator sources"
```

### Task 5: Collections and Skills Visual and Regression Gate

**Files:**
- Modify only files from Tasks 1-4 when verification reveals a defect.

**Interfaces:**
- Produces: independently shippable creator-library and Skills redesign.

- [ ] **Step 1: Run all automated gates**

```bash
npm run check
npm test
npm run build:renderer
```

Expected: all commands exit 0.

- [ ] **Step 2: Prove index-based status inference is gone**

```bash
rg -n "failed >= index|rendered >= index|scripted >= index|cleaned >= index|transcribed >= index" renderer/src
```

Expected: no matches.

- [ ] **Step 3: Inspect representative states**

Start `npm run dev` and verify:

- A collection with valid `avatarUrl` displays the actual image on list and detail.
- A failed image falls back without changing row dimensions.
- Selectively-created jobs match the correct videos by `awemeId`.
- Skill extraction shows the real current item, completed/total, percent, and stage.
- Skill generation failure leaves the prior Skill view action available.
- 390px layout uses bottom navigation and selection action bar without covering the last queue row.

- [ ] **Step 4: Capture screenshots**

Save:

```text
output/playwright/creative-canvas/collections-1440.png
output/playwright/creative-canvas/collection-detail-1440.png
output/playwright/creative-canvas/collection-detail-390.png
output/playwright/creative-canvas/skills-1440.png
```

- [ ] **Step 5: Commit verification fixes only if needed**

```bash
git status --short
git diff --check
git add renderer/src/features/collections renderer/src/features/skills renderer/src/pages/CollectionListPage.tsx renderer/src/pages/CollectionDetailPage.tsx renderer/src/pages/SkillListPage.tsx
git commit -m "fix: close collection and skill UI regressions"
```
