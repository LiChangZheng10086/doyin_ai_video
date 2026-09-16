# 原视频播放 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在任务详情页的「视频」成果格子里提供「原视频 / 成片」分段切换，让用户能直接观看已下载的抖音原视频，同时保持成片的既有能力与行为不变。

**Architecture:** 后端把 `video-output.ts` 里既有的安全校验抽成一份共用实现 `resolveContainedMp4`，派生出 `resolveSourceVideo`（读 `job.videoPath`）与不变的 `resolveJobVideo`（读成片），新增 `/api/jobs/:id/raw-video/stream` 路由并复用既有 `sendResolvedVideo()` 的 Range 流式实现。前端新增独立的 `SourceVideoArtifact` 播放组件，由 `JobDetailPage` 在视频格子内做分段切换，成片的 `VideoArtifact` 零改动。

**Tech Stack:** Node.js + Express 4 + TypeScript（后端）、React 19 + Tailwind CSS + lucide-react（前端）、Node 内置 test runner（`node --import tsx --test`）。

**Spec:** `docs/superpowers/specs/2026-09-16-raw-video-playback-design.md`

## Global Constraints

- 不改动成片的渲染、发布链路、`isPublishingEligibleVideo`、任务状态机、权限与本地数据结构。
- `resolveJobVideo()` 的行为与错误码必须逐字节不变，`src/lib/video-output.test.ts` 既有 10 个用例不得修改，作为重构回归门禁。
- 安全校验（`.mp4` 扩展名、`realpath` 落在 storage 根内、`dev/ino` 一致、`isFile()`、`size > 0`）**只允许存在一份实现**；`job.videoPath` 是持久化的绝对路径，任何绕过根目录约束的写法都等于开放任意文件读取。
- 原视频未下载时只做占位与引导，**不自动发起下载**；本次不提供原视频下载按钮。
- 不改 `JobContextSidebar` 的「视频文件」字段，不改详情页默认落地 tab 与自动切换逻辑（`JobDetailPage.tsx:171-182`）。
- 后端改动必须 `npm run build:backend` 并重启进程才生效（`check`/`test` 不产出 `dist/`）。
- 提交时只暂存本特性的文件：工作区已有其他未提交改动（P0 昵称/日期兜底、走查产物），不得混入。

### Task 1: resolver 抽取与 `resolveSourceVideo`

**Files:**
- Modify: `src/lib/video-output.ts`
- Test: `src/lib/video-output.test.ts`

**Interfaces:**
- Consumes: `JobRecord.videoPath`、既有 `ResolvedVideoFile`、既有 `VideoOutputError`（`status = 422`）
- Produces: `resolveSourceVideo(storageRoot: string, job: JobRecord): Promise<ResolvedVideoFile>`；新增错误码 `source_video_missing` / `source_video_unreadable`

- [ ] **Step 1: 写失败的解析用例**

在 `src/lib/video-output.test.ts` 追加用例：在临时 storage 根下创建 `raw/videos/<id>.mp4` 并写入已知字节，构造 `videoPath` 指向该文件的 job，断言 `resolveSourceVideo` 返回 canonical path、精确 `size` 与 `mimeType: "video/mp4"`，且 `close()` 可重复调用。

- [ ] **Step 2: 写失败的缺失用例**

断言：`videoPath` 为 `undefined`、指向不存在的文件、或指向 0 字节文件时，均抛 `VideoOutputError` 且 `code === "source_video_missing"`、`status === 422`。

- [ ] **Step 3: 写失败的不可读用例**

沿用既有「根逃逸」用例的写法，断言：非 `.mp4` 扩展名、`../` 逃逸出 storage 根、绝对路径指向根外文件时，均抛 `code === "source_video_unreadable"`。

- [ ] **Step 4: 运行聚焦测试确认失败**

Run: `node --import tsx --test src/lib/video-output.test.ts`
Expected: FAIL —— `resolveSourceVideo` 尚未导出。

- [ ] **Step 5: 抽取共用校验并实现 `resolveSourceVideo`**

