# 抖创工坊

基于 Electron + React 的桌面应用，用于抖音视频采集、转录、AI 洗稿、Skills 蒸馏、本地竖屏视频生成与多平台发布（发布中心按平台分栏：**抖音**图文由外部 sau 引擎提交、**今日头条**文章与**小红书**图文由自研 Playwright 执行器提交（小红书默认只填到草稿），其余人工交付；每个平台内部再按图文/视频/文章分）。当前视频生成通过 HyperFrames CLI 本地渲染 HTML/CSS/GSAP 成 MP4。

## 项目架构

```
douyin/
├── src/                    # 后端（Node + Express）
│   ├── app.ts / server.ts   # Express 装配 / 独立 HTTP 入口
│   ├── lib/
│   │   ├── jobs.ts ai-cleaner.ts storage.ts media.ts asr.ts   # 任务/洗稿/存储/下载/ASR
│   │   ├── hyperframes-video.ts video-output.ts range-response.ts
│   │   ├── assets-store.ts assets-routes.ts                   # 素材库
│   │   ├── local-users.ts local-auth.ts local-user-routes.ts   # 本机操作者与会话
│   │   ├── publishing-*.ts                                    # 发布中心（资产/文案/平台/服务/存储/路由）
│   │   ├── sau-runner.ts                                       # 抖音图文（外部 sau CLI）
│   │   ├── article-draft.ts toutiao-article.ts toutiao-media.ts # 文章内核 + 头条限额/渲染/封面
│   │   ├── toutiao-browser.ts toutiao-page.ts toutiao-runner.ts # 头条解析链/页面步骤/执行器
│   │   ├── note-media.ts                                       # 图文配图裁 3:4（平台中立）
│   │   ├── xhs-browser.ts xhs-page.ts xhs-runner.ts            # 小红书解析链/页面步骤/执行器
│   │   ├── collections.ts nickname.ts user-page-crawler.ts     # 合集/昵称/主页采集
│   │   └── secret-scan.ts                                      # 凭据扫描
│   └── types.ts
├── renderer/src/           # 前端（React 19 + Vite + Tailwind）
│   ├── pages/              # JobListPage JobDetailPage PublishingPage AssetsPage
│   │                       # CollectionList/Detail SkillList TrashPage SettingsPage
│   ├── components/         # PublishPreviewDialog QrLoginPanel ToutiaoLoginPanel XhsLoginPanel
│   │                       # CreateNotePackageDialog CreateToutiaoArticleDialog PublishingChannelTabs
│   │                       # shell/（侧栏、顶栏、移动端导航）
│   ├── utils/publishing.ts # 发布中心纯函数（渠道/计数/动作可见性/提示）
│   ├── services/api.ts  store/  types/index.ts
├── electron/               # 主进程、配置 IPC、内嵌后端装配
├── scripts/                # 只读侦察与复核脚本（probe-*、verify-*、check-secrets）
├── docs/                   # specs / plans / research / worklog / patches
└── dist/ dist-electron/    # 两套编译产物（见「构建与运行」）
```

## 技术栈

### 后端
- Node.js 18+、Express 4、TypeScript
- `openai`：OpenAI-compatible AI 洗稿
- `yt-dlp`：视频下载（外部二进制）
- `ffmpeg` / `ffprobe`：音视频处理（外部二进制）
- whisper.cpp：内置本地 ASR，默认 `ggml-small` 多语言模型
- HyperFrames CLI：本地竖屏 MP4 渲染（生成视频步骤需要 Node.js 22+ 和 FFmpeg）

### 前端
- React 19、Vite、React Router DOM 7、Zustand、Tailwind CSS、Axios

### 桌面端
- Electron 34、electron-builder

## 核心流程

### 手动分步主链路

```
用户输入（URL 或分享文本）
    ↓
POST /api/jobs 创建任务并解析输入
    ↓
用户在详情页逐步确认执行：
    1. 视频转录（yt-dlp + ffmpeg + 内置 whisper.cpp）
    2. AI 洗稿
    3. 生成视频提示词
    4. 生成 9:16 MP4（HyperFrames）
```

每个步骤独立执行。用户点击某一步后，后端在同一次请求内自动重试最多 3 次；失败后停在当前步骤，用户可手动重试。后一步必须等前一步成功后才能执行。

### 数据存储

**目录取决于运行方式**（易踩坑，按模式确认）：独立后端 `node dist/server.js` → **仓库内 `storage/`**（`src/server.ts` 的 `path.join(rootDir, "storage")`）；
Electron → `app.getPath('userData')/storage`（即 `~/Library/Application Support/douyin-ai-video/storage`，
配置里的 `storagePath` 可覆盖）。

```
storage/
├── raw/{videos,audio,transcripts,page,text}/   # 下载的视频、WAV、结构化转录、页面元数据、分享文本
├── processed/{scripts,cleaned,scenes,subtitles}/
├── output/videos/                              # HyperFrames 项目、snapshots/ 静帧、MP4
├── output/publishing/                          # 发布交付包（自包含：成片 + 封面 + images/）
├── assets/{images,audio}/                      # 素材库
├── cache/                                      # jobs / collections / publishing / assets / local-users 索引
└── logs/
```

注意 `output/videos/{jobId}/hyperframes/snapshots/frame-NN-at-Xs.png` 是 `hyperframes snapshot` 的产物，
每场景一张 1080×1920 静帧，可直接当图文素材。

### 任务状态与步骤

```typescript
type JobStatus = "queued" | "processing" | "done" | "failed";

type JobStage =
  | "submitted"
  | "parsed"
  | "downloading"
  | "downloaded"
  | "extracting"
  | "audio_extracted"
  | "transcribing"
  | "transcribed"
  | "cleaning"
  | "cleaned"
  | "generating-video-prompts"
  | "scripted"
  | "generating-video"
  | "rendered"
  | "failed";

type WorkflowMode = "manual" | "auto";
type PipelineStep = "transcribe" | "clean" | "generate_video_prompts" | "generate_video";
type PipelineStepStatus = "pending" | "running" | "succeeded" | "failed";
```

## API 接口

### 任务管理
- `POST /api/jobs` - 创建任务
- `GET /api/jobs` - 获取未删除任务列表
- `GET /api/jobs/:id` - 获取任务详情
- `DELETE /api/jobs/:id` - 软删除任务到垃圾桶
- `GET /api/jobs/trash` - 获取垃圾桶任务并触发过期清理
- `POST /api/jobs/:id/restore` - 恢复垃圾桶任务
- `DELETE /api/jobs/:id/permanent` - 永久删除垃圾桶任务及关联文件

### 手动步骤
- `POST /api/jobs/:id/steps/transcribe`
- `POST /api/jobs/:id/steps/clean`
- `POST /api/jobs/:id/steps/generate-video-prompts`
- `POST /api/jobs/:id/steps/generate-video`
- `POST /api/jobs/:id/reclean` - 补充内容重新洗稿（body: `{ supplementalText }`），已完成的视频任务也可用

### 内容获取
- `GET /api/jobs/:id/script` - 历史脚本资产
- `GET /api/jobs/:id/cleaned` - AI 清洗结果
- `GET /api/jobs/:id/raw-transcript` - 结构化原始转录
- `GET /api/jobs/:id/video-prompts` - 视频提示词
- `GET /api/jobs/:id/video-output` - HyperFrames 视频输出信息
- `GET /api/jobs/:id/video/download` - 下载 MP4
- `GET /api/jobs/:id/video/stream` - 成片流（支持 Range）
- `GET /api/jobs/:id/raw-video/stream` - **已下载的原视频**流（支持 Range；原视频在「视频转录」步骤落盘到 `raw/videos/{jobId}.mp4`）

### 素材库
- `GET /api/assets?kind=image|audio` - 列表
- `POST /api/assets/images` / `POST /api/assets/audio` - 多文件上传（multipart，字段名 `files`）
- `GET /api/assets/:id/raw` - 原文件（支持 Range，音频进度条依赖）
- `DELETE /api/assets/:id` - 删除记录与磁盘文件

### 本机操作者与权限
- `POST /api/local-sessions/auto` - **启动即用的自动会话**（无 PIN）；无管理员时自动创建「本机用户」
- `GET /api/local-sessions/current` - 当前会话用户
- `GET /api/local-users` - 用户列表
- `POST /api/local-sessions` - 普通开会话（管理员仍需 PIN）

