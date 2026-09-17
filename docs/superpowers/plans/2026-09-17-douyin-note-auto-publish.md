# 抖音图文自动发布 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在发布中心为图文交付包提供「发布图文到抖音」动作：调用外部 `sau` CLI 提交，处理短信验证码，把结果记为「已提交」，最终由人点现有「标记已发布」确认。

**Architecture:** 复用现有交付包与发布中心（版本/排期/审计/垃圾桶全部白拿），只给 `DeliveryPackage` 加 `contentType` 与图文素材/文案字段，并在 `PublishTask` 上挂 `autoPublish` 子记录表达机器动作 —— **不动 `PublishTaskStatus` 状态机**。新增 `sau-runner.ts` 封装外部 CLI，与既有 yt-dlp / whisper-cli / hyperframes 同模式；图文素材直接用应用已产出的场景静帧。

**Tech Stack:** Node.js + Express 4 + TypeScript（后端子进程调用）、React 19 + Tailwind CSS（发布中心 UI）、Node 内置 test runner（`node --import tsx --test`）。

**Spec:** `docs/superpowers/specs/2026-09-17-douyin-note-auto-publish-design.md`

## Global Constraints

- **不新增 `PublishTaskStatus` 取值**；`PublishingListStatus`（含 `"broken"`）与既有 filter 语义保持不变。
- `contentType` 缺省视为 `"video"`，存量包与既有用例必须零改动地继续通过。
- 图文文案走独立 `noteCopy`，校验口径独立：douyin 图文 **title ≤20 / note ≤1000 / hashtags ≤10**；现有 `PUBLISH_PLATFORMS.douyin.titleMax = 55` 是视频口径，不得改动。
- 图文素材取 `output/videos/{jobId}/hyperframes/snapshots/frame-*.png` 按场景序；打包时**复制进包目录**，保持包自包含（与视频/封面一致）。
- CLI 退出码 0 只记为 `succeeded`（**已提交**），绝不写 `published`。
- **失败绝不自动重试**；同一任务同时只允许一个 `autoPublish` 运行（冲突返回 409）。
- **`auto-publish` 必须携带 `previewRevision`**：缺失 → 400，与当前内容不一致 → 409，两种情况都**不得产生 `autoPublish` 记录**。「发布前必经预览」因此是服务端约束，顺带拦住"预览之后内容被改"。校验实现在 Task 4（该路由的归属），产出 revision 的预览接口在 Task 5。
- 测试**必须全部使用假 CLI**（临时目录里的 stub 脚本），不得联网、不得调用真实抖音；本计划不包含任何真实发布步骤。
- 未配置 `sauBinary` 时必须给出明确错误（含 spec §1.2 的三个安装坑），不得静默失败。
- 后端改动需 `npm run build:backend` 并重启才生效。

### Task 1: 类型、图文校验口径与图片清单哈希（测试先行）

**Files:**
- Modify: `src/types.ts`
- Modify: `src/lib/publishing-platforms.ts`
- Test: `src/lib/publishing-platforms.test.ts`

**Interfaces:**
- Consumes: 现有 `PlatformCopy`、`validatePlatformCopy`
- Produces: `PublishNotePolicy` + `PUBLISH_NOTE_POLICIES`、`validateNoteCopy(copy): PlatformCopyValidationError[]`、`DeliveryPackage.contentType/imagePaths/noteCopy`、`PublishTask.autoPublish`、`PublishAssetHealth` 增 `missing_images`

- [ ] **Step 1: 写失败用例**

