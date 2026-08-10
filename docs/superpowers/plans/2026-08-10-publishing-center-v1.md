# 发布中心 V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不自动上传第三方平台、不改变现有四步视频生成链路的前提下，为有效 MP4 增加发布包、四平台文案、版本、人工发布队列、排期提醒、审计和 30 天发布垃圾桶。

**Architecture:** 发布中心作为成片后的独立领域。`PublishingStore` 以 `cache/publishing-index.json` 为唯一真相源，并通过单写队列、原子 JSON 和源任务互斥保证一致性；`PublishingService` 编排资格检查、动态 AI 文案、资产事务、状态迁移和投影修复；Express 路由从本地会话解析操作者。React 提供五步创建向导和按作品聚合的发布中心，Electron 只负责打开平台、Finder 定位和系统通知。

**Tech Stack:** TypeScript 5、Node.js `fs/promises`/`crypto`/`child_process`、Express 4、现有 OpenAI-compatible AI 客户端、React 19、Zustand、Axios、Lucide React、Electron 34、Node test runner。

## Global Constraints

- Implements `REQ-001` through `REQ-011`, `REQ-013`, and `REQ-014` from `docs/superpowers/specs/2026-08-10-publishing-center-design.md`; consumes the completed local identity plan for `REQ-012`.
- V1 only supports `douyin`, `xiaohongshu`, `wechat_channels`, and `bilibili`; no custom platform and no platform credentials.
- Never upload, fill a platform form, click publish, transcode, rerender, or duplicate video per platform.
- All user-visible copy and AI prompts use Simplified Chinese. AI input excludes full transcripts and shot-production metadata.
- `cache/publishing-index.json` is authoritative. `manifest.json` and platform text files are projections and cannot overwrite the index.
- All user writes use the server-resolved `ActorSnapshot`; automated due checks, startup recovery, and purge use `SYSTEM_ACTOR`.
- Published task content is immutable. A correction requires a new package version, except an administrator may withdraw the local status to `ready` with a reason.
- Browser mode must degrade clearly when Finder, external-open, clipboard, or system notification capabilities are unavailable.
- Do not introduce PostgreSQL, SQLite, the historical Python backend, a tray process, OS scheduler, platform SDK, or a new runtime dependency.
- This plan starts only after the local-users plan completion gate is green.

## Requirement Coverage

| Requirement | Implemented by |
| --- | --- |
| `REQ-001` | Tasks 1, 6, 9: fixed manual-delivery boundary and no platform automation |
| `REQ-002` | Tasks 4, 5, 8: shared MP4 eligibility and create-time revalidation |
| `REQ-003` | Tasks 4-5: one clone/copy video, optional cover, manifest and independent package assets |
| `REQ-004` | Tasks 1, 3, 8: one-shot Simplified Chinese platform copy, fallback, editing and validation |
| `REQ-005` | Tasks 2, 5, 8-9: four independent platform tasks, monotonic versions and published-content lock |
| `REQ-006` | Tasks 2, 5, 8, 10: per-platform scheduling, due transition, catch-up and notification deduplication |
| `REQ-007` | Tasks 1, 7, 9: copy text, Finder reveal and fixed official creator URLs |
| `REQ-008` | Tasks 2, 5, 6, 9: explicit transitions, cancel/restore/failure/withdraw and atomic audit |
| `REQ-009` | Tasks 2, 4-5, 11: serialized atomic index, asset rollback and startup recovery |
| `REQ-010` | Tasks 2, 4-5, 9-10: due/action/asset error distinctions and safe Simplified Chinese feedback |
| `REQ-011` | Tasks 2, 4-5, 9, 11: separate 30-day publishing trash, restore, purge and tombstones |
| `REQ-012` | Consumed from the prerequisite local-users plan; Tasks 5-6 and 9 enforce its actor/role contract |
| `REQ-013` | Tasks 6-10: complete publishing REST client, wizard, center, filters and feedback |
| `REQ-014` | Tasks 4, 6, 11: old MP4 compatibility and regression gates for the four-step workflow |

---

## File Structure

### Create

- `src/lib/publishing-platforms.ts` and `.test.ts`: fixed platform policy, normalization, validation, publish text, URLs.
- `src/lib/publishing-store.ts` and `.test.ts`: index, write queue, source locks, versions, transitions, audit, trash, due checks.
- `src/lib/publishing-copy.ts` and `.test.ts`: one-shot multi-platform AI copy, fallback, single-platform regeneration.
- `src/lib/video-output.ts` and `.test.ts`: shared safe MP4 resolver extracted from `src/app.ts`.
- `src/lib/publishing-assets.ts` and `.test.ts`: clone/copy, cover extraction, checksums, package transaction and projections.
- `src/lib/publishing-service.ts` and `.test.ts`: publishing use cases and startup recovery.
- `src/lib/publishing-routes.ts`: REST boundary, permission enforcement and stable errors.
- `renderer/src/utils/publishing.ts` and `.test.ts`: platform metadata, filters, status/action helpers and copy text.
- `renderer/src/components/CreatePublishPackageDialog.tsx`: five-step package wizard.
- `renderer/src/components/PublishingDuePoller.tsx`: due catch-up and one-shot notifications.
- `renderer/src/pages/PublishingPage.tsx`: publishing center and publishing trash.

### Modify

- `src/types.ts`: publishing domain, request and result types.
- `src/app.ts`: publishing dependency wiring, routes, startup recovery, shared video resolver.
- `src/app.test.ts`: publishing API and legacy regression tests.
- `renderer/src/types/index.ts`: publishing API types.
- `renderer/src/services/api.ts`: publishing client methods.
- `renderer/src/electron-bridge.ts`: explicit browser capability degradation.
- `renderer/src/App.tsx`: publishing navigation, route and due poller.
- `renderer/src/pages/JobDetailPage.tsx`: “加入发布中心” entry and wizard.
- `README.md`: manual publishing boundary, storage and recovery.

---

### Task 1: 平台策略与公共领域类型

**Files:**
- Modify: `src/types.ts`
- Modify: `renderer/src/types/index.ts`
- Create: `src/lib/publishing-platforms.ts`
- Create: `src/lib/publishing-platforms.test.ts`

