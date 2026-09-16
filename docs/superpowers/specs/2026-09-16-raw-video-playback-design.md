# 抖创工坊 原视频播放 设计规格

**状态：** APPROVED
**批准日期：** 2026-09-16
**日期：** 2026-09-16
**产品：** 抖创工坊
**范围：** 任务详情页「视频」成果格子的原视频播放能力（后端流式路由 + 前端分段切换）
**实施边界：** 只新增原视频的读取与播放路径；不改动成片的渲染与发布链路、任务状态机、权限与本地数据结构

## 1. 背景与结论

用户反馈：在创作中心点击任务进入详情后，希望能看到该任务的视频。

实测任务 `97db73e8-1023-4299-8484-54b5927604cd`（topic「马尾辫」，列表显示「待执行 / 开始生成分镜」）的真实状态：

| 项 | 值 |
| --- | --- |
| `transcribe` / `clean` | `succeeded` |
| `generate_video_prompts` / `generate_video` | `pending` |
| `videoPath`（原视频） | **存在**：`raw/videos/97db73e8-1023-4299-8484-54b5927604cd.mp4`，1.8 MB |
| `videoOutputPath`（成片） | 无 |

代码层面的两个缺口：

- 详情页**只能播「成片」**。`GET /api/jobs/:id/video/stream` 与 `/video/download` 都走 `resolveJobVideo()`，而它只解析 `script.hyperframesVideo.videoPath ?? job.videoOutputPath`（`src/lib/video-output.ts:36`）。因此在执行「生成视频」之前，这两个接口必然失败。
- 已下载的**原视频在详情页只有一行文件路径文本**（`JobContextSidebar.tsx:51` 的 `<Field label="视频文件" value={job.videoPath} />`），后端没有任何路由能提供原视频字节流。

结论：「进入详情看这个视频」当前无法实现，缺的正是原视频的播放能力。本次补齐它，并保留成片的既有能力。

## 2. 已确认设计决策

| 决策 | 结果 |
| --- | --- |
| 目标视频 | 原视频 + 成片，两者可切换 |
| 切换入口位置 | 现有「视频」成果 tab 内做分段切换，不增加顶层 tab 数量 |
| 原视频未下载时 | 显示占位并引导先做「视频转录」，**不自动发起下载** |
| 成片逻辑 | 完全不动（下载 MP4、加入发布中心、metrics 保持原样） |
| 原视频下载按钮 | 本次不做 |
| 侧栏「视频文件」字段 | 保持不变 |
| 默认选中侧 | 成片存在则选「成片」（保持现有行为），否则选「原视频」 |

## 3. 后端设计

### 3.1 resolver 复用：安全边界只保留一份

`src/lib/video-output.ts` 现有 `resolveJobVideo()` 内含一组安全校验：扩展名必须为 `.mp4`、`realpath` 必须落在 storage 根内、`dev/ino` 一致、`isFile()`、`size > 0`。

把这段逻辑抽成共用私有函数 `resolveContainedMp4(storageRoot, candidate)`，两个导出函数各自只负责「候选路径从哪来」：

- `resolveJobVideo(storageRoot, job)` —— 成片，候选为 `script.hyperframesVideo.videoPath ?? job.videoOutputPath`；**行为与错误码保持逐字节不变**，现有 `video-output.test.ts` 的 10 个用例不得修改。
- `resolveSourceVideo(storageRoot, job)` —— 原视频，候选为 `job.videoPath`；新增。

**为什么必须复用而不是新写**：`job.videoPath` 是持久化在任务记录里的绝对路径。若新路由不做同样的根目录约束，一条被篡改的记录即可把该接口变成任意文件读取（例如指向 `/etc/passwd`）。这是本次改动最大的风险点，因此校验只允许存在一份实现。

### 3.2 错误码

`VideoOutputError`（`status = 422`）保持不动，新增两个并列错误码：

| code | 文案 |
| --- | --- |
| `source_video_missing` | 未找到原视频，请先执行视频转录 |
| `source_video_unreadable` | 原视频文件不可读取，请检查文件权限后重试 |

现有 `publish_video_missing` / `publish_video_unreadable` 的 code 与文案均不修改。

### 3.3 路由

```
GET /api/jobs/:id/raw-video/stream
```

- 命名与既有 `raw-share` / `raw-page` / `raw-transcript` 一致；路径与 `video/stream`、`video/download` 同构。
- 实现直接调用 `resolveSourceVideo()` + 既有 `sendResolvedVideo()`（`src/app.ts:1927`），Range、`206`、`HEAD`、`416`、`Content-Range`、`Accept-Ranges` 全部复用，不新增流式代码。
- 错误映射沿用 `/video/stream` 现有写法：`job` 不存在返回 `404`，`VideoOutputError` 返回其 `status`（`422`）与 code。

## 4. 前端设计

### 4.1 API 客户端

`renderer/src/services/api.ts` 新增 `getRawVideoStreamUrl(id)`，与现有 `getVideoStreamUrl(id)`（同文件 `510-512` 行）同构，返回 `http://localhost:${serverPort}/api/jobs/${id}/raw-video/stream`。