- douyin 图文 title 21 字 → 报错且 message 指出 20 字上限；20 字 → 通过。
- note 1001 字 → 报错；1000 字 → 通过。
- hashtags 超过 10 个 → 报错（沿用既有 hashtag 规则）。
- 视频口径未受影响：`validatePlatformCopy("douyin", …)` 对 55 字标题仍通过（回归断言）。

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test src/lib/publishing-platforms.test.ts`
Expected: FAIL —— `validateNoteCopy` 不存在。

- [ ] **Step 3: 实现类型与校验**

`PUBLISH_NOTE_POLICIES` 只为 douyin 定义图文口径（结构化 `Record<PublishPlatform, PlatformPolicy>` 可先仅含 douyin，其余平台待后续接入时补）。`validateNoteCopy` 复用 `normalizePlatformCopy` 与既有错误形状，仅替换上限来源。

- [ ] **Step 4: 运行确认通过，并跑既有 publishing 用例作为回归**

Run: `node --import tsx --test src/lib/publishing-platforms.test.ts src/lib/publishing-store.test.ts`
Expected: PASS。

### Task 2: 图文打包（测试先行）

**Files:**
- Modify: `src/lib/publishing-assets.ts`
- Test: `src/lib/publishing-assets.test.ts`

**Interfaces:**
- Consumes: Task 1 的类型、`hyperframes/snapshots/frame-*.png`、既有打包/校验流程（`clone`/`copy`、`assetHealth`、sha256 校验）
- Produces: 图文包的 `imagePaths`（包内 `images/NN.png`）、图片清单哈希、`missing_images` 健康值

- [ ] **Step 1: 写失败用例**

在临时 job 目录造 `snapshots/frame-00-at-3s.png`、`frame-01-at-9s.png`（用最小 PNG 字节），断言：

- 打包后包目录里按**场景序**出现 `images/01.png`、`images/02.png`（不是字典序错乱）。
- 包记录含 `contentType: "note"` 与有序 `imagePaths`。
- 图片清单哈希 = 各图 sha256 有序拼接后再哈希；**改动任一张图或调换顺序都会改变哈希**（两个断言）。
- 缺失 `snapshots/` 或一张图都没有时 → `assetHealth === "missing_images"`，且打包报明确错误。
- **存量兼容**：不传图文参数时 `contentType` 为 `"video"`，视频包行为与哈希逐字节不变。

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test src/lib/publishing-assets.test.ts`
Expected: FAIL —— 图文打包分支不存在。

- [ ] **Step 3: 实现**

按场景序收集静帧 → 复制进 `images/` → 计算清单哈希 → 落库；`assetHealth` 判定在 `contentType === "note"` 时走图片分支，视频分支保持原样。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test src/lib/publishing-assets.test.ts`
Expected: PASS，且既有视频打包用例全部保持通过。

### Task 3: `sau-runner.ts`（测试先行，全程假 CLI）

**Files:**
- Create: `src/lib/sau-runner.ts`
- Test: `src/lib/sau-runner.test.ts`

**Interfaces:**
- Consumes: `runCommand`（既有）、`sauBinary` / `sauBaseDir` 配置、我们的 cookie 文件
- Produces: `checkLogin()`、`prepareAccountFile()`、`runUploadNote()`、`syncBackCookies()`；结果形状 `{ ok: boolean; exitCode: number; output: string; needsVerificationCode: boolean }`

- [ ] **Step 1: 写失败用例（用 stub 脚本，绝不联网）**

测试夹具在临时目录写入 shell stub 并 `chmod +x`，通过 `sauBinary` 注入：

- stub 打印 `valid` 退出 0 → `checkLogin()` 返回 ok。
- stub 打印 `invalid` 退出 1 → ok=false。
- 未配置 `sauBinary` → 抛明确错误（消息含"未配置"）。
- `prepareAccountFile()`：读我们的 Cookie 头文件 → 产出 `<sauBaseDir>/cookies/douyin_<name>.json`，断言是 `storage_state` 形状（`cookies[].domain === ".douyin.com"`、含 `sessionid`），**断言文件权限为 600**。
- `syncBackCookies()`：给定一份被改写的 `storage_state` → 我们的 cookie 文件被更新为新的 Cookie 头，且格式仍是 `name=value; …`（往返一致：prepare→syncBack 后内容语义等价）。
- `runUploadNote()`：stub 输出含验证码提示关键字 → `needsVerificationCode === true`；stub 退出 0 → ok=true；退出 1 → ok=false 且 output 被保留。
- 命令拼装：断言传给 stub 的参数里图片数量、`--title`、`--note`、`--tags` 正确（stub 把自己的 argv 写进文件供断言）。

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test src/lib/sau-runner.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 runner**

用既有 `runCommand` 调子进程（与 whisper/yt-dlp 同一套封装），`timeoutMs` 给足（上传是分钟级）；cookie 双向转换实现为纯函数 + 读写分离，便于单测。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test src/lib/sau-runner.test.ts`
Expected: PASS。