### 发布中心（人工交付）
- `POST /api/jobs/:id/publishing/preview`：body 可带 `contentType: "note"`（图文）、
  `imageSource: "frames"|"library"` + `imageAssetIds[]`；响应回 `images`/`imageLimit`/`copyLimits`。
  配套 `GET /api/jobs/:id/publishing/assets`。
- `POST /api/publishing/packages`（可带 `contentType: "note"` + `noteCopy` + 图片来源）、
  `GET /api/publishing/packages`、`GET /api/publishing/packages/:id`。
- `GET /api/publishing/packages/:id/preview`：**包级预览**（产出 `previewRevision`，下发 `copyChecks`；
  前端只渲染、不复刻字数规则）。
- `GET /api/publishing/packages/:id/images/:index`：图文包第 `index` 张图（0 基，对应 `imagePaths`；越界 404）。
- `GET /api/publishing/packages/:id/article`：文章包的 `article.html`（降级通路，可粘进编辑器）。
- `POST /api/publishing/tasks/:id/auto-publish`：**按「内容类型 × 平台」分派**
  （`note×douyin` → sau；`article×toutiao` → 自研头条执行器；`note×xiaohongshu` → 自研小红书执行器）。
  **必须带 `previewRevision`**：缺失 400、不一致 409；body 可用 `dryRun: true`（**仅小红书**：只填到草稿，**服务端强制不点发布**；
  其余通路传它一律 400）。配套 `POST .../auto-publish/code`（抖音短信验证码 → `<sauBaseDir>/verify_code.txt`）。
- 登录与自检：`POST/GET/DELETE /api/publishing/toutiao/login`（应用内扫码）、
  `POST /api/publishing/toutiao/login/window`（浏览器窗口扫码，同步等 180s）、`POST /api/publishing/toutiao/verify`；
  小红书同形：`/api/publishing/xhs/login`、`/login/window`、`/verify`（**零副作用**自检）。
- `PATCH /api/publishing/tasks/:id/content` / `/schedule`、`POST .../cancel` `/restore`
  `/mark-published` `/record-failure`（`withdraw` 与删除/恢复发布包**仅管理员**）。

## 关键数据结构

> 完整的类型定义**以代码为准**（`src/types.ts` / `renderer/src/types/index.ts`）。
> 这里只列**行为相关**的字段，避免文档与代码各说一份。

- `JobRecord`：`id` / `sourceUrl` / `topic` / `status` / `stage` / `workflowMode` / `steps` /
  `deletedAt`+`trashExpiresAt`（垃圾桶 30 天）/ `videoPath` `audioPath` `audioManifestPath` `transcriptPath`
  `videoProjectPath` `videoOutputPath` `videoGeneratedAt` / `storagePath` / 时间戳。
- `TranscriptAsset`：`transcript`（纯文本）+ `segments`（`{start,end,text}`）+ 可选 `words`
  （`{start,end,word,probability}`）/ `duration` / `language` / `model` / `provider: "whisper.cpp"`。
- `CleanedScript.output`：`title` / `summary` / `keyPoints` / `cleanScript` / `voiceoverScript` /
  `videoOutline[{title,bullets,visualPrompt}]` / `videoPrompts` / `tags` /
  `hyperframesVideo{provider:"hyperframes", projectPath, videoPath, manifestPath, duration, 1080×1920}`。
  其余字段（`transcriptModel` / `rawText` / `enhancedScenes` / `qualityNotes` / `aspectRatio` / `width` / `height` 等）一律以代码为准。

## 配置管理

- **桌面端配置**由 Electron 决定：`app.getPath('userData')/config.json`（即
  `~/Library/Application Support/douyin-ai-video/config.json`）；其中 `storagePath` 无值则回落到同目录 `storage/`。
  API Key 由 Electron `safeStorage` 加密存储。
  ⚠️ `~/.douyin-ai-video/` 是**另一个**用途（`douyin-cookie.txt` 抖音登录态等），**不是** Electron 读配置的位置
  （早期文档写的 `~/.douyin-ai-video/config.json` 是错的，2026-09-17 按实测更正）。
- **独立后端**（`npm start` = `node dist/server.js`）从环境变量读 AI 配置（见 `src/server.ts`）：
  `AI_PROVIDER` / `AI_API_KEY` / `AI_MODEL` / `AI_BASE_URL`。
  桌面端配置形状：`{ aiKeys: [{ id, name, provider, apiKey, baseURL, model, isActive }] }`。
- **抖音图文（sau）**：`SAU_BINARY`（`sau` 可执行文件，例如 `<repo-of-sau>/.venv/bin/sau`）+ `SAU_BASE_DIR`（其仓库根，含 `conf.py`；
  `cookies/` 与 `verify_code.txt` 相对它）。两条入口（独立后端与 Electron）都已透传。
  缺省时**不静默失败**：该通路 422 并给安装指引，其余功能不受影响。
- **头条**：`TOUTIAO_BROWSER_BINARY`（缺省按解析链：显式配置 → Electron 注入 → 开发态
  `vendor/package-assets/browser/chrome-headless-shell/**` → Playwright 缓存 → 系统 Chrome）、
  `TOUTIAO_PROFILE_DIR`（**必须落在 storage 内**）。找不到浏览器时 422 + 两条可照抄的命令与逐层诊断。
- **小红书**：`XHS_BROWSER_BINARY` / `XHS_PROFILE_DIR`（同形，两条入口都透传）。
- **ASR** 固定内置 `whisper.cpp`（**不再调用** OpenAI Whisper API / FunASR / faster-whisper）：模型 `ggml-small`；`MediaService.extractAudio()` 输出
  `raw/audio/{jobId}.wav`（`pcm_s16le` / 16kHz / 单声道）；打包资源
  `resources/whisper/whisper-cli` 与 `resources/whisper/models/ggml-small.bin`，打包前跑 `npm run prepare:whisper`
  （构建机步骤，需要 `cmake`、C/C++ 工具链与 `tar`；最终用户不需要）。旧字段 `asrProvider`/`asrApiKey`/`asrBaseURL`/`asrModel`
  仍兼容读取但不再使用。⚠️ 缺少 `whisper-cli` 或 `ggml-small.bin` 时转录步骤应失败，并提示重新运行
  `npm run prepare:whisper` 或重装完整应用。

## 构建与运行

```bash
npm install
npm run dev              # Vite + Electron（= dev:renderer + dev:electron）
npm run dev:electron     # 只起桌面端（内含 build:electron 与 mark-cjs）
npm run dev:renderer     # 只起前端（Vite）
npm start                # 独立后端：node dist/server.js（用**仓库内** storage/）
npm test / test:hyperframes
npm run check            # 三合一门禁；check:backend / check:renderer / check:secrets 可单跑
npm run build:backend / build:renderer / build:electron   # npm run build = 三者 + mark-cjs
npm run prepare:whisper / check:whisper / prepare:package:mac / check:package-assets
npm run package          # mac 打包（prepare:package:mac + build + check:package-assets + electron-builder）
```

> ⚠️ **改了源码必须编译对应产物再重启**，这里有**两套**独立产物，踩错任一个的表现都是「改了没生效」：

| 改动位置 | 产物 | 编译 | 生效方式 |
| --- | --- | --- | --- |
| `src/`（`app.ts`、`lib/*.ts`） | `dist/` | `build:backend` | 重启后端（含 Electron 内嵌后端） |
| `electron/`（主进程、配置 IPC、`electron/server.ts`） | `dist-electron/` | `build:electron` | 重启 Electron |
| `renderer/` | Vite 内存 | 无需 | HMR 自动热更 |

- **`build:backend` 不产出 `dist-electron/`，反之亦然**；`npm run dev` 的 `dev:electron` 内含 `build:electron`，
  但**直接 `node_modules/.bin/electron .`（或 `electron .`）会绕过它**（此时 `dist-electron/` 仍是旧的）。
- 典型事故（2026-09-17）：给 `electron/server.ts` 加了 `SAU_*` 透传，env 确实进了 Electron 进程，
  但 `dist-electron/server.js` 是旧的 → 无论怎么配都报「未配置」。