### 4.2 分段切换与状态矩阵

在 `JobDetailPage.tsx` 的「视频」成果格子（现 `514-537` 行分支）顶部放一个二选一分段控件，**常显**：`原视频 | 成片`。两侧各自独立处理三种状态：

| | 有内容 | 没有内容 | 有记录但读不到 |
| --- | --- | --- | --- |
| **原视频** | `<video controls playsInline>` 播放器 | 占位「原视频尚未下载」+ 引导先做**视频转录** | 错误卡「原视频文件不可读取」 |
| **成片** | 现有 `VideoArtifact`，**零改动** | 现有「视频还没生成」占位 | 现有红卡 |

「有没有原视频」的判据是任务记录里的 `job.videoPath`（详情页已有该数据，不需要额外请求）；若字段存在但文件已被删除，由流请求失败落到「原视频文件不可读取」错误卡，而不是留一个空白播放器。

### 4.3 默认选中规则

```
成片存在（videoOutput 有值） → 默认选中「成片」   // 保持现有行为不变
否则                        → 默认选中「原视频」
```

效果：已成片的任务打开视频格子看到的仍是成片；而只有原视频的任务（如本文第 1 节那条）打开就直接看到原视频，而不是先看到「视频还没生成」。

**不改变详情页的默认落地 tab**：`activeTab` 的初始值与自动切换逻辑（`JobDetailPage.tsx:171-182`）保持原样，本次不因原视频存在就自动跳到「视频」格子。

## 5. 明确不做

- 原视频的「下载」按钮（本次只做「能看」；路由后续加一个 `attachment` 分支即可，但不在本次范围）
- `JobContextSidebar` 中「视频文件」路径字段的任何改动
- 成片渲染、发布中心、`isPublishingEligibleVideo` 等一切成片相关逻辑
- 原视频的自动下载（未下载时只做引导）
- 详情页默认落地 tab 与自动切换逻辑的调整

## 6. 测试与验证

**后端单测** `src/lib/video-output.test.ts`（新增，不改既有 10 例）：`resolveSourceVideo` 正常解析出规范化路径与精确 size、`videoPath` 缺失时报 `source_video_missing`、拒绝非 `.mp4` 与 storage 根逃逸（报 `source_video_unreadable`）、空文件报 missing。

**后端路由测试** `src/app.test.ts`（沿用现有 `createExpressApp` 脚手架）：`/raw-video/stream` 的 `206` 分段、`HEAD`、任务不存在 `404`、`videoPath` 缺失 `422`。

**前端组件测试** `renderer/src/features/jobs/artifacts/artifacts.test.tsx`：默认选中侧规则、原视频占位文案与引导、错误态。

**验证命令**：`npm run check`、`npm test`、`npm run build:backend`。测试基线为 376 项（374 通过 / 1 跳过 / **1 个既有失败**）：`src/lib/publishing-service.test.ts` 的 `startup recovery reports asset phases before due handling and purge`，已确认与本特性无关，不应把它算作本次回归。

**生效条件**：后端改动必须 `npm run build:backend` **并重启进程**才会生效（`npm run check`/`npm test` 都不产出 `dist/`）；Electron 端需整个重启才会重新加载 `dist/app.js`。

**UI 视觉复核的限制**：本机 `cdp_*` 与 `computer_*` 工具在当前 DSH 版本下均无法挂载（原因见 `docs/handoff-2026-09-15-ui-audit.md` 第 9 节），因此视觉复核依赖人工观察已打开的 Electron 窗口；接口层以 curl 发送 Range 请求自证。

## 7. 风险

| 风险 | 处理 |
| --- | --- |
| 路径穿越 / 任意文件读取 | 校验逻辑抽取后两侧共用一份实现；测试覆盖根逃逸、符号链接与 inode 替换 |
| 抽取重构破坏成片既有行为 | `resolveJobVideo` 的行为与错误码保持不变，既有 10 个测试作为回归门禁 |
| 成片与源视频编码差异导致浏览器不解码 | 播放器 `onError` 落到「原视频文件不可读取」错误卡，不留空白播放器 |
| 大文件流式播放占用句柄 | 复用 `sendResolvedVideo` 的句柄与 `close()` 生命周期管理，不新增句柄逻辑 |

## 8. 影响面

| 文件 | 改动 |
| --- | --- |
| `src/lib/video-output.ts` | 抽取 `resolveContainedMp4`，新增 `resolveSourceVideo` 与两个错误码 |
| `src/app.ts` | 新增 `GET /api/jobs/:id/raw-video/stream` |
| `renderer/src/services/api.ts` | 新增 `getRawVideoStreamUrl` |
| `renderer/src/pages/JobDetailPage.tsx` | 视频格子内新增分段切换与两侧状态渲染 |
| `src/lib/video-output.test.ts`、`src/app.test.ts`、`renderer/src/features/jobs/artifacts/artifacts.test.tsx` | 新增用例 |