**Interfaces:**
- Produces all publishing unions and records from specification section 7.
- Produces `PUBLISH_PLATFORMS`, `normalizePlatformCopy()`, `validatePlatformCopy()`, and `buildPublishText()`.

- [ ] **Step 1: Write failing platform-policy tests**

```typescript
test("supports only the four approved platforms", () => {
  assert.deepEqual(Object.keys(PUBLISH_PLATFORMS), [
    "douyin", "xiaohongshu", "wechat_channels", "bilibili",
  ]);
});

test("normalizes hashtags without truncating user content", () => {
  const copy = normalizePlatformCopy({
    title: "  标题  ", description: " 正文 ", hashtags: ["#AI", "AI", "", " 视频 "],
  });
  assert.deepEqual(copy, { title: "标题", description: "正文", hashtags: ["AI", "视频"] });
});

test("reports the platform, field, actual length and limit", () => {
  const errors = validatePlatformCopy("xiaohongshu", {
    title: "这是一段超过二十个字符且绝对不能被静默截断的小红书标题",
    description: "", hashtags: [],
  });
  assert.deepEqual(errors[0], {
    platform: "xiaohongshu", field: "title", actual: 27, limit: 20,
    message: "小红书标题当前 27 字，最多 20 字",
  });
});

test("buildPublishText omits empty sections", () => {
  assert.equal(buildPublishText({ title: "标题", description: "", hashtags: ["AI", "视频"] }), "标题\n\n#AI #视频");
});
```

- [ ] **Step 2: Run and verify failure**

Run: `node --import tsx --test src/lib/publishing-platforms.test.ts`

Expected: FAIL because publishing types and policy helpers do not exist.

- [ ] **Step 3: Add exact domain types**

```typescript
export type PublishPlatform = "douyin" | "xiaohongshu" | "wechat_channels" | "bilibili";
export type PublishTaskStatus = "scheduled" | "ready" | "published" | "failed" | "cancelled";
export type PublishPackageState = "active" | "trashed" | "purged";
export type PublishCopySource = "ai" | "cleaned_fallback" | "user_edited";
export type PackageVideoMethod = "clone" | "copy";
export type PublishAssetHealth = "healthy" | "missing_cover" | "broken_video";

export interface PlatformCopy {
  title: string;
  description: string;
  hashtags: string[];
}

export interface PublishTask extends PlatformCopy {
  id: string;
  packageId: string;
  platform: PublishPlatform;
  copySource: PublishCopySource;
  status: PublishTaskStatus;
  scheduledAt?: string;
  dueNotifiedAt?: string;
  publishedAt?: string;
  lastError?: string;
  contentRevision: number;
  createdAt: string;
  updatedAt: string;
}

export interface PublishingTombstone {
  packageId: string;
  sourceJobId: string;
  version: number;
  platforms: Array<{ platform: PublishPlatform; finalStatus: PublishTaskStatus }>;
  createdAt: string;
  publishedAt?: string;
  deletedAt: string;
  purgedAt: string;
  videoSha256: string;
  auditSummary: Array<{ action: string; actor: ActorSnapshot; createdAt: string }>;
}

export interface PublishingIndex {
  schemaVersion: 1;
  revision: number;
  nextVersionBySource: Record<string, number>;
  packages: Record<string, DeliveryPackage>;
  tasks: Record<string, PublishTask>;
  audit: PublishAuditEvent[];
  tombstones: Record<string, PublishingTombstone>;
}

export interface PublishingPackageDetail {
  package: DeliveryPackage;
  tasks: PublishTask[];
  audit: PublishAuditEvent[];
  tombstone?: PublishingTombstone;
}

export interface DueNotification {
  taskId: string;
  packageId: string;
  platform: PublishPlatform;
  platformLabel: string;
  title: string;
  scheduledAt: string;
  becameReadyAt: string;
  overdueMs: number;
}

export interface PublishingPreview {
  sourceJobId: string;
  nextVersion: number;
  previewRevision: string;
  video: { filename: string; size: number; width: number; height: number; duration: number; coverAvailable: boolean };
  copies: Partial<Record<PublishPlatform, PlatformCopy & { copySource: PublishCopySource }>>;
  warning?: { code: string; message: string };
  expectedPackagePath: string;
}

export interface CreatePublishingPackageInput {
  sourceJobId: string;
  previewRevision: string;
  title: string;
  platforms: Array<{
    platform: PublishPlatform;
    copy: PlatformCopy;
    copySource: PublishCopySource;
    scheduledAt?: string;
  }>;
}
```

Add `DeliveryPackage`, `PublishAuditEvent`, `PublishingIndex`, `PublishingPackageDetail`, `PublishingPreview`, `PublishingListFilters`, and `PublishingErrorBody` exactly matching the approved spec. `PublishingPreview` includes `previewRevision`; `CreatePublishingPackageInput` requires it. Mirror public response shapes in `renderer/src/types/index.ts`; do not copy persisted-only fields into UI types.

- [ ] **Step 4: Implement fixed platform configuration**

```typescript
export const PUBLISH_PLATFORMS: Record<PublishPlatform, PlatformPolicy> = {
  douyin: { label: "抖音", titleMax: 55, descriptionMax: 1000, hashtagMax: 10, hashtagLengthMax: 20, creatorUrl: "https://creator.douyin.com/creator-micro/content/upload" },
  xiaohongshu: { label: "小红书", titleMax: 20, descriptionMax: 1000, hashtagMax: 10, hashtagLengthMax: 20, creatorUrl: "https://creator.xiaohongshu.com/publish/publish" },
  wechat_channels: { label: "微信视频号", titleMax: 30, descriptionMax: 1000, hashtagMax: 10, hashtagLengthMax: 20, creatorUrl: "https://channels.weixin.qq.com/platform/post/create" },
  bilibili: { label: "哔哩哔哩", titleMax: 80, descriptionMax: 2000, hashtagMax: 10, hashtagLengthMax: 20, creatorUrl: "https://member.bilibili.com/platform/upload/video/frame" },
};
```

Count JavaScript Unicode code points with `[...value].length`, trim fields, remove one or more leading `#`, remove empty/duplicate tags while preserving order, and return field errors instead of truncating.

- [ ] **Step 5: Run tests and type check**