### Task 4: 路由、并发互斥与验证码通路（测试先行）

**Files:**
- Modify: `src/lib/publishing-routes.ts`
- Modify: `src/lib/publishing-store.ts`
- Test: `src/app.test.ts`、`src/lib/publishing-store.test.ts`

**Interfaces:**
- Consumes: Task 3 的 runner、Task 2 的图文包
- Produces: `POST /api/publishing/tasks/:id/auto-publish`（**要求 body 带 `previewRevision`**）、`POST /api/publishing/tasks/:id/auto-publish/code`；任务上的 `autoPublish` 记录；store 的包级 `previewRevision` 计算与比对

- [ ] **Step 1: 写失败用例**

- 对非图文包（`contentType` 缺省 video）调用 → 400/422 明确错误。
- **不带 `previewRevision` → 400**，且任务状态与 `autoPublish` 均不被写入。
- **带过期 `previewRevision`（预览后改过文案）→ 409**，同样不写入。
- 未配置 `sauBinary` → 明确错误，且**任务状态与 `autoPublish` 均不被写入**。
- 运行中再次调用 → **409**，且不产生第二条 `autoPublish`。
- 预检 `invalid` → `autoPublish.status === "failed"`，任务**仍为 `ready`**（绝不写 `published`）。
- 需要验证码 → `autoPublish.status === "awaiting_code"`；提交验证码接口把内容写入 `<sauBaseDir>/verify_code.txt`。
- 成功（退出 0）→ `autoPublish.status === "succeeded"`，任务状态**仍不是 `published`**（这是本设计最关键的一条断言）。

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test src/app.test.ts src/lib/publishing-store.test.ts`
Expected: FAIL —— 路由不存在。

- [ ] **Step 3: 实现路由与 store**

互斥用 store 内的运行标记（与既有"运行中重复触发 409"语义一致）；`autoPublish` 读写走既有原子写路径；错误经既有 `route()` 通道。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test src/app.test.ts src/lib/publishing-store.test.ts`
Expected: PASS。

### Task 5: 发布前预览（弹窗 + 服务端必经确认）（测试先行）

**Files:**
- Modify: `src/lib/publishing-routes.ts`、`src/lib/publishing-store.ts`
- Create: `renderer/src/components/PublishPreviewDialog.tsx`
- Test: `src/app.test.ts`、`renderer/src/components/PublishPreviewDialog.test.tsx`

**Interfaces:**
- Consumes: 既有 `GET /api/publishing/packages/:id/cover` 的模式、Task 1 的 `validateNoteCopy`、Task 4 已实现的 `previewRevision` 比对
- Produces: `GET /api/publishing/packages/:id/preview`（**产出** `previewRevision`）、`GET /api/publishing/packages/:id/images/:index`

- [ ] **Step 1: 写失败用例**