把 `resolveJobVideo` 中「候选路径 → 校验 → 打开句柄」的部分抽成 `resolveContainedMp4(storageRoot, candidate)`；`resolveJobVideo` 只保留候选来源（`script.hyperframesVideo.videoPath ?? job.videoOutputPath`）与既有错误码映射，`resolveSourceVideo` 只保留候选来源（`job.videoPath`）与两个新错误码。

- [ ] **Step 6: 运行聚焦测试与回归门禁确认通过**

Run: `node --import tsx --test src/lib/video-output.test.ts`
Expected: PASS —— 新用例通过，且既有 10 个用例（含符号链接、inode 替换、句柄 close 重试）全部保持通过。

### Task 2: `/api/jobs/:id/raw-video/stream` 路由

**Files:**
- Modify: `src/app.ts`
- Test: `src/app.test.ts`

**Interfaces:**
- Consumes: `resolveSourceVideo()`（Task 1）、既有 `sendResolvedVideo(req, res, video, downloadFilename?)`（`src/app.ts:1927`）
- Produces: `GET /api/jobs/:id/raw-video/stream`，支持 `Range` / `HEAD`，错误映射与 `/video/stream` 一致

- [ ] **Step 1: 写失败的分段与 HEAD 用例**

沿用 `src/app.test.ts` 既有 `appFixture()` + `serveApp()` 脚手架：在 storage 根写入 `raw/videos/<id>.mp4` 与对应的 `cache/jobs-index.json` 任务记录（含 `videoPath`），断言 `Range: bytes=0-9` 返回 `206`、`Content-Range: bytes 0-9/<size>`、`Content-Length: 10`，且 `HEAD` 返回同样的头而无 body。

- [ ] **Step 2: 写失败的缺失与 422 用例**

断言：任务不存在返回 `404`；任务存在但 `videoPath` 缺失返回 `422` 且 body 的 `code === "source_video_missing"`；`videoPath` 指向根外文件返回 `422` 且 `code === "source_video_unreadable"`。

- [ ] **Step 3: 运行聚焦测试确认失败**

Run: `node --import tsx --test src/app.test.ts`
Expected: FAIL —— `/raw-video/stream` 返回 404（路由不存在）。

- [ ] **Step 4: 实现路由**

在 `/api/jobs/:id/video/stream` 之后新增 `GET /api/jobs/:id/raw-video/stream`，错误处理逐行对齐既有 `/video/stream`（`job not found` → 404；`VideoOutputError` → `status` + `code`；`isMissingFileError` → 404），成功路径直接调用 `sendResolvedVideo(req, res, video)`，不传入 `downloadFilename`（即 `inline`）。

- [ ] **Step 5: 运行聚焦测试确认通过**

Run: `node --import tsx --test src/app.test.ts`
Expected: PASS —— 新用例通过，既有 `app.test.ts` 用例全部保持通过。

### Task 3: 前端播放组件与分段切换

**Files:**
- Create: `renderer/src/features/jobs/artifacts/SourceVideoArtifact.tsx`
- Modify: `renderer/src/services/api.ts`
- Modify: `renderer/src/pages/JobDetailPage.tsx`
- Test: `renderer/src/features/jobs/artifacts/artifacts.test.tsx`

**Interfaces:**
- Consumes: `apiClient.getRawVideoStreamUrl(id)`、任务记录里的 `job.videoPath`
- Produces: `SourceVideoArtifact`（props: `videoPath?: string`、`streamUrl: string | null`、`streamError: boolean`、`onVideoError: () => void`）；详情页视频格子内的 `原视频 | 成片` 分段状态

- [ ] **Step 1: 写失败的播放器用例**

在 `artifacts.test.tsx` 追加用例（沿用 `renderToStaticMarkup`）：`videoPath` 存在且 `streamUrl` 有值时，渲染含 `controls` 的 `<video>` 且 `src` 指向该流地址。

- [ ] **Step 2: 写失败的占位用例**

断言：`videoPath` 缺失时渲染「原视频尚未下载」，且引导文案中包含「视频转录」字样；不得渲染 `<video`。

- [ ] **Step 3: 写失败的错误态用例**

断言：`streamError` 为真时渲染「原视频文件不可读取」错误卡，且不渲染空白播放器。

- [ ] **Step 4: 运行聚焦测试确认失败**