- `npm run check`（`--noEmit`）与 `npm test`（tsx 跑源码）**都不产出任何产物**，不能替代编译。

## 分支与提交流程

- **默认分支 `main`，改动直接落 `main`**（2026-10-01 用户指定，此前是先在 `codex/*` 上做、再快进合并）。
  动手前先 `git branch --show-current` 确认在 `main` 上；**不要**自建 `codex/*` 工作分支，除非用户当次明确要求。
- 提交前跑 `npm run check`（含 `check:secrets`）；提交信息沿用既有风格：**单行** + `feat:` / `fix:` / `docs:` 前缀，
  细节写进 `docs/worklog.md`（追加到「最近操作」**最上方**）与 `docs/worklog/YYYY-MM-DD-<主题>.md`，不在提交信息里堆正文。
- 改了 `src/` 或 `electron/`，提交前**确认对应产物已编译**并 grep 得到改动（见上一节的两套产物陷阱）。
- **推送某分支 ≠ 进了 `main`** —— 这是两件独立的事，别把「已推送」当成「已合并」。（2026-10-01 就因此产生过一次误会。）
- 历史分支 `codex/wechat-drafts`（2026-10-01 起与 `main` 同一提交）与 `codex/hyperframes-video`（旧线，已完全并入 `main`）
  **保留未删**，只是历史，不再往它们上面提改动。

## 关键注意事项

### 数据来源与加载
- 视频转录来自音频 ASR，是洗稿**优先输入**；分享文本是参考信息，**没有转录时才作为 fallback**；
  前端必须清晰区分「视频转录」与「分享文本」。
- 内容加载优先 `cleaned`；`script` 是历史接口、不作为新主链路依赖；转录经 `/raw-transcript` 取，
  响应兼容 `transcript` 字符串并扩展 `segments`。

### 视频生成与手动步骤
- 新任务默认 `workflowMode: "manual"`；`JobStore.create()` 只建任务、不自动跑链路；后一步必须等前一步 `succeeded`；
  运行中重复触发 409；每次触发后端**自动最多重试 3 次**，失败即停在当前步骤等人工重试。
  顺序固定：transcribe → clean → generate_video_prompts → generate_video。
- `video-prompts` 是新主链路正式输出，HyperFrames 生成视频必须先完成该步。
- 生成视频是**本地 HTML/CSS/GSAP 动画渲染**（不是 Sora/Remotion/HeyGen），依赖 Node 22+、FFmpeg、
  `npx hyperframes doctor`；流程：`doctor --json` → 生成项目（写 `index.html`/`video-source.json`/`DESIGN.md`）
  → `lint`/`validate`/`inspect`/`render`；产物默认 `output/videos/{jobId}/hyperframes/renders/video.mp4`。
  v1 不做真人/数字人、不自动 TTS；`voiceoverScript` 用作字幕与节奏。

### 重新洗稿（reclean）
- 重新洗稿走独立接口 `POST /api/jobs/:id/reclean`，不经过 `steps/clean`（后者对已 `succeeded` 的步骤返回 409）。
- 传入的 `supplementalText` 会与视频转录合并，重新调用 AI 洗稿；结果持久化到 `processed/cleaned/{id}.json`（顶层含 `supplementalText` 字段）。
- 重新洗稿成功后会把下游 `generate_video_prompts`、`generate_video` 重置为 `pending`，并清空 `videoProjectPath`/`videoOutputPath`/`videoGeneratedAt`，避免展示或复用旧的视频产物。
- 前端入口：工作台始终显示「补充内容重新洗稿」按钮（只要 clean 步骤 `succeeded`），不限于未完成的任务；已生成视频的任务同样可重新洗稿。

### 垃圾桶
- 删除任务是软删除：设置 `deletedAt` 和 `trashExpiresAt`。
- 垃圾桶保留 30 天，启动和查询列表时清理过期任务。
- 永久删除会清理该 jobId 关联产物；处理中任务禁止永久删除。
- 永久删除需要同步清理 `output/videos/{jobId}` 下的 HyperFrames 项目和 MP4。

### 素材库
- 主导航「素材」（`/assets`）：上传/列表/缩略图/试听/删除；**图片可选入图文发布**，音频本轮不接入任何流程。
- **图片进图文包＝两种来源二选一**：`frames`（缺省，该作品的场景静帧，按场景序）或 `library`
  （素材库多选，**按点选顺序**入包）。来源与顺序都进 `previewRevision` ⇒ 换来源/调顺序让旧 revision 失效（409）。
- `library` 经 `AssetStore.resolveFile` 解析成绝对路径后才交给 `createNotePackageAssets`（id→路径的归属校验
  只有这一个真源）；选 0 张报 400、超 35 张报 422；`frames` 一张静帧都没有**不**报错
  （沿用「缺图也把包建出来、只标 `missing_images`」的口径）。
- 安全：**落盘文件名一律服务端生成**（`randomUUID` + 白名单扩展名），客户端名字只作 `originalName` 展示、
  **绝不参与路径拼接**；读取与删除都校验路径落在 `assets/` 内。
- 限额：图片 `jpg/jpeg/png/webp` ≤20MB、音频 `mp3/wav/m4a/aac` ≤50MB、单次 ≤20 个文件
  （违规 415 / 413 / 400）。`GET /api/assets/:id/raw` 支持 Range（音频进度条依赖），与成片流共用 `range-response.ts`。
- 上传是 multipart（`multer` memoryStorage）；⚠️ **busboy 按 latin1 解码 `filename`**，中文名要按
  `decodeMultipartFilename()` 回退转换。图片尺寸与 WAV 时长由纯 Node 解析容器头得到；
  **MP3/M4A 时长为 `undefined`**（界面显示「—」），如需补全可接 `ffprobe`。

### 原视频播放与操作者模型
- 「视频转录」会把原视频下到 `raw/videos/{jobId}.mp4`；详情页成果画布「视频」格子提供**原视频 / 成片**切换
  （默认：有成片看成片，否则看原视频）。没下载时显示「原视频尚未下载」并引导先转录，**不自动下载**。
- `GET /api/jobs/:id/raw-video/stream` 与成片流共用同一份**根目录/inode 安全校验**
  （`video-output.ts` 的 `resolveContainedMp4`）—— `job.videoPath` 是持久化绝对路径，校验各写一份＝开放任意文件读取。
- 面向使用者的登录/切换/用户管理界面**已全部移除**；启动时前端调 `POST /api/local-sessions/auto` 取会话
  （优先复用已有 `isActive` 管理员，按 `createdAt`/`id` 升序确定性选取；不存在才建无 PIN 的「本机用户」；
  不删不改任何历史用户）。**管理员 PIN 的契约没放宽**：普通 `POST /api/local-sessions` 无 PIN 仍 401，
  无 PIN 分支只存在于 `openLocalOperator()` 这一条显式路径上。发布中心的权限与审计（`requireActor`/`actor` 快照）完全保留。

### 字幕图集创作（2026-09-30）

- 独立导航 `/galleries` 与工作台 `/galleries/:id`；原视频区域有快捷入口。已有原视频即可创作，不要求洗稿或 HyperFrames 成片，不改变作品步骤状态。
- 原生字幕只取画面像素；转录分段仅辅助定位。每张 1～6 条字幕，可调时间、字幕区域、主画面取景/占比；本地 FFmpeg 输出 1080×1440 PNG，保持原比例，不重绘文字。多图复制/排序、文案与草稿可恢复。
- `GalleryService`/`GalleryMedia`/`gallery-routes` 由 `app.ts` 共用装配。索引 `cache/galleries.json`，产物 `output/galleries/{id}/{generation}/`；生成串行，失败保留旧图仅供参考，成功替换后清理上一代。原视频使用 `resolveSourceVideo` 校验后从已打开 handle 复制到私有临时快照，FFprobe/FFmpeg 不重新打开原路径；源指纹含 inode/size/mtime/ctime。
- 保存、删除、生成带 `version`；图集发布预览也必须带当前版本。图片 URL 绑定 `generation`，源或图片变化须重生成。`createGalleryNote` 仅接受服务内部已解析路径及有序预期哈希，打包副本与预览不一致就回滚。
- 发布复用 `note × douyin`，确认字幕与使用权后只建自包含包，再到发布中心预览并人工触发 sau。不会自动发布；修改/删除图集不影响已建包。全量回归 1004 通过、1 跳过；未调用真实抖音提交。