Run: `node --import tsx --test src/lib/publishing-platforms.test.ts && npm run check`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts renderer/src/types/index.ts src/lib/publishing-platforms.ts src/lib/publishing-platforms.test.ts
git commit -m "feat: define publishing platform policies"
```

---

### Task 2: 发布索引、版本、状态机与审计

**Files:**
- Create: `src/lib/publishing-store.ts`
- Create: `src/lib/publishing-store.test.ts`

**Interfaces:**
- Consumes `LocalStorage.writeJsonAtomic()` and `ActorSnapshot` from the identity plan.
- Produces `PublishingStore`, immutable transition methods, due processing, trash/purge metadata, and source-level version allocation.

- [ ] **Step 1: Write failing state and concurrency tests**

```typescript
test("allocates unique monotonically increasing versions for one source", async () => {
  const store = await fixture();
  const versions = await Promise.all(Array.from({ length: 8 }, () => store.reserveVersion("job-1")));
  assert.deepEqual([...versions].sort((a, b) => a - b), [1,2,3,4,5,6,7,8]);
});

test("changes status and appends audit in one persisted revision", async () => {
  const store = await seededFixture("ready");
  await store.markPublished("task-1", ACTOR, "2026-08-10T08:00:00.000Z");
  const index = await store.snapshot();
  assert.equal(index.tasks["task-1"].status, "published");
  assert.equal(index.tasks["task-1"].publishedAt, "2026-08-10T08:00:00.000Z");
  assert.equal(index.audit.at(-1)?.action, "task.mark_published");
  assert.deepEqual(index.audit.at(-1)?.actor, ACTOR);
});

```

Required additional state-store test matrix:

- Attempt `published -> failed`, assert `publish_invalid_transition`, and compare pre/post index bytes.
- Submit `expectedRevision: 1` against revision 2, assert `publish_revision_conflict`, and preserve content/projection.
- Seed one active due task, one already-notified task, and one trashed due task; assert only the first becomes `ready`, has `dueNotifiedAt`, and receives a `SYSTEM_ACTOR` audit.
- Freeze time, trash a package, assert task states are preserved and `purgeAt` equals exactly 30 days after `deletedAt`.
- Write malformed JSON, call `init()`, assert the malformed bytes remain untouched and every subsequent mutation rejects with `publish_index_corrupt`.
- Record an `open_platform` action error, assert task status/revision are unchanged and one actor audit is appended in the same atomic write.

- [ ] **Step 2: Run and verify failure**

Run: `node --import tsx --test src/lib/publishing-store.test.ts`

Expected: FAIL because `PublishingStore` does not exist.

- [ ] **Step 3: Implement serialized mutations and source locks**

```typescript
export class PublishingStore {
  private writeTail: Promise<void> = Promise.resolve();
  private readonly sourceLocks = new Map<string, Promise<void>>();
  private index!: PublishingIndex;
  private readOnlyError: PublishingError | null = null;

  constructor(private readonly storage: LocalStorage, private readonly now = () => new Date()) {}

  init(): Promise<void>;
  snapshot(): Promise<PublishingIndex>;
  reserveVersion(sourceJobId: string): Promise<number>;
  getPackage(packageId: string): Promise<PublishingPackageDetail | null>;
  getTask(taskId: string): Promise<PublishTask | null>;
  commitPackage(input: NewPackageRecord, actor: ActorSnapshot): Promise<PublishingPackageDetail>;
  updateContent(taskId: string, input: PlatformCopy & { expectedRevision: number }, actor: ActorSnapshot): Promise<PublishTask>;
  updateSchedule(taskId: string, scheduledAt: string | null, actor: ActorSnapshot): Promise<PublishTask>;
  cancel(taskId: string, actor: ActorSnapshot): Promise<PublishTask>;
  restoreTask(taskId: string, scheduledAt: string | null, actor: ActorSnapshot): Promise<PublishTask>;
  markPublished(taskId: string, actor: ActorSnapshot, publishedAt?: string): Promise<PublishTask>;
  withdraw(taskId: string, reason: string, actor: ActorSnapshot): Promise<PublishTask>;
  recordFailure(taskId: string, reason: string, actor: ActorSnapshot): Promise<PublishTask>;
  recordActionError(taskId: string, action: "open_platform" | "show_in_finder", message: string, actor: ActorSnapshot): Promise<void>;
  processDue(now?: Date): Promise<DueNotification[]>;
  trashPackage(packageId: string, actor: ActorSnapshot): Promise<DeliveryPackage>;
  restorePackage(packageId: string, actor: ActorSnapshot): Promise<DeliveryPackage>;
  setAssetHealth(packageId: string, health: PublishAssetHealth, actor: ActorSnapshot): Promise<DeliveryPackage>;
  markPurged(packageId: string, tombstone: PublishingTombstone, actor: ActorSnapshot): Promise<void>;
  recordPurgeFailure(packageId: string, message: string, actor: ActorSnapshot): Promise<void>;
  list(filters: PublishingListFilters): Promise<PublishingPackageDetail[]>;
}
```

Use one `mutate()` helper that clones the current index, applies a synchronous mutation, writes with `writeJsonAtomic()`, then publishes the in-memory copy. The transition table must exactly match specification section 12. `processDue()` only examines active packages, only changes due `scheduled` tasks to `ready`, sets `dueNotifiedAt`, writes a `task.due` audit with `SYSTEM_ACTOR`, and returns only newly notified tasks.

Persist `nextVersionBySource` so deleted/purged versions are never reused. On JSON parse failure, preserve `publishing-index.json`, set read-only protection, allow reads that can be recovered safely, and reject writes with `publish_index_corrupt`.

- [ ] **Step 4: Run focused and identity storage tests**

Run: `node --import tsx --test src/lib/publishing-store.test.ts src/lib/storage.test.ts src/lib/local-users.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/publishing-store.ts src/lib/publishing-store.test.ts
git commit -m "feat: add publishing state store"
```

---

### Task 3: AI 平台文案与洗稿回退

**Files:**
- Create: `src/lib/publishing-copy.ts`
- Create: `src/lib/publishing-copy.test.ts`

**Interfaces:**
- Consumes `ServerConfig.resolveAiConfig`, cleaned artifacts, and platform policies.
- Produces `PublishingCopyService.previewAll()` and `regenerateOne()` without persistence.

- [ ] **Step 1: Write failing AI/fallback tests**

```typescript
test("uses one AI request for all selected platforms and sends concise cleaned fields", async () => {
  const client = new FakeChatClient(validFourPlatformJson);
  const service = fixture({ client });
  const result = await service.previewAll(CLEANED, ["douyin", "bilibili"]);
  assert.equal(client.calls.length, 1);
  assert.match(client.calls[0].prompt, /简体中文/);
  assert.doesNotMatch(client.calls[0].prompt, /完整原始转录/);
  assert.deepEqual(Object.keys(result.copies), ["douyin", "bilibili"]);
});

