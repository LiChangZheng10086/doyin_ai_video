# AI Streaming Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 AI 洗稿和生成分镜运行期间实时展示模型输出，并仅在完整响应校验成功后保存正式产物。

**Architecture:** 新增内存事件中心管理 `jobId + step` 的短生命周期事件和重放缓冲；AI 客户端通过可选回调上报增量；JobStore 负责把生命周期转换为事件；Express 暴露 SSE；React 在步骤运行期间订阅并渲染预览。现有步骤 POST、任务状态机和产物读取接口保持兼容。

**Tech Stack:** TypeScript、Express 4、OpenAI-compatible SDK streaming、React 19、原生 EventSource、Node test runner

## Global Constraints

- 仅 `clean` 和 `generate_video_prompts` 支持文本流。
- 未完成或未通过校验的 JSON 不得写入正式产物。
- 暂停、失败、断线不得把任务标记成功。
- 保留现有步骤 POST 和 cleaned/video-prompts 接口。
- 不新增 WebSocket、消息队列或第三方流式库。
- 所有用户可见文案使用简体中文。

---

### Task 1: AI 增量输出接口

**Files:**
- Modify: `src/lib/ai-cleaner.ts`
- Test: `src/lib/ai-cleaner.test.ts`

**Interfaces:**
- Produces: `AiStreamUpdate = { delta: string; text: string; model: string }`
- Produces: `AiStreamListener = (update: AiStreamUpdate) => void`
- Changes: `ScriptCleaner.clean(input, signal?, onStream?)`
- Changes: `ScriptCleaner.planShortVideo(script, signal?, onStream?)`

- [ ] **Step 1: Write failing stream aggregation tests**

Mock an async iterable completion with two `delta.content` chunks and assert the listener receives both cumulative previews while the returned cleaned/plan result is still validated normally.

- [ ] **Step 2: Run focused test and verify failure**

Run: `node --import tsx --test src/lib/ai-cleaner.test.ts`

Expected: listener assertions fail because `completeJson` does not request or consume streaming responses.

- [ ] **Step 3: Implement streaming completion**

Add an optional listener to both public AI operations. When supplied, call the SDK with `stream: true`, iterate chunks, extract string or structured text deltas, accumulate the final JSON text, and invoke:

```ts
onStream?.({ delta, text: accumulated, model: this.model });
```

When no listener is supplied, preserve the existing one-shot request. Both paths must feed the same parsing and validation code.

- [ ] **Step 4: Verify focused tests pass**

Run: `node --import tsx --test src/lib/ai-cleaner.test.ts`

- [ ] **Step 5: Commit**

Commit message: `feat: stream AI cleaner output`

### Task 2: 任务步骤事件中心

**Files:**
- Create: `src/lib/job-step-events.ts`
- Create: `src/lib/job-step-events.test.ts`
- Modify: `src/lib/jobs.ts`
- Modify: `src/types.ts`
- Test: `src/lib/jobs.test.ts`

**Interfaces:**
- Produces: `StreamablePipelineStep = "clean" | "generate_video_prompts"`
- Produces: `JobStepStreamEvent` with `id`, `type`, `jobId`, `step`, optional `delta`, `text`, `model`, `message`
- Produces: `JobStepEventHub.subscribe(jobId, step, listener, afterId?) => () => void`
- Produces: `JobStore.subscribeStepEvents(...)`

- [ ] **Step 1: Write failing event hub tests**