### 发布中心的「渠道」页签（一级 = 平台，二级 = 内容类型，2026-09-21 改版）

- **一级 = 平台**（抖音 / 小红书 / 今日头条 / 微信公众号 / 其它平台＝视频号+B站）；
  **二级 = 内容类型**（图文 / 视频 / 文章），**只在「该渠道真的出现了多于一种类型」时才渲染**（只含一项＝假选择）。
  ⚠️ 改版原因（用户反馈）：原版拿**内容类型**做一级，于是「抖音」在一级界面上根本不存在
  （图文与视频被拆进两个页签），而「今日头条文章」这种平台+类型混写的标签又不同构。**别改回内容类型做一级**。
- **纯函数只在 `renderer/src/utils/publishing.ts`**：`PUBLISH_CHANNELS` / `channelTasksOf` /
  `selectChannelPackages` / `channelContentTypes` / `countChannelPackages` / `countChannelContentTypes` /
  `countStatusesInChannel` / `contentTypeAfterChannelChange` / `channelEmptyHint`，
  各有用例。**没有「包属于哪个渠道」这种单值函数** —— 一个包可同时出现在多个页签（同一份图文发抖音+小红书），
  凡涉及渠道一律按**任务平台**判定。
- ⚠️ **计数只数渠道内的任务**：拿整个包的 `tasks` 去数会让小红书的数字漏进抖音页签
  （改版前每包只属一个渠道所以没暴露，现有专门用例守）。
- **状态语义仍然只有服务端一份**：前端只传 `status`，绝不在前端复刻「待处理/资产异常」的判定。
- **渠道维度在前端筛**（服务端 `platform` 是**单值**过滤，表达不了「其它平台」这类多平台页签）：
  列表 = 服务端按 `status` 过滤后的结果，再按「渠道平台集 + 子页签内容类型」筛一遍；
  `contentType` / `platform` 两个查询参数**不再由发布中心下发**（后端字段还在）。
- **计数来自「不带状态筛选」的那次请求**（同时发 `status=all`）：渠道得包数、子页签得各类型包数、
  状态页签得**当前渠道内**完整计数。别改回「在已筛选列表上再数一遍」—— 那会让「失败」在「待处理」里恒为 0。
- 渠道 / 内容类型 / 状态**都写进 URL**（`?channel=` / `?contentType=`）且互不冲掉：合并 query（`setView()`），
  别用 `setParams({status})` 整体替换。换渠道时内容类型**收窄到合法范围**（没有就回「全部」），否则会出现
  一屏空列表却看不出原因。
- 界面约定：**平台下拉已移除**（一级页签本身就是平台）；每个渠道一行说明（谁在提交、什么前置条件，
  **视频与「其它平台」必须写明不会自动上传**）；空态给**可照抄的入口**。微信公众号文章只通过官方 API 保存草稿，视频仍是人工交付。
- ⚠️ **渠道映射必须覆盖每一种可创建的「内容类型 × 平台」组合**：视频向导把 `PUBLISHING_PLATFORMS` **全量**列出
  （含今日头条、微信公众号），所以「头条视频」「公众号视频」这类包真的存在 —— `contentTypes` 漏一个，
  它们就在**所有**页签里都看不见（静默丢数据）。用例 `每一种可创建的「内容类型 × 平台」组合都唯一落在某个渠道里`；
  `node --import tsx scripts/verify-publishing-channels.ts` 用**真实索引**复核（只读零副作用，末尾报有无包不属于任何页签）。
- 规格与计划：`docs/superpowers/specs/2026-09-18-publishing-channel-tabs-design.md`（含 2026-09-21 改版一节）、
  `docs/superpowers/plans/2026-09-18-publishing-channel-tabs.md`。

### 微信公众号文章草稿（2026-09-29）

- 仅 `article × wechat_mp`：封面永久素材 → 可选正文图 → 微信兼容 HTML → `draft/add`。不调用正式发布/群发，不使用浏览器代点发布。
- 复用 `CreateToutiaoArticleDialog`（`platform="wechat_mp"`）、发布包与预览流程。封面单选；`articleImageAssetIds` 为独立的有序正文图片列表，选图归属沿用 AssetStore；作者/摘要与图片顺序进入对应预览指纹。
- 设置「微信公众号」保存 AppID/AppSecret/默认作者；AppSecret 用 safeStorage 加密，不回显。加密/解密失败拒绝保存，避免明文或覆盖丢失。配置即时读取，token 仅本次操作缓存；独立入口使用 `WECHAT_MP_APP_ID` / `WECHAT_MP_APP_SECRET` / `WECHAT_MP_AUTHOR`。
- `POST /api/publishing/wechat/verify`：普通稳定 token + draft/count，只证明连接/查询；不上传内容，但可能触发管理员风险确认。个人未认证订阅号不能仅凭查询成功宣称可写，认证也不保证解决权限问题。
- `task.status` 不变；成功子记录保存 `draftOnly: true` 与 `draftMediaId`，绝不等同正式发布。草稿请求网络失败/异常响应保留 `outcomeUncertain`；成功、不确定或遗留 running 都禁止直接重发。核对后台后确需另建时人工创建新包。
- 当前已通过模拟链路测试，真实账号仍未验收。实测必须覆盖封面+一张正文图，并由用户在后台确认。见 `docs/research/2026-09-29-wechat-draft-feasibility.md` 第 7 节。

### 凭据扫描（提交前门禁）

- `npm run check` **包含 `check:secrets`**：扫被跟踪与未忽略的新文件，命中「像真凭据」的串就非零退出。
  逻辑在 `src/lib/secret-scan.ts`（13 条用例），CLI 是薄封装 `scripts/check-secrets.ts`。
- 为什么有它：2026-09-20 一条「`wx` + 16 位十六进制」的**占位值**触发了 GitHub secret scanning 误报。
  误报的代价不只是吓一跳 —— 它会训练人忽略这类告警，所以判断挪到本地提交前。
- **两条口径**：① 「GitHub 也会报」的形态（微信 AppID / `sk-` / `ghp_` / `AKIA` / `AIza` / `xox` / JWT /
  私有密钥头）**不看假值白名单**（否则就是「本地放行、GitHub 照报」；想通过就把假值改成可读串）；② 我们自己加的形态（抖音 cookie、
  `Bearer`）**要看**白名单与「值像不像真凭据」。
- **测试假值一律一眼可辨**：`test-app-id` / `fake-secret` / `example-token` / `<APP_ID>` / `{{token}}`；
  **别用看起来像真的随机串**。⚠️ **注释里也不要写那个字面量**（扫描看内容，注释照样命中）；
  用例里要构造就用 `join`/拼接。
- 确需保留形态时在该行写 `secret-scan:allow` 并说明原因（**优先改名**）。命中真凭据的正确顺序是
  **先撤销/轮换、再改代码**（只删字符串没用，历史里还在）。上报一律**打码**（`wxa1…0718`）。

### 侧栏可折叠
- 桌面端左侧主导航可展开/收起，收起为纯图标、展开显示导航文字；选择存 localStorage（`douyin-ai-video.rail-expanded`）。
- 侧栏宽度只有一个真源：`AppShell` 根节点声明的 CSS 变量 `--rail-w`（收起 `md:56px` / `xl:64px`，展开 `208px`），由侧栏、内容区与两个顶栏变体共同消费 —— **不要在别处再写死 56px/64px 偏移**。
- 折叠开关固定在侧栏**底部**且两个状态都可见。早期版本把它做成「整个 logo 行」，导致收起态与改造前毫无差别、用户找不到入口（已按实测反馈修正）。

### 抖音图文自动发布（外部 sau 引擎）

- 只做**抖音图文**（`sau douyin upload-note`）；视频与其它平台仍是人工交付。
- 引擎是外部依赖、**不内置**（自装 `social-auto-upload`，约 970MB）。三个实测坑：① 按其官方步骤装完 CLI 起不来
  （`pyproject.toml` 只声明 `patchright`，但仍有 7 个 uploader 与 `myUtils` 在 `import playwright`，需手动
  `uv pip install playwright`）；② `requires-python = ">=3.10,<3.13"`（3.13 要另装 3.12）；
  ③ 仓库+venv 约 440MB、patchright chromium 约 520MB。另：上游 `uploader/__init__.py` 在 **import 阶段**就
  `mkdir <BASE_DIR>/cookies`，所以该目录必须可写。