test("falls back to cleaned content when AI is unavailable", async () => {
  const result = await fixture({ resolveAiConfig: async () => null }).previewAll(CLEANED, ["douyin"]);
  assert.equal(result.copies.douyin.copySource, "cleaned_fallback");
  assert.equal(result.warning?.code, "publish_copy_ai_fallback");
});

```

Required additional AI-copy test matrix:

- Regenerate only `xiaohongshu`, assert the response has exactly that key and the fake client receives one requested platform.
- Return malformed JSON from the fake client, assert a valid `cleaned_fallback` item and `publish_copy_ai_fallback` warning.
- Seed cleaned data with a sentinel full transcript and production terms (`SHOT`, `cameraMotion`, `9:16`, `动态图形`); assert none appear in the request while the request contains `只使用简体中文`.

- [ ] **Step 2: Run and verify failure**

Run: `node --import tsx --test src/lib/publishing-copy.test.ts`

Expected: FAIL because `PublishingCopyService` does not exist.

- [ ] **Step 3: Implement one-request generation and strict parsing**

```typescript
export class PublishingCopyService {
  constructor(private readonly deps: {
    resolveAiConfig: () => Promise<AiRuntimeConfig | null>;
    createClient?: (config: AiRuntimeConfig) => OpenAI;
  }) {}

  previewAll(cleaned: CleanedScript, platforms: PublishPlatform[]): Promise<PublishingCopyPreview>;
  regenerateOne(cleaned: CleanedScript, platform: PublishPlatform): Promise<PublishingCopyItem>;
}
```

Build AI input only from `title`, `summary`, `keyPoints`, `shortVideoScript`/`cleanScript` capped to the approved concise range, and `tags`. Require a JSON object keyed only by requested platforms. Normalize and validate every result through Task 1. If config, network, status, parse, shape, or validation fails, produce deterministic cleaned fallback per platform and a safe Simplified Chinese warning. Do not mutate AI-cleaner configuration or artifacts.

- [ ] **Step 4: Run tests and backend type check**

Run: `node --import tsx --test src/lib/publishing-copy.test.ts && npm run check`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/publishing-copy.ts src/lib/publishing-copy.test.ts
git commit -m "feat: generate platform publishing copy"
```

---

### Task 4: 共享成片解析与事务式资产打包

**Files:**
- Create: `src/lib/video-output.ts`
- Create: `src/lib/video-output.test.ts`
- Create: `src/lib/publishing-assets.ts`
- Create: `src/lib/publishing-assets.test.ts`
- Modify: `src/app.ts`

**Interfaces:**
- Produces one resolver used by stream, download, publishing preview, and package creation.
- Produces `PublishingAssetService.createPackageAssets()`, `stageTextProjection()`, `verifyPackageVideo()`, `purgeAssets()`, and startup scan helpers.

- [ ] **Step 1: Characterize the existing video resolver**

Move the current private `resolveVideoFile()` behavior into tests before changing callers:

Write complete fixtures for:

- a current HyperFrames output that resolves to its canonical in-storage MP4 and exact byte size;
- missing, zero-byte, non-`.mp4`, and path-escape candidates, each returning its documented 422 publishing/video error;
- stream and download endpoints resolving the same canonical path through an injected resolver spy.

Run: `node --import tsx --test src/lib/video-output.test.ts src/app.test.ts`

Expected: FAIL until the resolver is exported; existing app tests remain a behavior reference.

- [ ] **Step 2: Extract without changing video endpoints**

```typescript
export interface ResolvedVideoFile { path: string; size: number; mimeType: "video/mp4" }
export async function resolveJobVideo(storageRoot: string, job: JobRecord): Promise<ResolvedVideoFile>;
```

Update `/video/stream` and `/video/download` to call the shared resolver. Re-run existing endpoint tests before adding publishing code.

- [ ] **Step 3: Write failing asset transaction tests**

Implement each fixture with explicit spies and filesystem assertions:

- clone succeeds: first `copyFile` call includes `COPYFILE_FICLONE`, output contains exactly one `video.mp4`, and `videoMethod` is `clone`;
- clone throws `EINVAL`: second call omits clone flags, bytes match source, and method is `copy`;
- clone and ordinary copy fail: no formal directory exists and `.next-*` is removed;
- readable local cover: FFmpeg runner call count stays zero and cover bytes match;
- FFmpeg cover extraction fails: package assets still succeed with `missing_cover` and no `cover.jpg`;
- recursively inspect manifest/platform projections for credential key names, assert only one MP4 exists, and every task references that path.

- [ ] **Step 4: Implement the package transaction**

```typescript
export class PublishingAssetService {
  constructor(private readonly deps: {
    storageRoot: string;
    copyFile?: typeof copyFile;
    rename?: typeof rename;
    rm?: typeof rm;
    runCommand?: CommandRunner;
    now?: () => Date;
  }) {}

  createPackageAssets(input: PackageAssetInput): Promise<PackageAssetResult>;
  stageTextProjection(detail: PublishingPackageDetail): Promise<ProjectionTransaction>;
  verifyPackageVideo(pkg: DeliveryPackage): Promise<PublishAssetHealth>;
  purgeAssets(pkg: DeliveryPackage): Promise<void>;
  scanAndRepair(index: PublishingIndex): Promise<PublishingRecoveryReport>;
}
```

Use these task-local transaction interfaces:

```typescript
type CommandRunner = (command: string, args: string[], options: { timeoutMs: number }) => Promise<{ stdout: string; stderr: string }>;

interface PackageAssetInput {
  packageId: string;
  sourceJobId: string;
  version: number;
  sourceVideoPath: string;
  sourceCoverPath?: string;
  title: string;
  tasks: PublishTask[];
  actor: ActorSnapshot;
}

interface PackageAssetResult {
  packagePath: string;
  videoPath: string;
  coverPath?: string;
  videoSha256: string;
  videoSize: number;
  videoMethod: PackageVideoMethod;
  assetHealth: PublishAssetHealth;
  rollback(): Promise<void>;
}

interface ProjectionTransaction {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

interface PublishingRecoveryReport {
  removedTempPaths: string[];
  orphanPaths: string[];
  repairedPackageIds: string[];
  brokenPackageIds: string[];
  notifications: DueNotification[];
  purgedPackageIds: string[];
  purgeFailures: Array<{ packageId: string; message: string }>;
}
```

Create `output/publishing/{sourceJobId}/.next-{packageId}`, clone using `COPYFILE_FICLONE`, retry once with ordinary `copyFile`, hash copied bytes with SHA-256, reuse a readable local cover or call FFmpeg `-ss 1 -i source -frames:v 1 -q:v 2 cover.jpg`, write `manifest.json` and four text files per selected platform, then atomically rename to `v{version}-{packageId}`. No formal directory is visible before all files are ready.

Return a rollback function or enough paths for `PublishingService` to remove the formal directory if index commit fails. `stageTextProjection()` writes a sibling temporary platform directory and returns `{ commit, rollback }`; `commit()` swaps the projection while retaining its backup until the index write succeeds, and `rollback()` restores the exact prior bytes.

- [ ] **Step 5: Run focused and regression tests**

Run: `node --import tsx --test src/lib/video-output.test.ts src/lib/publishing-assets.test.ts src/app.test.ts`

Expected: PASS; video stream/download headers and range behavior remain unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/app.ts src/lib/video-output.ts src/lib/video-output.test.ts src/lib/publishing-assets.ts src/lib/publishing-assets.test.ts
git commit -m "feat: package publishing assets safely"
```

---

### Task 5: 发布用例编排、版本和恢复

**Files:**
- Create: `src/lib/publishing-service.ts`
- Create: `src/lib/publishing-service.test.ts`

**Interfaces:**
- Consumes jobs/cleaned artifacts, Tasks 1-4, and identity snapshots.
- Produces preview, create/version, edit/schedule/status, trash/restore, recovery and purge use cases.

- [ ] **Step 1: Write failing orchestration tests**

```typescript
test("preview checks assets and returns copy without persistence", async () => {
  const service = await fixture();
  const before = await service.debugIndexHash();
  const preview = await service.preview("job-1", ["douyin", "bilibili"]);
  assert.equal(preview.video.width, 1080);
  assert.equal(await service.debugIndexHash(), before);
  assert.equal(await pathExists(preview.expectedPackagePath), false);
});