- 视频包预览返回视频元数据 + 各平台文案 + `previewRevision`；图文包返回**有序** `imagePaths` + `noteCopy`。
- `GET .../images/:index`：序号与 `imagePaths` 一一对应；越界或缺图 → 404。
- **两个接口产出的 `previewRevision` 必须能被 Task 4 的校验接受**（端到端串起来：先预览取 revision，再带它提交）。

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test src/app.test.ts`
Expected: FAIL —— 预览接口不存在。

- [ ] **Step 3: 实现服务端**

包级 `previewRevision` 是内容指纹：图文包覆盖 `imagePaths`（含顺序）与 `noteCopy`；视频包覆盖视频哈希与各平台文案。沿用既有 `PublishingPreview.previewRevision` 的语义，不新造一套。

- [ ] **Step 4: 写失败用例（组件）**

`renderToStaticMarkup`：视频包渲染 `<video`；图文包渲染 N 张图与 `1/N` 序号；超限文案标红并显示上限。

- [ ] **Step 5: 实现弹窗组件**

按 `contentType` 分支渲染；文案区显示字数/上限并复用 `validateNoteCopy` 判定超限；公共区显示版本、包路径、创建人/时间与 `assetHealth`（缺失资产必须显眼）。

- [ ] **Step 6: 运行确认通过**

Run: `node --import tsx --test src/app.test.ts renderer/src/components/PublishPreviewDialog.test.tsx && npm run check`
Expected: PASS，且既有 publishing 用例全部保持通过。

### Task 6: 发布中心 UI 与配置透传

**Files:**
- Modify: `renderer/src/pages/PublishingPage.tsx`
- Modify: `renderer/src/utils/publishing.ts`
- Modify: `src/app.ts`、`src/server.ts`、`electron/server.ts`
- Test: `renderer/src/utils/publishing.test.ts`

**Interfaces:**
- Consumes: Task 4 的两个接口
- Produces: 「发布图文到抖音」动作、验证码输入框、待确认提示；`sauBinary` / `sauBaseDir` 配置项

- [ ] **Step 1: 写失败用例**

`publishing.ts` 的动作可见性规则：仅当包为 `contentType === "note"` 且 `assetHealth` 不是 `missing_images` 且未在 `published` 状态时，提供 `auto-publish` 动作；`missing_images` 时提供禁用态与原因。

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test renderer/src/utils/publishing.test.ts`

- [ ] **Step 3: 实现 UI 与透传**

动作按钮 + `awaiting_code` 时的输入框（交互沿用现有 PIN 弹窗模式）+ `succeeded` 时在任务行显示「已提交，请在抖音后台确认后点『标记已发布』」。`sauBinary` / `sauBaseDir` 从 env 透传到 `createExpressApp`（对照现有 `hyperframesNpxBinary` 的写法）。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test renderer/src/utils/publishing.test.ts && npm run check`
Expected: 用例通过、`tsc` 双端退出码 0。

### Task 7: 全量验证、编译与人工复核

- [ ] **Step 1: 类型检查与全量测试**

Run: `npm run check && npm test`
Expected: 仅剩既有失败 `src/lib/publishing-service.test.ts` → `startup recovery reports asset phases before due handling and purge`；基线见 `docs/worklog.md`。

- [ ] **Step 2: 编译并重启**

Run: `npm run build:backend`，随后重启独立后端与 Electron。

- [ ] **Step 3: 未配置状态下的人为验证**

不配置 `sauBinary`，在发布中心对图文包点「发布图文到抖音」→ 应看到明确的安装指引错误（含 Python 3.12 与补装 `playwright` 两个坑），且任务状态不变。

- [ ] **Step 4: 配置后只跑预检（不发布）**

配置 `SAU_BINARY` / `SAU_BASE_DIR` 后，触发动作应先在界面上体现预检结果；**本步骤不执行真实发布**。

- [ ] **Step 5: 真实发布留给人工决定**

真实发布会产生公开内容，**不在本计划的自动步骤内**。若你决定执行：先在抖音后台核对素材与文案，发布后回到发布中心点「标记已发布」完成确认。

- [ ] **Step 6: 只暂存本特性文件并提交**

```bash
git add src/types.ts src/lib/publishing-platforms.ts src/lib/publishing-platforms.test.ts \
        src/lib/publishing-assets.ts src/lib/publishing-assets.test.ts \
        src/lib/sau-runner.ts src/lib/sau-runner.test.ts \
        src/lib/publishing-routes.ts src/lib/publishing-store.ts \
        src/lib/publishing-store.test.ts src/app.ts src/app.test.ts \
        src/server.ts electron/server.ts \
        renderer/src/pages/PublishingPage.tsx renderer/src/utils/publishing.ts \
        renderer/src/utils/publishing.test.ts
git commit -m "feat: 抖音图文自动发布（外部 sau 引擎 + 人工确认）"
```