- **`task.status` 全程不变**：`autoPublish` 只是任务上的子记录，`succeeded` 的语义是**已提交**，绝不写 `published`
  —— 是否真发出去由人工点「标记已发布」确认。**这是本功能最关键的不变式。**
- **一次只允许一个**：运行中/等验证码时再触发 409；遗留 `running` 超过 30 分钟视为「进程已死」允许重试。
- **不自动重试**：失败后必须人工再点（人知道上一次到底发出去没有）。
- **「发布前必经预览」是服务端约束**：`auto-publish` 必须带 `previewRevision`（图文包覆盖有序 `imagePaths` 与
  `noteCopy`），缺失 400、不一致 409，两种情况都**不产生** `autoPublish` 记录。
- 图文包的 `video*` 字段「不适用」，其中 `videoSha256` 承载**图片清单哈希**（各图 sha256 有序拼接再哈希）作为
  等价完整性凭据；`PublishAssetHealth` 的 `missing_images` 由它判定。
- ⚠️ **验证码通路对图文不通**（从上游源码实测更正）：`verify_code.txt` 只有上游**视频**通路会读；`upload-note`
  既不读它、发布循环也没有次数上限 ⇒ 图文遇到短信挑战的真实结局是「循环到超时（900s）→ `failed`」，
  `awaiting_code` 在图文通路**不可达**，写验证码文件**没有效果**。界面必须让操作者知道：卡住的正确动作是
  **去抖音后台核实**，且重试前先确认上一次是否已发出（上游会 `force=True` 重复点击发布，**重复发布是最大风险**）。
- **我们对上游打了 1 个本地补丁**（见 `docs/patches/`）：抖音把图文发布页标题框 placeholder 从「填写作品标题」
  改成「添加作品标题」，上游仍按旧文案匹配 → 图文发布稳定 120s 超时；补丁只把匹配放宽成 `作品标题`。
  ⚠️ **上游 `git pull` 会覆盖它，升级后必须重新 `git apply`。**
- 媒体元素（`<img>`/`<video>`）**不能用相对 URL、也不能带自定义请求头**：页面在 Vite(5173)、API 在另一端口，
  相对路径会打到 Vite 的开发代理。图片走 `apiClient` 取 blob，视频走 `apiClient.getJobVideoStreamUrl()` 的**绝对 URL**（与 `getAssetRawUrl` 同一套做法）。

### 小红书图文自动发布（自研 Playwright 执行器，2026-09-21）

- **平台** `xiaohongshu`（原为人工交付平台），**只做图文笔记**。
- ⚠️ **这是三条通路里风险最高的一条**：平台 2026-03-10 公告**点名**「通过 AI 托管工具…发布」与
  「主页所有公开笔记均为 AI 托管代发」→ **封禁**（2026-07 通报处置 42 万账号、约 13 万「AI 托管发布」账号），
  用户实证有「**代发 1 篇当晚永封**」「2 天即封」「仅自己可见也封」。证据见
  `docs/research/xhs-publish-projects-assessment.md`。**产品文案不许承诺安全**，必须写明「风险由你的账号承担」。
- **默认姿态：只填到草稿**（`xhsOptions.submit: false`）：执行器填好标题/正文/AI 声明后**停在点发布之前**，
  平台会**自动存草稿**（真机实测：填完创作中心出现「草稿箱中有未发布的作品」），由真人点最后一下。
  要真提交必须在**建包时**打开开关（它进 `previewRevision`，绕过预览就 409）。
- ⚠️ **两条刻意偏离头条范式的不变式**（代码注释与用例里都有，别当成漏做）：
  ① **点完「发布」后不做任何读回**（不抓 URL、不轮询成功文案）—— 依据 `xiaohongshu-mcp` #715
  「让 ai 确认一下发布成功了没有 → 第一次警告第二次七天」⇒ 记录里 `verification === "unconfirmed"` **恒成立**（按设计不做读回）；
  ② **不做任何读取/采集/互动，也不做定时/cron** —— 只读同样出事（搜索、采集、取消收藏都被报过封号），**cron 被平台公告点名**。
- **AI 标识是合规红线**：`xhsOptions.aiDeclaration !== true` → **422 且不产生记录**（点任何页面前就拒）；
  页面上选不中「**笔记含AI合成内容**」也 **fail closed**（未标识会被平台限制分发）。
- **三条闸门**：**频率** 本地自然日 ≤ `XHS_DAILY_PUBLISH_LIMIT`（1 次，**含只填草稿**）；**图片** ≤18 张
  （打包层允许 35 ⇒ **预览与提交两处都要按平台拦**，选小红书时预览下发的 `imageLimit` 就是 18）；**并发互斥**沿用 409 + 30 分钟僵死阈值。
- **`task.status` 全程不变**：`succeeded` 只表示**已提交**，由人工核实后点「标记已发布」。
- ⚠️ **页面是分阶段渲染的**：**先上传图片，标题/正文/声明/提交才在 DOM 里**；未上传阶段查到 0 命中
  **不是「页面改版」，是顺序错了**（据此误判过一次参考项目的选择器全过期）。
- ⚠️ **提交控件不能用选择器**：它是 `<xhs-publish-btn>` 自定义元素 + **closed shadow root**
  （`customElements.get()` 有定义，但 `shadowRoot === null` 且无子节点）。实测 `getByRole('button', {name:'发布'})` / `xhs-publish-btn >> text=发布` /
  `xhs-publish-btn button` **全为 0** ⇒ 只能**按宿主包围盒 + 相对偏移坐标点击**（宿主 680×90，
  「发布」≈(0.607, 0.5)、「暂存离开」≈(0.396, 0.5)）。**失败模式良性**（落到「暂存离开」＝存草稿，不会误发）。
  有一条用例专门断言「选择器定位必然失败」，**别顺手改回选择器**。
- **登录**：登录页**默认「短信登录」、页面上没有二维码**，须先点右上角切换图标（实测 `img.css-wemwzq`，
  它自己也是 128×128 的 `data:` 图 ⇒ 按**面积门槛** `XHS_QR_MIN_AREA` 挑真码）；二维码**静默轮换**
  （以内容为准，别只匹配「已失效」文案）；判据 **「已离开登录页 ∧ 无阻断信号」**，**不要求发布页 DOM 出现**
  （扫码后落到 `/new/home`，那里发布页选择器全为 0）。**已登录时不要再去取码**（会被重定向走、没有二维码）：
  返回 `409 xhs_already_logged_in` 并写明换号动作 —— 早期版本把这种「你不需要扫码」误诊成「页面改版」。
- **只读侦察脚本** `node --import tsx scripts/probe-xhs-publish-page.ts`：`--login` / `--tab` /
  `--upload-dummy`（**会上传一张现场生成的纯灰假图**）/ `--form` / `--dry-run`（填假文案并勾声明、**绝不点发布**）/
  `--scroll-submit` / `--shadow` / `--shot-submit` / `--frames` / `--diagnostics` / `--check-drafts`；
  **收尾如实列出本次做过的有副作用操作**。
- **界面入口**：设置页「**小红书**」扫码登录（与抖音/头条共用同一份 `QrLoginPanel`）；作品详情页成果画布
  「创建图文包」（与「加入发布中心」并列，组件 `CreateNotePackageDialog`，与视频向导相互独立）；
  发布中心「小红书」页签的「填写到小红书（不提交）」与「发布到小红书」（**后者只在包声明 `submit: true` 时出现**）。
- **推荐作业流程（用户 2026-09-21 拍板「就按这套」）**：建包时**保持「创建后由程序点发布」关闭** →
  点「填写到小红书（不提交）」→ 机器填好标题/正文/图片/AI 声明后**停手**（记录 `draftOnly: true`，
  界面说「已填写到草稿箱」而不是「已提交」）→ 点「**打开小红书创作中心**」→ 在草稿箱核对并**自己点发布**。
  ⚠️ 图文任务那个按钮开的是创作中心**首页**（草稿箱所在页，`XHS_CREATOR_HOME_URL`），**不是**平台表里的
  `publish/publish`（那是「发布**新**笔记」页，打开会让人以为要重发一条；`publishingOpenPlatformTarget` 有用例守）。
  要机器点发布是**另一条**路：建包时就打开开关（进 `previewRevision`，建完改不了）。