```

Required additional orchestration test matrix:

- Change/remove the source MP4 after preview, force index commit failure after asset rename, assert 422 on revalidation or complete directory rollback (`AC-043`).
- Seed an old package with published/failed/cancelled tasks, create a version, assert copied copy/platforms but only new `ready`/`scheduled` states (`AC-070`).
- Edit a published task, assert 409, unchanged revision, unchanged index bytes, and no projection staging call.
- Force projection exchange then index commit failure; assert the previous projection bytes and previous index bytes are restored.
- Seed stale temp/orphan, missing projection, broken active video, due task and expired trash; assert the ordered recovery report and final states.
- Delete the source job directory after a package exists; assert package verification and Finder path still use package-local `video.mp4`.

- [ ] **Step 2: Run and verify failure**

Run: `node --import tsx --test src/lib/publishing-service.test.ts`

Expected: FAIL because the orchestration service does not exist.

- [ ] **Step 3: Implement explicit use cases**

```typescript
export class PublishingService {
  preview(jobId: string, platforms: PublishPlatform[]): Promise<PublishingPreview>;
  create(input: CreatePublishingPackageInput, actor: ActorSnapshot): Promise<PublishingPackageDetail>;
  createVersion(packageId: string, input: CreateVersionInput, actor: ActorSnapshot): Promise<PublishingPackageDetail>;
  updateContent(taskId: string, input: UpdatePublishContentInput, actor: ActorSnapshot): Promise<PublishTask>;
  updateSchedule(taskId: string, scheduledAt: string | null, actor: ActorSnapshot): Promise<PublishTask>;
  cancel(taskId: string, actor: ActorSnapshot): Promise<PublishTask>;
  restoreTask(taskId: string, scheduledAt: string | null, actor: ActorSnapshot): Promise<PublishTask>;
  markPublished(taskId: string, actor: ActorSnapshot): Promise<PublishTask>;
  withdraw(taskId: string, reason: string, actor: ActorSnapshot): Promise<PublishTask>;
  recordFailure(taskId: string, reason: string, actor: ActorSnapshot): Promise<PublishTask>;
  recordActionError(taskId: string, action: "open_platform" | "show_in_finder", message: string, actor: ActorSnapshot): Promise<void>;
  trashPackage(packageId: string, actor: ActorSnapshot): Promise<DeliveryPackage>;
  restorePackage(packageId: string, actor: ActorSnapshot): Promise<DeliveryPackage>;
  checkDue(): Promise<DueNotification[]>;
  recoverOnStartup(): Promise<PublishingRecoveryReport>;
}
```

`preview()` computes `previewRevision = sha256(sourceJobId + canonicalVideoPath + videoSize + videoMtimeMs + cleanedMtimeMs + sortedPlatforms)`. `create()` recomputes and compares it before asset operations, validates every platform draft, reserves a version, creates assets, commits package/tasks/audit once, and removes assets if commit fails. A reserved version remains consumed after failure. `createVersion()` defaults to previous platform selection and copy but initializes each task from its new schedule; terminal states never carry over.

For content edits, build and stage text projections first, then commit the index; if commit fails restore the old projection. For package restore, restore original platform states, immediately process now-overdue schedules, and return notifications for the UI to dispatch.

Startup recovery order is fixed: remove stale `.next-*` → report orphan formal directories → verify active videos and update health only → repair platform text from index → process due tasks → purge expired trash. Purge success writes a lightweight tombstone; purge failure keeps `trashed` and an audit/error for retry.

- [ ] **Step 4: Run service/store/assets tests**

Run: `node --import tsx --test src/lib/publishing-service.test.ts src/lib/publishing-store.test.ts src/lib/publishing-assets.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/publishing-service.ts src/lib/publishing-service.test.ts
git commit -m "feat: orchestrate publishing packages"
```

---

### Task 6: 发布 REST API、权限与兼容门禁

**Files:**
- Create: `src/lib/publishing-routes.ts`
- Modify: `src/app.ts`
- Modify: `src/app.test.ts`

**Interfaces:**
- Consumes `PublishingService`, `requireActor()`, `getActor()`, and `SYSTEM_ACTOR`.
- Produces every route in specification section 15.2 and stable error responses.

- [ ] **Step 1: Add failing API integration tests**

Cover exact route behavior:

Required integration test matrix with seeded sessions and temporary storage:

- Preview returns 401 without a session, 200 with publisher/admin, leaves index hash unchanged, and creates no formal directory.
- Publisher creates a package, edits content, schedules, cancels and restores; each response and audit contains the server-resolved publisher snapshot.
- A failed platform-open/Finder action appends `task.action_error` with its fixed action enum while preserving status, schedule, revision and `lastError`.
- Publisher receives 403 for withdraw, package trash and package restore; compare index bytes before/after.
- Admin withdraws with a required reason, trashes and restores; missing confirmation/reason returns 400.
- Due check works without a session, uses `SYSTEM_ACTOR`, and cannot accept a requested status/actor override.
- Exercise representative 400/401/403/404/409/422/500 paths and assert stable code plus Simplified Chinese message.
- Re-run existing four manual step endpoints and video stream/download assertions unchanged (`AC-100`).

- [ ] **Step 2: Run and verify failure**

Run: `node --import tsx --test src/app.test.ts`

Expected: FAIL with 404 for publishing routes.

- [ ] **Step 3: Register publishing dependencies once**

Reuse the existing `ServerConfig.resolveAiConfig?: () => Promise<AiRuntimeConfig | null>` hook so publishing copy reads the current Electron AI configuration on every request; preserve the standalone HTTP environment-variable fallback.

Construct `PublishingStore`, `PublishingCopyService`, `PublishingAssetService`, and `PublishingService` in `createExpressApp()`. Call `await publishingStore.init()` and `await publishingService.recoverOnStartup()` before accepting requests. Recovery failures must be logged and surfaced as publishing read-only/health state, not prevent unrelated creative APIs from starting.

- [ ] **Step 4: Implement route permissions and bodies**

```typescript
export function registerPublishingRoutes(
  app: Express,
  deps: { publishing: PublishingService; sessions: LocalSessionStore }
): void;
```

- All preview/create/version/content/schedule/task-state/action-error requests require publisher or admin session.
- Withdraw, package delete, and package restore require admin.
- `POST /api/publishing/due/check` is unauthenticated and calls only `checkDue()`; it never accepts actor/status in the body.
- List/detail require a valid local session because they expose local publishing history.
- Confirmation booleans are required for `mark-published`, `cancel`, `withdraw`, and package delete; `withdraw` and `record-failure` require non-empty reasons.
- Ignore or reject any client-supplied `actor`, `role`, `createdBy`, `status`, `publishedAt`, `videoPath`, or `packagePath`.

Use one error mapper returning `{ code, message, details? }`. Never serialize internal stack traces or sensitive config.

- [ ] **Step 5: Run all backend checks**

Run: `npm run check && node --import tsx --test src/app.test.ts src/lib/publishing-*.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app.ts src/app.test.ts src/lib/publishing-routes.ts
git commit -m "feat: expose publishing api"
```

---

### Task 7: 前端发布客户端与纯交互规则

**Files:**
- Modify: `renderer/src/types/index.ts`
- Modify: `renderer/src/services/api.ts`
- Modify: `renderer/src/electron-bridge.ts`
- Create: `renderer/src/utils/publishing.ts`
- Create: `renderer/src/utils/publishing.test.ts`

**Interfaces:**
- Consumes publishing REST API and the operator session interceptor.
- Produces typed client methods, filters, status labels, action permissions, due formatting, and desktop capability guards.

- [ ] **Step 1: Write failing pure UI tests**

Required pure-function test matrix:

- packages from two source jobs group under the correct source and versions sort `v3`, `v2`, `v1`;
- default action-needed selection includes `ready`, `failed`, and `broken_video`, while excluding scheduled future/published/cancelled;
- publisher action IDs exclude `withdraw` and `trash-package`, while administrator actions include them;
- a published task exposes `create-version` but neither `edit-content` nor `schedule`;
- overdue text contains both the original Simplified Chinese plan time and rounded overdue duration;
- title/body/tags/full-copy strings omit empty sections and match backend formatting.

- [ ] **Step 2: Run and verify failure**

Run: `node --import tsx --test renderer/src/utils/publishing.test.ts`

Expected: FAIL because helpers do not exist.

- [ ] **Step 3: Add typed API methods**

Add methods for all section 15.2 endpoints: `previewPublishing`, `createPublishingPackage`, `listPublishingPackages`, `getPublishingPackage`, `checkPublishingDue`, `createPublishingVersion`, `updatePublishingContent`, `updatePublishingSchedule`, `cancelPublishingTask`, `restorePublishingTask`, `markPublishingTaskPublished`, `withdrawPublishingTask`, `recordPublishingFailure`, `recordPublishingActionError`, `trashPublishingPackage`, and `restorePublishingPackage`.

All errors use the existing shared Axios parser and prefer backend `message`/`code`. The session header comes only from the operator store integration; methods never accept an actor.

- [ ] **Step 4: Make Electron/browser capabilities explicit**

Expose capability-aware wrappers:

```typescript
export type DesktopCapabilities = {
  openExternal: boolean;
  showItemInFolder: boolean;
  showNotification: boolean;
};
```

Electron uses existing bridge methods. Browser fallback reports unavailable instead of silently pretending Finder or system notification succeeded; normal `navigator.clipboard` remains available when permitted.

- [ ] **Step 5: Run frontend tests and build**

Run: `node --import tsx --test renderer/src/utils/publishing.test.ts && npm run build:renderer`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add renderer/src/types/index.ts renderer/src/services/api.ts renderer/src/electron-bridge.ts renderer/src/utils/publishing.ts renderer/src/utils/publishing.test.ts
git commit -m "feat: add publishing client rules"
```