Cover ordered ids, replay after `Last-Event-ID`, bounded preview storage, and subscriber cleanup.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --import tsx --test src/lib/job-step-events.test.ts src/lib/jobs.test.ts`

- [ ] **Step 3: Implement event hub and JobStore lifecycle publishing**

Publish `started` after `markStepRunning`, `preview` from AI callbacks, `completed` only after `markStepSucceeded`, `error` after final failure, and `paused` from `pauseStep`. Keep only the latest cumulative preview plus a bounded event history.

- [ ] **Step 4: Verify no half-product writes**

Add tests where the stream emits content and then throws; assert cleaned/script files remain at their prior valid state and the final event is `error`.

- [ ] **Step 5: Run focused tests**

Run: `node --import tsx --test src/lib/job-step-events.test.ts src/lib/jobs.test.ts`

- [ ] **Step 6: Commit**

Commit message: `feat: publish AI job step events`

### Task 3: SSE HTTP endpoint

**Files:**
- Modify: `src/app.ts`
- Test: `src/app.test.ts`

**Interfaces:**
- Produces: `GET /api/jobs/:id/steps/:step/events`
- Consumes: `JobStore.subscribeStepEvents(jobId, step, listener, afterId?)`

- [ ] **Step 1: Write failing endpoint tests**

Assert supported steps return `text/event-stream`, events contain `id/event/data`, replay honors `Last-Event-ID`, unsupported steps return 400, and disconnect removes the subscriber.

- [ ] **Step 2: Run endpoint tests and verify failure**

Run: `node --import tsx --test src/app.test.ts`

- [ ] **Step 3: Implement SSE response**

Validate job and step, set no-cache/keep-alive headers, flush headers, subscribe, send a 15-second comment heartbeat, and clean up subscription/timer on request close. Terminal events close the response after writing.

- [ ] **Step 4: Run endpoint tests**

Run: `node --import tsx --test src/app.test.ts`

- [ ] **Step 5: Commit**

Commit message: `feat: expose AI step event stream`

### Task 4: 前端订阅与实时预览

**Files:**
- Modify: `renderer/src/types/index.ts`
- Modify: `renderer/src/services/api.ts`
- Modify: `renderer/src/pages/JobDetailPage.tsx`
- Modify: `renderer/src/features/jobs/artifacts/RewriteArtifact.tsx`
- Create: `renderer/src/features/jobs/artifacts/StreamingArtifact.tsx`
- Test: `renderer/src/features/jobs/artifacts/artifacts.test.tsx`
- Test: `renderer/src/services/api.test.ts`

**Interfaces:**
- Produces: `ApiClient.subscribeJobStep(id, step, handlers) => Promise<() => void>`
- Produces: `AiStreamPreview` with `step`, `text`, `model`, `receivedLength`, `status`, optional `message`
- Consumes: SSE endpoint from Task 3

- [ ] **Step 1: Write failing parser and rendering tests**

Test parsing named SSE events, cleanup, wash preview copy “生成中，尚未保存”, storyboard monospaced preview, and terminal event handling.

- [ ] **Step 2: Run focused renderer tests and verify failure**

Run: `node --import tsx --test renderer/src/services/api.test.ts renderer/src/features/jobs/artifacts/artifacts.test.tsx`

- [ ] **Step 3: Implement subscription client**

Initialize the server port, create EventSource, parse `started/preview/completed/paused/error`, expose a cleanup function, and report connection errors without triggering a second step request.

- [ ] **Step 4: Integrate JobDetailPage**

Subscribe before calling `runJobStep` for streamable steps. Show the wash preview in the AI rewrite tab and raw storyboard preview in the shots tab. On completion, clear preview and reload the formal artifact. On pause/failure, close the stream and preserve the final message.

- [ ] **Step 5: Run focused renderer tests**

Run: `node --import tsx --test renderer/src/services/api.test.ts renderer/src/features/jobs/artifacts/artifacts.test.tsx`

- [ ] **Step 6: Commit**

Commit message: `feat: show live AI generation previews`

### Task 5: 全量验证

**Files:**
- Modify only files required by discovered regressions.

- [ ] **Step 1: Run type checks**

Run: `npm run check`

- [ ] **Step 2: Run all tests**

Run: `npm test`

- [ ] **Step 3: Build application bundles**

Run: `npm run build:backend && npm run build:renderer && npm run build:electron`

- [ ] **Step 4: Verify behavior manually**

Start the app, run AI 洗稿 and 生成分镜, verify text appears incrementally, pause closes the stream, retry starts with an empty preview, and final structured output replaces the preview.

- [ ] **Step 5: Commit verification fixes**

Commit message when needed: `fix: harden AI stream lifecycle`