- ⚠️ **图文包的文案真源是包级 `noteCopy`，不是任务文案**（两条图文通路都 `noteCopy ?? task.*`）：
  ① **图文任务不提供「编辑文案」**（2026-09-21 补：原先只隐藏了文章包的，图文那个是**假按钮** ——
  界面会变、发出去的仍是旧包文案；视频任务保留，人工交付复制的就是任务文案）；
  ② 建包预览的默认文案必须是**所选平台**的生成稿 —— 曾固定取 `copies.douyin`，而 `previewAll` 只为所选平台
  生成文案，于是**只选小红书时正文与话题静默为空**（用户实测「正文 (空) / 话题 (无)」）。用例：
  `图文预览：只选小红书时正文与话题不能是空的`、`图文任务不给「编辑文案」`。
  ⇒ 想改图文包文案**只能重建包**，改任务文案对发布无效。
- ⚠️ **登录态判据的残留风险（已知，未修）**：`checkLogin()` 的判据是「URL 不是登录页 ∧ 无阻断信号」，而登录页默认短信登录、
  切换图标**没有文字** ⇒ 短信登录态下「阻断信号」可能一个都不命中。若 `goto(首页)` 后重定向到 `/login`
  慢于 3 秒，第一轮可能**假阳性**判成「已登录」。2026-09-21 双向实测都正确，但这是「**缺席证明**」；
  要彻底收紧得有**正向**判据（登录后才存在的 DOM），目前没做。⚠️ 另有一条未解：只读探针用 App 的 profile
  跑 `--check-drafts` 落在登录页，而应用内「校验登录」说已登录（**以应用内为准**，待复查）。
- **规格与计划**：`docs/superpowers/specs/2026-09-20-xiaohongshu-note-publish-design.md`、
  `docs/superpowers/plans/2026-09-20-xiaohongshu-note-publish.md`。

### 今日头条文章发布（自研 Playwright 执行器）

- **平台** `toutiao`，**只做文章**（视频/微头条/数据/评论都不做）。**引擎自研**：复用打包的 `chrome-headless-shell`，
  零新依赖、**零额外下载**（实测 `playwright.launch({ executablePath })` 能打开真实登录页）；参考项目 `mf-yang/toutiao-ops` **只借流程、选择器不照抄**（见 `docs/research/toutiao-ops-assessment.md` §3）。
- **登录只能扫码**（登录态是浏览器 profile），两条路**写同一个 profile** `storage/toutiao/profile`：
  ① **打开浏览器窗口扫码**（`POST /publishing/toutiao/login/window`，用**有头**浏览器）——
     ⚠️ 打包的 `chrome-headless-shell` **是无头专用构建、开不了窗口**，所以这条链单独解析（系统 Chrome / `npx playwright install chromium`）；
  ② **应用内扫码**（无头，从登录页 DOM 取 `data:image/png;base64,…` 二维码，轮询状态；约 10 分钟过期，
     服务端不许两个会话并存，**要先取消再重新获取**）。
- **每一步都读回校验**：标题读回 `value`、正文读回编辑器纯文本、封面读回真的出现图、微头条读回勾选态。
  **任何一步失败都停在点「发布」之前**并写明已完成到哪一步（参考项目正是在这里静默失败）。
- ⚠️ **不需要勾的选项也要「真的去取消」，不能只检查**：持久化 profile 会把上次草稿的勾选带回来，
  于是「本次不勾头条首发」时页面**已经是勾的**。正确姿势（照 `ensureWeitoutiaoUnchecked`）：
  **已是目标状态就不点 → 不是就点一下 → 读回确认 → 改不掉才 fail closed**（`toutiao_page_first_publish_uncheck_failed`）。
  理由：**绝不能带着用户没选的声明发出去**。
- **「同时发布微头条」默认关闭且 fail closed**：头条页上这一项**默认是勾选的**，关不掉就**不发布**。
- **`task.status` 全程不变**：点了「发布」也只记 `succeeded`（**已提交**），绝不写 `published`；
  由人工在头条后台核实后点「标记已发布」。（抖音/小红书同一条不变式，不再重复。）
- **结果独立校验** `verification: "confirmed" | "unconfirmed"`：拿不到判据时 message 必须写明
  「已点击发布，但未能从页面确认结果」并要求先核实 —— **重复发布是本功能最大的风险**。
- **文章包**：`article` 内容类型（与公众号同形），包内 `article.html` + `cover.jpg`；
  `articleCopy.htmlSha256` 是正文完整性凭据，`toutiaoOptions`（首发/声明/微头条）**参与 `previewRevision`**；
  提交前服务层比对包内 HTML 的 sha256，不一致直接拒。⚠️ `contentType: "article"` **必须在路由白名单里**。
- **正文以纯文本往返**：小标题用 `## `（`articleDraftToBodyText` / `articleBodyToDraft` 无损）；
  **展示用**文本走 `articleHtmlToBodyText()`，**粘编辑器/读回**走 `htmlToPlainText()` —— 编辑器里小标题是真标题、
  没有 `## ` 记号，**两者不能互换**。渲染后断言正文长度并从第几段起报超限。
- ⚠️ **包级预览的文案检查必须走「平台政策」**：`copyCheck()` 第 5 个参数 `copyPolicy: "platform" | "note"`（`PUBLISH_NOTE_POLICIES` 里只有抖音/小红书），
  文章包与视频包走 `"platform"`，只有图文包走 `"note"`。文章包误传 `"note"` 的后果**不是口径松**而是
  **整条通路不可达**：`validateNoteCopy("toutiao")` 抛错 → `GET /publishing/packages/:id/preview` **500** →
  而 `previewRevision` **只能由这个接口产出** → 「提交到头条号」永远点不出结果。
  头条的平台政策 `PUBLISH_PLATFORMS.toutiao` 本身就是文章口径（titleMax 30 / 正文 20000），别再加第三份政策。
  ⇒ **凡是有 `previewRevision` 约束的通路，用例必须真的打一次预览接口**（当时文章用例直接读 store 里的 revision，把接口绕过去了）。
- **封面必填**：服务端裁成 **16:9（1280×720）**（静帧是 9:16，直接传会被平台乱裁）。真页流程（实测）：点 `.article-cover-add`（**不能带 `force`**，
  加号常在折叠线以下，force 会让点击落到别处、抽屉不开）→ 抽屉 `byte-drawer … mp-ic-img-drawer`
  （**里面有两个 `input[type=file]`**，裸选择器会因严格模式多匹配报错，必须限定在抽屉内取第一个）→
  点「本地上传」（优先 `filechooser`）→ **读回封面出现图** → **关掉抽屉**（不收起来会挡住发布按钮）。
- **发布前演练**：`node --import tsx scripts/probe-toutiao-publish-page.ts --dry-run` 在**真实页面**上把每一步做完、
  **绝不点发布**，唯一副作用是平台自动存草稿。上面两个封面坑就是它抓出来的（fixture 用例当时全绿）。
- **文章任务不提供「编辑文案」**（正文是包级 `article.html` 的渲染结果，改了会漂移）——要改就重建包；
  降级通路是「下载文章 HTML」（零依赖、随时可用）。
- **选择器已按真实页面校准**（2026-09-18 只读侦察，产物 `storage/toutiao/recon/`）：标题
  `textarea[placeholder*="标题"]`（placeholder 原文「请输入文章标题（2～30个字）」）、正文 **`.ProseMirror`**（富文本粘贴有效）、「头条首发」默认**未**勾，
  而「发布得更多收益」那只 `LABEL.byte-checkbox` 默认**带 `byte-checkbox-checked`**（= 微头条默认勾选）。
  离线 fixture `src/lib/fixtures/toutiao-publish-page.html` 从快照逐段抠出，页面步骤与发布编排用**真浏览器**跑它（18 项：含两种封面形态、确认 / 无确认两种确认页形态）。