---

### Task 8: 成片页五步创建向导

**Files:**
- Create: `renderer/src/components/CreatePublishPackageDialog.tsx`
- Modify: `renderer/src/pages/JobDetailPage.tsx`

**Interfaces:**
- Consumes publishing preview/create APIs and current operator.
- Produces asset check, platform selection, copy review, per-platform scheduling, confirmation, and success choices.

- [ ] **Step 1: Add wizard state reducer tests**

Put the reducer and validation in `renderer/src/utils/publishing.ts` and test:

Required wizard reducer test matrix:

- advancing from platform selection with no platform leaves the step unchanged and sets a field error;
- an over-limit title preserves its exact text, blocks confirmation, and attaches platform/field/actual/limit;
- editing one generated field changes only that platform source to `user_edited`;
- replacing a regenerated Xiaohongshu draft preserves byte-identical drafts for all other platforms (`AC-019`);
- future schedules map to `scheduled`, while empty/current/past values map to `ready` independently per platform.

- [ ] **Step 2: Run and verify failure**

Run: `node --import tsx --test renderer/src/utils/publishing.test.ts`

Expected: FAIL for missing wizard helpers.

- [ ] **Step 3: Add the eligible-video entry**

In the existing video output section, show “加入发布中心” only when `video-output` reports a usable MP4. Keep player and download behavior unchanged. If a session is absent, clicking opens the operator chooser; it must not infer or submit an actor locally.

- [ ] **Step 4: Build the five-step dialog**

1. Asset: filename, 1080x1920, duration, size, cover candidate, estimated additional bytes, and warnings.
2. Platforms: four fixed checkbox rows with platform icon/name; at least one.
3. Copy: per-platform tabs, title/body/tag controls, live counts, source badge, field errors, and single-platform regenerate.
4. Schedule: independent “立即待发布” / future local datetime selection per platform.
5. Confirm: source title, next version, selected platforms, schedules, storage path, cover warning, and explicit manual-publishing statement.

Preview cannot create a directory. The final submit sends the current draft and expected preview revision; backend revalidates. On success show “前往发布中心” and “继续查看成片” without automatic navigation.

- [ ] **Step 5: Build and manually test failure paths**

Run: `npm run build:renderer`

Expected: PASS.

Manual: no session, missing MP4, AI fallback, field overflow, single-platform regenerate, future schedule, backend 409, and successful package creation.

- [ ] **Step 6: Commit**

```bash
git add renderer/src/components/CreatePublishPackageDialog.tsx renderer/src/pages/JobDetailPage.tsx renderer/src/utils/publishing.ts renderer/src/utils/publishing.test.ts
git commit -m "feat: add publishing package wizard"
```

---

### Task 9: 发布中心、人工动作与发布垃圾桶

**Files:**
- Create: `renderer/src/pages/PublishingPage.tsx`
- Modify: `renderer/src/App.tsx`

**Interfaces:**
- Consumes list/detail/status APIs, platform policies, current role, clipboard and Electron capabilities.
- Produces grouped versions, filters, expandable tasks, audit timeline, manual delivery actions and separate publishing trash.

- [ ] **Step 1: Add navigation/filter metadata tests**

Extend `publishing.test.ts`:

```typescript
test("publishing filters include all approved states and separate trash", () => {
  assert.deepEqual(PUBLISH_FILTERS.map((item) => item.id), [
    "action", "all", "ready", "scheduled", "published", "failed", "cancelled", "broken", "trash",
  ]);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `node --import tsx --test renderer/src/utils/publishing.test.ts`

Expected: FAIL until filter metadata is exported.

- [ ] **Step 3: Add route and page shell**

Add a Lucide `Send` navigation item labeled “发布中心” and route `/publishing`. Default query is action-needed. Page controls include status, platform, source job, version, creator, and text search; feed those to the list API instead of filtering only the current page in memory.

- [ ] **Step 4: Implement grouped package/task rows**

Each source group shows title and versions descending. Each package shows cover/placeholder, `vN`, asset health, creator, created time, and platform task rows. Expanded task shows copy, schedule/published time, copy source, content revision, and immutable audit timeline.

Actions:

- Copy title/body/tags/full copy with inline success/failure feedback.
- Finder reveal only when capability exists and asset is healthy.
- Open fixed official platform URL; missing cover produces a confirmation reminder.
- Mark published, record failure, cancel, restore/re-schedule with required confirmations/reasons.
- Published task shows “创建新版本”; admin additionally sees “撤回本地已发布状态”.
- Admin package delete moves it to publishing trash. If any task is published, confirmation says platform video is unaffected.
- Trash is a separate view. It disables all schedule/publish actions and permits admin restore only before purge.

External-open/Finder failures call `POST /api/publishing/tasks/:id/action-error` with the fixed action enum and a sanitized message; the server appends audit without changing task status.

- [ ] **Step 5: Build and run role walkthrough**

Run: `npm run build:renderer && npm run build:electron`

Expected: PASS.

Manual as publisher: view/create/edit/copy/open/mark/cancel/restore; verify no withdraw/delete action and direct API remains 403. Manual as admin: withdraw with reason, trash with published warning, restore.

- [ ] **Step 6: Commit**

```bash
git add renderer/src/pages/PublishingPage.tsx renderer/src/App.tsx renderer/src/utils/publishing.ts renderer/src/utils/publishing.test.ts
git commit -m "feat: add manual publishing center"
```

---

### Task 10: 到期轮询、系统通知与启动补处理

**Files:**
- Create: `renderer/src/components/PublishingDuePoller.tsx`
- Modify: `renderer/src/App.tsx`
- Modify: `src/app.test.ts`

**Interfaces:**
- Consumes unauthenticated `POST /api/publishing/due/check` and desktop notification bridge.
- Produces 30-second runtime checks, startup/visibility catch-up and one notification per schedule cycle.

- [ ] **Step 1: Add backend notification-dedup tests**

```typescript
test("due check returns a task only on its first due transition", async () => {
  const first = await post("/api/publishing/due/check");
  const second = await post("/api/publishing/due/check");
  assert.equal(first.body.notifications.length, 1);
  assert.equal(second.body.notifications.length, 0);
});