Run: `node --import tsx --test renderer/src/features/jobs/artifacts/artifacts.test.tsx`
Expected: FAIL —— `SourceVideoArtifact` 尚不存在。

- [ ] **Step 5: 实现 `SourceVideoArtifact`**

三态渲染：播放器（`controls` + `playsInline`，`onError` 交给 `onVideoError`，9:16 外框与 `VideoArtifact` 的播放器保持一致的视觉规格）/ 占位卡（「原视频尚未下载」+ 引导先做视频转录）/ 错误卡（「原视频文件不可读取」）。

- [ ] **Step 6: API 客户端新增流地址**

在 `renderer/src/services/api.ts` 的 `getVideoStreamUrl` 旁新增 `getRawVideoStreamUrl(id)`，返回 `${base}/api/jobs/${id}/raw-video/stream`，与既有实现同构。

- [ ] **Step 7: 详情页接入分段切换**

在 `JobDetailPage.tsx` 视频格子内新增 `原视频 | 成片` 分段控件（常显）：默认选中侧为「成片存在则成片，否则原视频」；原视频侧取流失败落到错误态。成片侧渲染路径（`VideoArtifact` / 红卡 / 「视频还没生成」占位）**逐行保持原样**。

- [ ] **Step 8: 运行聚焦测试确认通过**

Run: `node --import tsx --test renderer/src/features/jobs/artifacts/artifacts.test.tsx`
Expected: PASS —— 新用例通过，既有 9 个 artifact 用例保持通过。

### Task 4: 全量验证与生效

**Files:**
- 无源码改动（验证与部署步骤）

**Interfaces:**
- Consumes: Task 1-3 的产物
- Produces: 可运行的新后端 `dist/` 与重启后的应用

- [ ] **Step 1: 类型检查**

Run: `npm run check`
Expected: 后端与渲染器两个 `tsc --noEmit` 均无输出、退出码 0。

- [ ] **Step 2: 全量测试**

Run: `npm test`
Expected: 新增用例全部通过；除既有失败 `src/lib/publishing-service.test.ts` → `startup recovery reports asset phases before due handling and purge`（376 项 / 374 通过 / 1 跳过 / 1 失败）外无新增失败。

- [ ] **Step 3: 编译后端产物**

Run: `npm run build:backend`
Expected: 退出码 0，`dist/app.js` 与 `dist/lib/video-output.js` 更新。

- [ ] **Step 4: 重启 3100 后端与 Electron**

重启独立后端进程与 Electron 应用（Electron 在 dev 模式加载 `dist/app.js`，必须整个重启）；二者不重启则仍在跑旧代码。

- [ ] **Step 5: 接口层自证 Range 流式**

对真实任务 `97db73e8-1023-4299-8484-54b5927604cd`（其 `videoPath` 指向 1.8 MB 原视频）并发请求：

```bash
curl -s -D - -o /dev/null -r 0-9 http://localhost:3100/api/jobs/97db73e8-1023-4299-8484-54b5927604cd/raw-video/stream
```

Expected: `206`、`Content-Range: bytes 0-9/1848034`、`Content-Length: 10`、`Accept-Ranges: bytes`。

- [ ] **Step 6: 人工视觉复核**

在已打开的 Electron 窗口中进入该任务详情 → 成果画布「视频」格子 → 确认默认落在「原视频」并能播放、切到「成片」显示「视频还没生成」占位。本会话 `cdp_*` / `computer_*` 工具无法挂载（见 `docs/handoff-2026-09-15-ui-audit.md` 第 9 节），故视觉复核为人工。

- [ ] **Step 7: 只暂存本特性文件并提交**

```bash
git add src/lib/video-output.ts src/lib/video-output.test.ts \
        src/app.ts src/app.test.ts \
        renderer/src/services/api.ts \
        renderer/src/pages/JobDetailPage.tsx \
        renderer/src/features/jobs/artifacts/SourceVideoArtifact.tsx \
        renderer/src/features/jobs/artifacts/artifacts.test.tsx
git commit -m "feat: 详情页支持播放已下载的原视频"
```

工作区中的 P0 昵称/日期兜底改动与走查产物不得进入本次提交。