- ⚠️ **两个坑**：① **页面侧代码必须用字符串下发** —— tsx/esbuild 会给内联函数包 `__name(...)` 助手，
  而 Playwright 是把**函数源码**丢进页面执行 → 页面里没有 `__name`，`ReferenceError`（`dist/` 由 tsc 编译不受影响，
  所以**只在 tsx 下**出现）；② **点复选框不能按「第一个文案命中」** —— `div.exclusive-checkbox-wraper` 的文本也是
  「头条首发」且在文档序里更靠前，点它状态丝毫不变。`clickCheckboxByText()` **优先点拥有 checkbox 的 LABEL**，
  勾完还要**读回确认**。
- **「确认发布」必须读回**：只点「预览并发布」而没点到确认按钮 = 什么都没发出去。`submitAndConfirm` 返回
  `confirmClicked`，为 false 时**返回 `ok:false` 并明说「没有找到确认按钮、本次未提交任何内容」**；
  带确认按钮 / 不带确认按钮两种形态各有一条真浏览器用例（候选文案来自 `TOUTIAO_SELECTORS.confirmButtons`，随时可能变；「有没有点到」始终由**读回**决定）。
- **每一步读回都比「内容」而不是比「有没有」**：标题**先清空再输入**并断言读回等于目标（持久化 profile 会预填上次草稿，
  直接 type 会拼成「旧标题+新标题」）；正文要能找到**首段与末段**；封面要读回出现图；勾选框只看
  **拥有 checkbox 的元素**（说明性文案如 `div.edit-label` 不算命中，否则会得出「已是未勾选」而**带着平台默认的勾选发出去**）。
- ⚠️ **清空输入框只能按一个「全选」键**（`clearInput()`）：macOS 上 `Cmd+A` 是全选、而 `Ctrl+A` 是 Emacs 的「移到行首」，
  会把选区**塌缩掉** → 后续 Backspace 什么也删不掉，「先清空」形同虚设。做法：按 `process.platform` 选**一个**键 +
  **读回确认（三轮）** + 原生 setter/`input` 事件兜底。**别再加第二个全选键**（真机三步确证：`Meta+A`→`Backspace` 读回空串；`Meta+A`→`Control+A`→`Backspace` 读回原文；选中后 `insertText` 是**替换**选区）。
- ⚠️ **登录态判定要「重试后才作数」**（`LOGIN_CHECK_ATTEMPTS = 2`）：只读一次 URL 会因首页跳转未落地而**假阴性**，
  代价是用户跑去重扫一个其实好好的码。重试只是给页面落地机会、**不放松判定**（两次都在登录页才算没登录）。
- ⚠️ **标题写入是概率性丢字符的**（`fillTitle()`）：按可靠性排阶梯 —— **整体 `keyboard.insertText` → 再来一次 → 逐字兜底**，
  每次写完**等 250ms 再读回**（受控输入稍后才把模型值写回 `.value`）；不符时报错必须带**字符级差异**
  （`第 N 个字符起不同/少了/多了`），只报字数没法排查。
- **退出清理**：装配时 `ToutiaoRunner.installExitCleanup()`（`exit`/`SIGINT`/`SIGTERM` 尽力关掉登录会话的浏览器）。
- **浏览器解析链会真的探测**（不是无条件乐观），探测不到就继续往下并给出可照抄的指引 ——
  否则真正的失败会拖到 `launch()` 那一刻变成 500、记录卡在 `running` 直到 30 分钟僵死阈值。
  发布流程里的**任何**异常都收敛成 `ok:false`，保证记录一定落到 `failed`。
- ⚠️ **头条这一族错误必须在路由层错误边界里登记**：`ToutiaoRunnerError` / `ToutiaoBrowserError` /
  `ToutiaoPageError` / `ToutiaoArticleError` / `ToutiaoMediaError`（各自带 `status` + `code`）。**原先只认 `Publishing*Error` / `SauRunnerError` / `VideoOutputError`**，
  所以新增头条错误类**必须一起登记到 `publishing-routes.ts` 的错误边界**，并给兜底分支加 `console.error`。
  漏登记的表现不是「状态码不准」，而是**指引整条丢掉**（全落进兜底 500「发布服务暂时不可用」，连日志都没有）。
  用例 `toutiao runner errors surface with their own status, code and guidance`。
- ⚠️ **启动失败要带原因 + 带动作，会话目录自己建**：`openToutiaoSession()` 把 `launch()` 的**任意**异常包成
  `ToutiaoRunnerError("toutiao_browser_unavailable", "头条浏览器启动失败：<原因>。可照抄的动作：…")`；
  `defaultLaunch()` 自己 `mkdir(profileDir)`，失败报 `toutiao_profile_dir_unsafe` 并写出**哪个目录、什么原因**
  （交给 Playwright 建目录只会得到一句 `launchPersistentContext: EPERM … mkdir`，看不出是权限还是浏览器问题）。
- ⚠️ **发布路径上「任何异常都要落成 `failed` 记录」**：`publishArticle()` 第一行 `openSession()` 在自己的 `try` **之外**，
  浏览器起不来会直接抛到服务层 → 500 + `running` 卡死。现在服务层把所有异常都落成 `failed`
  （非执行器错误带「头条发布过程中出现意外错误：<原因>」）。用例：`toutiao publish: a launch failure is recorded as failed…`
  与 `…even an unexpected raw error…`。
- ✅ **真实站点端到端已跑通一次**（2026-09-20，用户确认已发到头条）：候选确认文案命中，但页面上没有我们认识的
  `successTexts` → 如实记 `succeeded` + `verification: "unconfirmed"` + 要求先核实，用户核实后才点「标记已发布」。
  **「机器只记已提交、是否真发出由人工核实」这条不变式在真机上走过一遍。**
- ⚠️ **成功提示的真实文案仍未拿到**（所以「点到了但读不到判据」仍是常态）：`submitAndConfirm()` **每次都带回
  `postConfirm` 证据**（确认后的 URL、是否已离开发布页、页面可见文案的**头+尾**摘要）并写进 `autoPublish.message`，
  下次真机跑一把即可校准 `successTexts`。**注意** `leftPublishPage` 只是**旁证**（会话失效也会跳登录页），
  **绝不能**拿它冒充 `confirmed`。
- ⚠️ **服务层不要再给 runner 的文案加前缀**：未确认时 runner 的文案本身就以「已点击发布，但未能从页面确认结果…」
  开头，早先又拼了「已提交，但」→ 真机记录成了「已提交，但已点击发布，但…」。现在未确认时**原样记**。
- **界面入口**：作品详情页成果画布「创建头条文章包」（`CreateToutiaoArticleDialog`，与「创建图文包」并列）；
  发布中心任务行的「提交到头条号」（必经预览）与「下载文章 HTML」；设置页「今日头条」扫码登录。

### 导航拦截与弹窗（不许把界面锁死，2026-10-01）

- **任何 `useBlocker` / 弹窗都必须有一个「一定能出去的出口」**。2026-10-01 用户报「在文章创作页无法切换到其他页面」，
  实际是三处缺出口，症状完全一致：**页面看上去正常、没有任何提示，但点导航毫无反应**。
  ① 对标页 `dirty` 把**折叠起来的**「新建对标组」表单也算未保存编辑（输入已进 sessionStorage、展开即恢复），
  于是页面上看不到任何待保存内容却拦下所有导航；② 它的解除按钮只在**页面顶部的普通文档流横幅**里，滚下去就看不见
  —— 其它页面（文章详情/素材/热点/图集）都用 `window.confirm`，**只有它用页内横幅**；
  ③ `ArticleDetailPage` blocked 时 `if (busy) return;` 把 blocker **永远挂在 blocked**（全仓库唯一），
  `CreateToutiaoArticleDialog` 忙时 `close()` 直接 return —— 而 `Modal` 打开时会给 `#root` 设 **`inert`**（整个应用不可点），
  Esc / 点遮罩 / 右上角 X 在忙时又都被 `Modal` 自己封死 ⇒ 请求一挂住（`api.ts` 默认超时 **16 分钟**）就是既关不掉也点不动的死胡同。
- **判定只有一份**：`renderer/src/utils/navigationGuards.ts` 的 `benchmarkDirty` / `blockedNavigationAction` /
  `articleDialogCloseDecision`，各有用例（`navigationGuards.test.ts`）守「永不留死路」这条不变式。改拦截行为改这里。