```

Required additional cases: re-schedule a previously notified ready task into the future and assert `dueNotifiedAt` clears before exactly one later notification; seed cancelled and trashed due tasks and assert neither status nor audit changes and the notification list stays empty.

- [ ] **Step 2: Run and verify behavior**

Run: `node --import tsx --test src/app.test.ts src/lib/publishing-store.test.ts`

Expected: PASS if Tasks 2/6 fully implemented; otherwise fix domain behavior before adding UI polling.

- [ ] **Step 3: Implement one mounted poller**

```tsx
export function PublishingDuePoller() {
  useEffect(() => {
    let disposed = false;
    const check = async () => {
      const result = await api.checkPublishingDue();
      if (disposed) return;
      for (const item of result.notifications) {
        await electron.showNotification({
          title: `${item.platformLabel} 待发布`,
          body: `${item.title}，原计划 ${formatDateTime(item.scheduledAt)}${formatOverdue(item)}`,
        });
      }
    };
    void check();
    const timer = window.setInterval(check, 30_000);
    const onVisible = () => document.visibilityState === "visible" && void check();
    document.addEventListener("visibilitychange", onVisible);
    return () => { disposed = true; clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, []);
  return null;
}
```

Mount once in `App`, independent of publishing page navigation and operator login. Do not open platform or navigate automatically. In browser mode, update UI readiness normally and skip unavailable system notifications with a visible capability hint in the publishing page.

- [ ] **Step 4: Build and manually verify clock cases**

Run: `npm run build:renderer && npm run build:electron`

Expected: PASS.

Manual with an injectable/test clock: first due notification, no duplicate after 30 seconds/restart, re-schedule then notify once, app-start overdue message, no notification for cancelled/trashed task.

- [ ] **Step 5: Commit**

```bash
git add renderer/src/components/PublishingDuePoller.tsx renderer/src/App.tsx src/app.test.ts
git commit -m "feat: notify due publishing tasks"
```

---

### Task 11: 恢复、文档和完整验收

**Files:**
- Modify: `README.md`
- Modify only where tests reveal gaps: files created in Tasks 1-10

**Interfaces:**
- Produces a releasable publishing center with explicit operational and recovery documentation.

- [ ] **Step 1: Add recovery integration cases**

Ensure automated coverage for:

- stale `.next-*` cleanup and orphan directory reporting;
- broken/empty/checksum-mismatched MP4 marked `broken_video` without changing task status;
- missing platform text repaired from the index;
- expired trash assets removed and lightweight tombstone retained;
- purge failure remains `trashed` and retries later;
- corrupt index preserved and publishing writes disabled while creative APIs still work;
- deleting source jobs and publishing packages never cascades across domains.

Run: `node --import tsx --test src/lib/publishing-service.test.ts src/app.test.ts`

Expected: PASS.

- [ ] **Step 2: Document the manual boundary and storage**

Add README sections covering:

```text
发布中心只准备本地交付包和人工操作，不保存平台凭据或自动发布。
发布包位于 output/publishing/{sourceJobId}/v{version}-{packageId}。
排期只在应用运行时检查；退出期间的任务在下次启动补处理。
发布垃圾桶保留 30 天；清理只删除本地发布资产，不影响源作品或平台视频。
索引损坏时发布写操作进入只读保护，先备份 cache/publishing-index.json 再人工恢复。
```

- [ ] **Step 3: Run the complete automated gate**

Run:

```bash
npm run check
npm test
npm run build:backend
npm run build:renderer
npm run build:electron
```

Expected: all commands PASS, including existing job, collection, Skills, AI, ASR, HyperFrames, video stream and download tests.

- [ ] **Step 4: Run the Electron acceptance flow**

Use a temporary storage directory and one valid legacy MP4:

1. Publisher opens a legacy completed job and sees “加入发布中心”.
2. Preview performs no write; AI failure shows cleaned fallback and still allows creation.
3. Select all four platforms, edit one copy, set four different schedules, create `v1`.
4. Verify one package MP4, optional cover, manifest, four platform directories, hashes and no secrets.
5. Create `v2`; verify independent directories/statuses and no reused version.
6. Verify default action-needed list, all filters, copy controls, fixed official URLs and Finder reveal.
7. Advance time; verify one notification, no auto-open and no duplicate after restart.
8. Mark one task published; verify content lock and new-version path.
9. As publisher, verify withdraw/delete return 403. As admin, withdraw with reason and confirm platform disclaimer.
10. Cancel/restore another task; verify audit history and restored schedule behavior.
11. Trash a package containing a published task, verify warning and no notifications; restore before expiry.
12. Simulate expiry; verify local assets removed, tombstone retained, source job and other package versions intact.
13. Remove package MP4; verify `broken_video` disables Finder/mark-published without changing task status.

- [ ] **Step 5: Trace acceptance criteria**

Create a test comment/table in the final implementation PR description mapping:

- AC-001–009: platform boundary and platform task independence.
- AC-010–020, AC-039–051, AC-059–070: assets, copy, versions and locking.
- AC-021–038, AC-071–083: scheduling, transitions, audit and manual actions.
- AC-052–058: publishing trash and tombstones.
- AC-084–094: consumed identity tests plus publishing authorization integration.
- AC-095–104: preview purity, API errors, legacy compatibility, concurrency and corrupt-index protection.

No criterion may be marked complete solely from UI visibility when server behavior is required.

- [ ] **Step 6: Commit documentation and final fixes**

```bash
git add README.md src renderer
git commit -m "docs: document manual publishing workflow"
```

---

## Completion Gate

Do not claim V1 complete until:

- AC-001 through AC-104 have automated or explicit Electron evidence.
- Every publishing mutation is authorized server-side and writes an actor audit in the same atomic index commit.
- A publishing preview leaves no index record or formal package directory.
- Concurrent same-source package creation cannot reuse a version or lose an index update.
- AI failure produces labeled cleaned fallback; no full transcript or production prompt enters the publishing AI request.
- Package creation, content projection and purge failures preserve the last valid index/assets and report a stable Simplified Chinese error.
- Existing four-step generation, video preview/download, collections, Skills, settings and trash behavior remain green.
- The app never uploads, auto-fills, auto-opens on due, stores platform credentials, or claims that local deletion affects a platform video.