- ⚠️ **纯函数不要 export 在组件文件里**：Vite 会报 `Could not Fast Refresh (... export is incompatible)`，
  这两个页面的热更会退化成整页刷新。放 `utils/` 既是仓库既有约定（如 `utils/publishing.ts`），也保住 Fast Refresh。
- **拦截提示必须能强制看见**：要么 `window.confirm`，要么 `sticky top-14 z-40`（顶栏是 `fixed top-0 h-14 z-30`）。
  **不要**只在文档流里放一条横幅 —— 用户滚在下方时它等于不存在。
- **新增弹窗时先问「忙的时候怎么关」**：`Modal` 一打开 `#root` 就 `inert`，**只要有一个关不掉的弹窗，整个应用就完全不可交互**。
  `onClose` 必须任何状态下都能被调用（需要拦就用 `window.confirm` 确认，**不要无条件 `return`**）。

## 故障排查

### 转录功能不工作
1. 确认打包前已运行 `npm run prepare:whisper`。
2. 开发模式检查 `vendor/whisper/whisper-cli` 和 `vendor/whisper/models/ggml-small.bin`。
3. 生产模式检查安装包资源目录 `resources/whisper`。
4. 查看 `raw/transcripts/` 是否生成 JSON。
5. 查看任务详情页转录步骤错误和后端日志。

### 视频下载失败
1. 确认 `yt-dlp` 二进制存在。
2. 检查网络连接和代理设置。
3. 验证抖音链接格式。
4. 必要时配置 cookies 或浏览器登录态。

### 视频生成失败
1. 确认 Node.js 版本 >= 22：`node -v`。
2. 确认 FFmpeg 可用：`ffmpeg -version`。
3. 确认 HyperFrames 环境可用：`npx hyperframes doctor`。
4. 查看任务详情页“生成视频”步骤错误和后端日志。

### 抖音图文自动发布不工作
1. **配了 `SAU_BINARY` / `SAU_BASE_DIR` 却仍报「未配置」** → 先查主进程产物是不是旧的：
   `grep -c SAU_BINARY dist-electron/server.js`（应为 ≥1，为 0 就跑 `npm run build:electron` 再重启）。
   找内嵌后端端口：`lsof -nP -iTCP -sTCP:LISTEN | grep -i electron`；确认 env 真进了进程：
   `ps -Eww -p <PID> | grep -o "SAU_[A-Z_]*=[^ ]*"`（**要用 `grep -o`**：`ps -Eww` 的环境段不一定在行首）。
2. 报「未配置 sau 可执行文件」→ 装好引擎、设置两个 env，**然后重启后端**（env 只在启动时读）。
3. 预检 `invalid` → 登录态失效，重新扫码（`~/.douyin-ai-video/douyin-cookie.txt` 是唯一真源）。
4. 点「发布图文到抖音」先弹预览是**预期行为**；提交后长时间无变化是常态（上游循环无次数上限）——
   超时落 `failed` 时**先去抖音后台核实**再决定是否重试。

### 今日头条文章发布不工作
1. 报「未找到可用于头条号发布的浏览器」→ `npm run prepare:package:mac` 或 `npx playwright install chromium`，
   也可用 `TOUTIAO_BROWSER_BINARY` 指定路径，**然后重启后端**。
2. 发布页被重定向回登录页 → 登录态失效：到「设置 → 今日头条」点「打开浏览器扫码登录」（或「扫码登录」），用**今日头条 App** 扫码；也可直接跑 `node --import tsx scripts/probe-toutiao-publish-page.ts --login`。
3. 「打开浏览器扫码登录」报没有可用浏览器 → 打包的 headless shell **开不了窗口**：装 Chrome、或
   `npx playwright install chromium`、或改用「应用内扫码」。
4. 报「找不到标题输入框/正文编辑器/封面上传入口/微头条勾选框」→ **页面已改版**：先跑只读侦察脚本
   `node --import tsx scripts/probe-toutiao-publish-page.ts`（登录→进发布页→落 DOM 快照，**不填表不点发布**），
   按证据改 `toutiao-page.ts` 的选择器，**不要盲目重试**。
5. 提示「已点击发布，但未能从页面确认结果」→ **先去头条后台「内容管理」核实是否已发出**再决定重试（重复发布是最大风险）。
6. 取消勾选「同时发布微头条」失败时**不会发布**：刻意 fail closed，避免不知情时多发一条。
7. 点「提交到头条号」后界面只说「发布服务暂时不可用」→ 先看 `GET /api/publishing/packages/:id/preview` 是否 **500**
   （`previewRevision` 只能由它产出）→ 见上方「包级预览必须走平台政策」；**改完 `npm run build:backend` 再重启**。
8. 设置页点「扫码登录/校验登录」也报「发布服务暂时不可用」→ 兜底 500，说明异常**没被错误边界认出来**
   （头条错误类漏登记）。现在后端会打印 `[publishing] 未预期的错误: …`，**直接看输出拿真原因**；若形如
   `EPERM: operation not permitted, mkdir '<storage>/toutiao'` 就是**会话目录不可写**（storage 需存在且当前用户可写，或用
   `TOUTIAO_PROFILE_DIR` 指到 storage 内别的可写目录后重启）。
9. 「标题框读回与要发的标题不一致」→ 这条是**我们自己拦下的**（没提交任何内容）。差空格/一两字多为受控输入竞态，
   现已换写法重试并延后读回；再报错请把「第 N 个字符起…」一起发出来。差得多（读回「旧标题+新标题」）说明
   **清空没生效** → 见上方「清空只能按一个全选键」。

### 小红书图文自动发布不工作
1. 点「扫码登录」报「当前已经是登录状态（昵称），无需再扫码」→ **正常**：账号已登录，登录页会被重定向走、
   没有二维码。要换号先在小红书里退出登录。
2. 报「没能从登录页取到二维码」→ 先确认**没在已登录状态**；仍是未登录态就是页面改版，跑只读侦察核对选择器
   与「切换扫码模式」入口。
3. 报「没找到标题框/正文编辑器/声明下拉」→ **先问「图片上传了吗」**：页面分阶段渲染，未上传时它们不在 DOM 里。
4. 报「找不到提交控件」→ 它**只在上传图片之后出现**，且是 closed shadow root，**没有可用选择器**（见上方 ⚠️）。
5. 「找不到内容类型声明控件」/「声明没选上」→ 设计上 **fail closed**（拒绝发布）。跑侦察看下拉选项文案是否变了
   （实测是「笔记含AI合成内容」）。
6. 「今天已经用过一次小红书自动通路（…只填到草稿也算）」→ 频率闸门（本地自然日 1 次），**刻意拦的**，不是 bug；
   想发就去 App/创作服务平台的草稿箱手动发。
7. 提交返回 422「超过 18 张」→ 小红书图文上限 18（打包层允许 35）：重建包并减少图片。
8. 提示「已填写到草稿箱/已点击发布但没做读回」→ **去小红书 App 核实**再决定重试（重复发布是最大风险）。
9. 报「会话目录不可写（`EPERM: operation not permitted, mkdir '<storage>/xhs'`）」→ 先分清**谁的沙箱**：若 storage 属主是你、权限 755，
   而**连建 `toutiao-*` 这类无关目录也被拒**，那就是**启动 Electron 的那个沙箱**（不是 App、不是代码）—— 从自己的终端启动或放宽权限。
   实测：同一个沙箱下 `[::1]` 内的写入被拒，放宽后 `xhs/profile` 正常创建、登录自检返回「已登录」。
10. **改 `src/` 没生效** → `npm run build:backend` 后**重启后端**（改 `electron/` 还要 `build:electron`）；
    ⚠️ 重启前**确认端口真的释放**（`lsof -nP -iTCP:<port> -sTCP:LISTEN`）—— 旧进程没死时新进程 `EADDRINUSE` 退出，
    而请求仍由**跑着旧代码**的进程应答，表现就是「修复没生效」。

### 前端无法连接后端
1. Electron 内嵌后端使用随机本地端口，前端通过 `window.electron.getServerPort()` 获取。
2. 开发模式下确认 `npm run dev` 正在运行。
3. 检查防火墙设置。

---

**最后更新**: 2026-10-01
**维护者**: Codex
**仓库**: https://github.com/LiChangZheng10086/doyin_ai_video.git
