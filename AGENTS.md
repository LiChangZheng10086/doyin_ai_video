# 抖创工坊

基于 Electron + React 的桌面应用，用于抖音视频采集、转录、AI 洗稿、Skills 蒸馏、本地竖屏视频生成与多平台发布（发布中心按渠道分栏：抖音图文与今日头条文章可由本机浏览器自动提交，其余人工交付）。当前视频生成通过 HyperFrames CLI 本地渲染 HTML/CSS/GSAP 成 MP4。

## 项目架构

```
douyin/
├── src/                      # 后端服务（Node.js + Express）
│   ├── app.ts               # Express 应用配置
│   ├── server.ts            # 独立 HTTP 服务器入口
│   ├── lib/                 # 核心业务逻辑
│   │   ├── jobs.ts          # 任务管理器、手动步骤、垃圾桶
│   │   ├── ai-cleaner.ts    # AI 洗稿
│   │   ├── storage.ts       # 文件存储
│   │   ├── media.ts         # 视频下载、音频提取
│   │   ├── asr.ts           # 语音识别（内置 whisper.cpp）
│   │   ├── hyperframes-video.ts # HyperFrames 本地视频渲染
│   │   ├── video-output.ts  # 成片/原视频路径解析与安全校验（根目录约束、inode 一致性）
│   │   ├── range-response.ts# 通用 Range 流式响应（成片与素材预览共用）
│   │   ├── assets-store.ts  # 素材库索引、落盘、白名单与限额
│   │   ├── assets-routes.ts # 素材上传/列表/预览/删除
│   │   ├── local-users.ts   # 本机操作者（用户、角色、PIN）
│   │   ├── local-auth.ts    # 会话与 requireActor 鉴权守卫
│   │   ├── local-user-routes.ts # 本机操作者路由（含自动会话）
│   │   ├── publishing-*.ts  # 发布中心（资产/文案/平台/服务/存储/路由）
│   │   ├── sau-runner.ts    # 抖音图文自动发布的外部引擎封装（social-auto-upload CLI）
│   │   ├── article-draft.ts # 文章内核（平台中立）：AI 成文 + 草稿 + 兜底 + 限额档案
│   │   ├── toutiao-article.ts # 今日头条文章：限额、成文、渲染（纯函数）
│   │   ├── toutiao-media.ts # 头条封面 16:9 裁剪（走既有 ffmpeg）
│   │   ├── toutiao-browser.ts # 头条浏览器解析链（显式配置 → vendor → Playwright → 系统 Chrome）
│   │   ├── toutiao-page.ts  # 头条发布页选择器与页面步骤（每步读回校验）
│   │   ├── toutiao-runner.ts# 头条执行器：扫码登录会话 + 发布编排 + 结果校验
│   │   ├── collections.ts   # 合集采集与索引
│   │   ├── nickname.ts      # 创作者昵称兜底（简体中文）
│   │   └── user-page-crawler.ts # 抖音主页采集
│   └── types.ts             # 后端类型定义
│
├── renderer/                 # 前端界面（React + Vite）
│   ├── src/
│   │   ├── App.tsx
│   │   ├── pages/
│   │   │   ├── JobListPage.tsx        # 创作中心
│   │   │   ├── JobDetailPage.tsx      # 作品详情（工作流控制台 + 成果画布）
│   │   │   ├── CollectionListPage.tsx / CollectionDetailPage.tsx
│   │   │   ├── SkillListPage.tsx      # Skill 蒸馏产物
│   │   │   ├── PublishingPage.tsx     # 发布中心（人工交付 + 图文自动发布）
│   │   │   ├── AssetsPage.tsx         # 素材库（图片/音频）
│   │   │   ├── TrashPage.tsx
│   │   │   └── SettingsPage.tsx
│   │   ├── components/shell/          # 导航框架（侧栏/顶栏/移动端导航）
│   │   ├── components/PublishPreviewDialog.tsx # 发布前预览弹窗（视频播放器 / 图文横滑 / 文章正文）
│   │   ├── components/ToutiaoLoginPanel.tsx    # 头条号应用内扫码登录（二维码 + 轮询）
│   │   ├── components/CreateToutiaoArticleDialog.tsx # 创建头条文章包向导（封面单选 + 成文编辑 + 发布选项）
│   │   ├── components/
│   │   ├── services/api.ts
│   │   └── types/index.ts
│   └── vite.config.ts
│
├── electron/                 # Electron 主进程与配置 IPC
├── docs/superpowers/         # specs（设计规格）与 plans（实施计划）
└── dist/                     # 后端编译输出
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

**实际目录取决于运行方式**（这一点容易踩坑，务必按模式确认）：

| 运行方式 | storage 根目录 |
| --- | --- |
| 独立后端 `node dist/server.js`（开发） | **仓库内的 `storage/`**（`src/server.ts` 里 `path.join(rootDir, "storage")`） |
| Electron 桌面端 | `app.getPath('userData')/storage`，即 `~/Library/Application Support/douyin-ai-video/storage`（配置文件里的 `storagePath` 可覆盖） |

```
storage/
├── raw/
│   ├── videos/              # 下载的视频
│   ├── audio/               # 提取音频和 manifest
│   ├── transcripts/         # 结构化转录 JSON
│   ├── page/                # 页面元数据
│   └── text/                # 分享文本解析结果
├── processed/
│   ├── scripts/             # 脚本资产
│   ├── cleaned/             # AI 清洗结果
│   ├── scenes/              # 历史场景数据
│   └── subtitles/           # 字幕文件
├── output/
│   ├── videos/              # HyperFrames 项目、snapshots/ 静帧与 MP4
│   └── publishing/          # 发布交付包（自包含：成片 + 封面 + images/）
├── assets/                  # 素材库（图片/音频），手动上传
│   ├── images/
│   └── audio/
├── cache/                   # 各类索引（jobs / collections / publishing / assets / local-users）
└── logs/
```

注意：`output/videos/{jobId}/hyperframes/snapshots/frame-NN-at-Xs.png` 是生成视频时
`hyperframes snapshot` 的产物，每场景一张 1080×1920 静帧，可直接用作图文素材。

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
- `POST /api/jobs/:id/publishing/preview`（body 可带 `contentType: "note"` 走图文；图文可再带 `imageSource: "frames"|"library"` + `imageAssetIds[]`，响应回 `images`/`imageLimit`/`copyLimits`） / `GET /api/jobs/:id/publishing/assets`
- `POST /api/publishing/packages`（body 可带 `contentType: "note"` + `noteCopy` + `imageSource`/`imageAssetIds` 建图文包）、`GET /api/publishing/packages`、`GET /api/publishing/packages/:id`
- `GET /api/publishing/packages/:id/preview` - **包级预览**（产出 `previewRevision`；下发 `copyChecks`，前端只渲染不复刻字数规则）
- `GET /api/publishing/packages/:id/images/:index` - 图文包第 `index` 张图（0 基，对应 `imagePaths`；越界 404）
- `POST /api/publishing/tasks/:id/auto-publish` - 提交抖音图文（**必须带 `previewRevision`**：缺失 400 / 不一致 409）
- `POST /api/publishing/tasks/:id/auto-publish/code` - 投喂短信验证码（写入 `<sauBaseDir>/verify_code.txt`）
- `POST /api/publishing/tasks/:id/auto-publish` **按「内容类型 × 平台」分派**：`note×douyin` → sau；`article×toutiao` → 自研头条执行器
- `GET /api/publishing/packages/:id/article` - 文章包的 `article.html`（降级通路：可粘进头条编辑器）
- `POST/GET/DELETE /api/publishing/toutiao/login` - 头条号**应用内**扫码登录（取二维码 / 轮询状态 / 取消）
- `POST /api/publishing/toutiao/login/window` - 打开**浏览器窗口**扫码登录（与抖音 `/api/douyin/qr-login` 同一交互；同步等待，默认 180 秒）
- `POST /api/publishing/toutiao/verify` - 头条号登录态**零副作用**自检
- `PATCH /api/publishing/tasks/:id/content` / `/schedule`、`POST .../cancel` `/restore` `/mark-published` `/record-failure`（`withdraw` 与删除/恢复发布包仅管理员）

## 关键数据结构

### JobRecord

```typescript
{
  id: string;
  sourceUrl: string;
  topic: string;
  status: JobStatus;
  stage: JobStage;
  workflowMode?: WorkflowMode;
  steps?: Record<PipelineStep, PipelineStepState>;
  deletedAt?: string;
  trashExpiresAt?: string;
  videoPath?: string;
  audioPath?: string;
  audioManifestPath?: string;
  transcriptPath?: string;
  transcriptModel?: string;
  videoProjectPath?: string;
  videoOutputPath?: string;
  videoGeneratedAt?: string;
  storagePath: string;
  createdAt: string;
  updatedAt: string;
}
```

### TranscriptAsset

```typescript
{
  jobId: string;
  sourceUrl: string;
  audioPath: string;
  transcript: string;
  text: string;
  segments: Array<{ start?: number; end?: number; text: string }>;
  words?: Array<{ start?: number; end?: number; word: string; probability?: number }>;
  duration?: number;
  language?: string;
  model: string;
  provider: string; // "whisper.cpp"
  createdAt: string;
}
```

### CleanedScript.output

```typescript
{
  title?: string;
  rawText?: string;
  summary?: string;
  keyPoints?: string[];
  cleanScript?: string;
  voiceoverScript?: string;
  videoOutline?: Array<{ title: string; bullets: string[]; visualPrompt?: string }>;
  videoPrompts?: string[];
  enhancedScenes?: any[];
  hyperframesVideo?: {
    provider: "hyperframes";
    projectPath: string;
    videoPath: string;
    manifestPath: string;
    duration: number;
    aspectRatio: "9:16";
    width: 1080;
    height: 1920;
  };
  qualityNotes?: string[];
  tags?: string[];
}
```

## 配置管理

**桌面端**的配置文件由 Electron 决定：`app.getPath('userData')/config.json`，即
`~/Library/Application Support/douyin-ai-video/config.json`（macOS）。其中的 `storagePath`
若无值则回落到同目录下的 `storage/`。API Key 由 Electron `safeStorage` 加密存储。

> 注意：`~/.douyin-ai-video/` 目录另有用途（`douyin-cookie.txt` 抖音登录态、部分历史配置），
> **它不是 Electron 读取配置文件的位置** —— 早期文档写成 `~/.douyin-ai-video/config.json` 是错的，
> 已按实测（2026-09-17）更正。

独立后端（`npm run dev:server` 形态）通过环境变量读取 AI 配置：`AI_PROVIDER` / `AI_API_KEY` /
`AI_MODEL` / `AI_BASE_URL`（见 `src/server.ts`）。

**抖音图文自动发布**（外部引擎）同样走环境变量，两条入口（独立后端与 Electron）都已透传：

- `SAU_BINARY`：`social-auto-upload` 的 `sau` 可执行文件路径，例如 `<repo-of-sau>/.venv/bin/sau`
- `SAU_BASE_DIR`：其仓库根目录（含 `conf.py`）；`cookies/` 与 `verify_code.txt` 都相对它

两者都缺省时**不静默失败**：该通路返回 422 并给出安装指引（含下述三个坑），其余发布中心功能不受影响。

**今日头条文章发布**（自研执行器）用两个 env：

- `TOUTIAO_BROWSER_BINARY`：Chromium 系可执行文件路径；缺省按解析链找
  （显式配置 → Electron 注入 → 开发态 `vendor/package-assets/browser/chrome-headless-shell/**` →
  Playwright 自身缓存 → 系统 Chrome）。
- `TOUTIAO_PROFILE_DIR`：浏览器会话目录覆盖；**必须落在 storage 内**（登录态不许落到 storage 之外）。

找不到浏览器时**不静默失败**：返回 422 并给出两条可照抄的命令
（`npm run prepare:package:mac` 或 `npx playwright install chromium`）与逐层诊断。

### AI 配置

```json
{
  "aiKeys": [
    {
      "id": "uuid",
      "name": "DeepSeek",
      "provider": "deepseek",
      "apiKey": "sk-...",
      "baseURL": "https://api.deepseek.com",
      "model": "deepseek-chat",
      "isActive": true
    }
  ]
}
```

### ASR 配置

ASR 固定使用随软件打包的本地 Whisper：

- 引擎：`whisper.cpp`
- 模型：`ggml-small`
- 音频输入：`pcm_s16le`、16kHz、单声道 WAV
- 打包资源：`resources/whisper/whisper-cli` 和 `resources/whisper/models/ggml-small.bin`

打包前运行：

```bash
npm run prepare:whisper
```

旧配置中的 `asrProvider`、`asrApiKey`、`asrBaseURL`、`asrModel` 字段兼容读取，但后端转录不再使用。
`prepare:whisper` 是构建机步骤，需要 `cmake`、C/C++ 编译工具链和 `tar`；最终用户安装应用后不需要这些依赖。

## 构建与运行

```bash
npm install
npm run dev              # 启动 Vite + Electron
npm run dev:renderer     # 单独启动前端
npm run dev:electron     # 构建 Electron 并启动桌面端
npm test                  # Node 内置测试（tsx）
npm run check            # 后端类型检查
npm run build:backend
npm run build:renderer
npm run build:electron
npm run prepare:whisper
npm run package           # 会先检查 vendor/whisper 资源是否存在
```

> ⚠️ **改了源码必须编译对应的产物，再重启**。这里有**两套**独立的编译产物，踩错任一个的表现都是"改了没生效"：

| 改动位置 | 产物 | 编译命令 | 生效方式 |
| --- | --- | --- | --- |
| `src/`（`app.ts`、`lib/*.ts`） | `dist/` | `npm run build:backend` | 重启后端（含 Electron 内嵌后端） |
| `electron/`（主进程、配置 IPC、`electron/server.ts`） | `dist-electron/` | `npm run build:electron` | 重启 Electron |
| `renderer/` | Vite 内存 | 无需 | HMR 自动热更，不必重启 |

- `npm run dev` 的 `dev:electron` 里带了 `build:electron`，所以走它启动时主进程一定是新的；但**直接 `electron .`（或 `node_modules/.bin/electron .`）会绕过这一步**，此时 `dist-electron/` 仍是旧的。
- **`build:backend` 不产出 `dist-electron/`，反之亦然** —— 两者互不覆盖。
- 典型事故（2026-09-17 实测）：在 `electron/server.ts` 里加了 `SAU_BINARY` / `SAU_BASE_DIR` 透传，环境变量确实传进了 Electron 进程，但 `dist-electron/server.js` 还是旧的、里里外外没人读它，于是无论怎么配都报「未配置」。
- `npm run check`（`--noEmit`）与 `npm test`（tsx 跑源码）都**不产出任何产物**，不能替代编译。

## 关键注意事项

### 数据来源
- 视频转录来自音频 ASR，是洗稿优先输入。
- 分享文本是参考信息；没有转录时才作为 fallback。
- 前端必须清晰区分"视频转录"和"分享文本"。

### 内容加载
- 优先加载 `cleaned` 数据。
- `script` 数据是历史接口，不作为新主链路依赖。
- 转录文本通过 `/raw-transcript` 获取，响应兼容 `transcript` 字符串并扩展 `segments`。

### 视频生成
- 新任务第 6 步可使用 HyperFrames 本地生成 9:16 MP4。
- HyperFrames 生成的是本地 HTML/CSS/GSAP 动画渲染，不是 Sora、Remotion 自动成片或 HeyGen 云视频 API。
- v1 不生成真人/数字人，不自动生成 TTS 配音；`voiceoverScript` 用作字幕和画面节奏。
- `video-prompts` 是新主链路的正式输出，HyperFrames 生成视频必须先完成该步骤。

### 手动步骤
- 新任务默认 `workflowMode: "manual"`。
- `JobStore.create()` 只创建任务，不自动跑完整链路。
- 后一步必须等待前一步 `succeeded`。
- 运行中重复触发步骤返回 `409`。
- 每次用户触发某一步，后端自动最多尝试 3 次。
- 新主链路顺序固定为 transcribe → clean → generate_video_prompts → generate_video。

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

### ASR
- ASR 固定使用内置 `whisper.cpp`，不再调用 OpenAI Whisper API、FunASR 或 faster-whisper。
- `MediaService.extractAudio()` 输出 `raw/audio/{jobId}.wav`，编码为 `pcm_s16le`、16kHz、单声道。
- 缺少 `whisper-cli` 或 `ggml-small.bin` 时，转录步骤应失败并提示重新运行 `npm run prepare:whisper` 或重新安装完整应用。

### HyperFrames
- 生成视频步骤依赖 Node.js 22+、FFmpeg、可运行的 `npx hyperframes doctor`。
- 后端先执行 `doctor --json`，再生成项目、写入 `index.html` / `video-source.json` / `DESIGN.md`，然后执行 `lint`、`validate`、`inspect`、`render`。
- 成功输出默认位于 `output/videos/{jobId}/hyperframes/renders/video.mp4`。

### 素材库
- 位置：主导航「素材」（`/assets`），只做上传/列表/缩略图/试听/删除；**图片可选入图文发布**，音频本轮不接入任何流程。
- **图片接入图文发布＝两种来源二选一**：`frames`（缺省，该作品生成视频时的场景静帧，按场景序）或 `library`（素材库多选，**按点选顺序**入包）。来源与顺序都进 `previewRevision`，所以换来源/调顺序会让旧 revision 失效（409）。
- 素材库来源经 `AssetStore.resolveFile` 解析成绝对路径后才交给 `createNotePackageAssets`（id → 路径的归属校验只有这一个真源）；`library` 选 0 张报 400、超 35 张报 422，而 `frames` 一张静帧都没有**不**报错（沿用「缺图也把包建出来、只标 `missing_images`」的既有口径）。
- 界面入口：作品详情页成果画布的「创建图文包」（与「加入发布中心」并列，组件 `CreateNotePackageDialog` 与视频向导相互独立）。
- 安全约束：**落盘文件名一律服务端生成**（`randomUUID` + 白名单扩展名），客户端提供的名字只作 `originalName` 展示、**绝不参与路径拼接**；读取与删除都校验路径落在 `assets/` 内。
- 限额：图片 `jpg/jpeg/png/webp` 单张 ≤20MB，音频 `mp3/wav/m4a/aac` 单个 ≤50MB，单次 ≤20 个文件。违规分别返回 415 / 413 / 400。
- `GET /api/assets/:id/raw` 支持 Range（音频拖动进度条依赖），与成片流共用 `range-response.ts`。
- 上传是 multipart，后端用 `multer`（memoryStorage）接收后再交给 store 落盘；**注意 busboy 按 latin1 解码 `filename`**，中文名需按 `decodeMultipartFilename()` 回退转换。
- 图片尺寸（PNG/JPEG）与 WAV 时长由纯 Node 解析容器头得到；**MP3/M4A 时长为 `undefined`**（界面显示「—」），如需补全可接 `ffprobe`。

### 原视频播放
- 「视频转录」步骤会把原视频下载到 `raw/videos/{jobId}.mp4`；详情页成果画布的「视频」格子提供**原视频 / 成片**分段切换，默认侧为「有成片看成片，否则看原视频」。
- `GET /api/jobs/:id/raw-video/stream` 与成片流共用同一份**根目录/inode 安全校验**（`video-output.ts` 的 `resolveContainedMp4`）——`job.videoPath` 是持久化绝对路径，校验若各写一份等于开放任意文件读取。
- 未下载原视频时显示「原视频尚未下载」并引导先做视频转录，**不自动发起下载**。

### 本机操作者（无登录/切换界面）
- 面向使用者的登录、切换、用户管理界面**已全部移除**；启动时前端调用 `POST /api/local-sessions/auto` 自动取得会话。
- 自动会话优先复用**已有的 `isActive` 管理员**（按 `createdAt`/`id` 升序确定性选取），只有在不存在管理员时才创建无 PIN 的「本机用户」。不删除、不改名任何历史用户。
- **管理员 PIN 的契约没有被放宽**：普通 `POST /api/local-sessions` 对管理员无 PIN 仍返回 401。无 PIN 分支只存在于 `openLocalOperator()` 这一条被显式命名的路径上。
- 发布中心的权限与审计模型完全保留（`requireActor` / `actor` 快照），只是永远只有本机操作者一个人。

### 发布中心的「渠道」分栏（抖音图文 / 今日头条文章 / 视频人工交付）

- **渠道 = 内容类型的界面投影**，不是新概念：`note` = 抖音图文、`article` = 今日头条文章、
  `video` = 视频人工交付（后者**不会自动上传**，只准备交付包）。三者本来就互斥
  （note 只可能配抖音、article 只可能配头条、其余都是 video），所以**后端只加了
  `PublishingListFilters.contentType` 一个过滤字段**（`GET /publishing/packages?contentType=`，
  非法值 400）——**不要**再造「渠道级接口」或往库里写渠道字段。
- **状态语义仍然只有服务端一份**：前端只传 `status`，绝不在前端复刻「待处理/资产异常」的判定
  （前端复刻 = 必然漂移的第二真源）。渠道相关的纯函数只在 `renderer/src/utils/publishing.ts`：
  `PUBLISH_CHANNELS` / `publishChannelOf` / `selectChannelPackages` / `countChannelPackages` /
  `countStatusesInChannel` / `channelPlatformOptions` / `channelEmptyHint`，各有用例。
- **计数来自「不带状态筛选」的那一次请求**（页面加载时同时发 `status=all`）：渠道页签得包数、
  状态页签得**当前渠道内**的完整计数。别改回「在已筛选的列表上再数一遍」——
  那会让「失败」在「待处理」视图里永远显示 0（数字看着像真的，其实是局部量，2026-09-18 修掉）。
- 渠道与状态页签**都写进 URL**（`?channel=`），且互相不冲掉：改视图要合并 query
  （`setView()`），不要用 `setParams({status})` 整体替换 —— 那会把 `channel` 一起冲掉。
- 界面约定：单平台渠道（抖音图文 / 今日头条文章）**不显示平台下拉**（否则会出现
  「选了头条却把列表筛空」的自相矛盾操作）；每个渠道一行说明（谁在提交、需要什么前置条件，
  **视频那条必须写明「不会自动上传」**）；空态按渠道给**可照抄的入口**。
- 规格与计划：`docs/superpowers/specs/2026-09-18-publishing-channel-tabs-design.md`、
  `docs/superpowers/plans/2026-09-18-publishing-channel-tabs.md`。

### 侧栏可折叠
- 桌面端左侧主导航可展开/收起，收起为纯图标、展开显示导航文字；选择存 localStorage（`douyin-ai-video.rail-expanded`）。
- 侧栏宽度只有一个真源：`AppShell` 根节点声明的 CSS 变量 `--rail-w`（收起 `md:56px` / `xl:64px`，展开 `208px`），由侧栏、内容区与两个顶栏变体共同消费 —— **不要在别处再写死 56px/64px 偏移**。
- 折叠开关固定在侧栏**底部**且两个状态都可见。早期版本把它做成「整个 logo 行」，导致收起态与改造前毫无差别、用户找不到入口（已按实测反馈修正）。

### 抖音图文自动发布（外部 sau 引擎）

- 只做**抖音图文**（`sau douyin upload-note`），视频与其它平台仍是人工交付。
- 引擎是外部依赖，**不内置**：需自装 `social-auto-upload`（约 970MB）。三个已知坑（2026-09-17 实测）：
  ① 按其官方步骤装完 CLI 起不来 —— `pyproject.toml` 只声明 `patchright`，但仍有 7 个 uploader 与 `myUtils`
  在 `import playwright`，需手动 `uv pip install playwright`；② `requires-python = ">=3.10,<3.13"`，
  Python 3.13 不在范围内，需另装 3.12；③ 仓库+venv 约 440MB、patchright chromium 约 520MB。
  另注意上游 `uploader/__init__.py` 在 **import 阶段**就会 `mkdir <BASE_DIR>/cookies`，因此该目录必须可写。
- **`task.status` 全程不变**：`autoPublish` 只是任务上的子记录，`succeeded` 的语义是**已提交**，
  绝不写 `published` —— 是否真的发出去了由人工点「标记已发布」确认。这是本功能最关键的不变式。
- **一次只允许一个**：运行中/等待验证码时再次触发返回 409；遗留的 `running` 记录超过 30 分钟视为
  「进程已死」允许重试（否则同步请求被杀后会永久锁死任务）。
- **不自动重试**：失败后必须人工再次点击（人知道上一次到底发出去没有）。
- 「发布前必经预览」是**服务端约束**：`auto-publish` 必须带 `previewRevision`（包内容指纹，图文包覆盖
  有序 `imagePaths` 与 `noteCopy`），缺失 400、不一致 409，两种情况都**不产生** `autoPublish` 记录。
- 图文包的 `video*` 字段「不适用」，其中 `videoSha256` 承载**图片清单哈希**（各图 sha256 有序拼接再哈希）
  作为等价完整性凭据；`PublishAssetHealth` 的 `missing_images` 即由它判定。
- **验证码通路当前对图文不通**（2026-09-17 从上游源码实测更正）：`verify_code.txt` 只有上游**视频**发布
  通路会读；`upload-note` 既不读它、发布循环也没有次数上限。因此图文发布遇到短信挑战的真实结局是
  「一直循环到超时（900s）→ `failed`」，`awaiting_code` 在图文通路上**不可达**，写验证码文件对图文
  **没有效果**。界面与提示必须让操作者知道：图文发布卡住的正确动作是**去抖音后台核实**，而重试前
  必须先确认上一次是否已发出（上游会 `force=True` 重复点击发布，重复发布是本功能最大的风险）。
- **我们对上游打了 1 个本地补丁**（见 `docs/patches/`）：抖音把图文发布页标题框的 placeholder 从
  「填写作品标题」改成「添加作品标题」，上游仍按旧文案匹配 → 图文发布稳定 120s 超时。
  补丁只把匹配放宽成 `作品标题`。**上游 `git pull` 会覆盖它，升级后必须重新 `git apply`**。
- 媒体元素（`<img>`/`<video>`）**不能用相对 URL、也不能带自定义请求头**：页面在 Vite(5173)、API 在
  另一个端口，相对路径会打到 Vite 的开发代理。图片走 `apiClient` 取 blob，视频走
  `apiClient.getJobVideoStreamUrl()` 的**绝对 URL**（与既有 `getAssetRawUrl` 同一套做法）。

### 今日头条文章发布（自研 Playwright 执行器）

- **平台**：`PublishPlatform` 新增 `toutiao`；**只做文章**（视频/微头条/数据/评论都不做）。
- **引擎是自研的**，不是外部 CLI：复用打包资源里已有的 `chrome-headless-shell`
  （实测 `playwright.launch({ executablePath })` 能打开真实头条登录页），**零新依赖、零额外下载**。
  参考项目 `mf-yang/toutiao-ops` 只借流程思路，**选择器不照抄**（它的选择器是启发式写法、从未被验证，
  且把失败全吞掉了 —— 见 `docs/research/toutiao-ops-assessment.md` §3）。
- **登录只能扫码**：头条号没有可手工粘贴的凭据（登录态是浏览器 profile）。**两条路都做了**：
  ① **打开浏览器窗口扫码**（与抖音那套同一交互，`POST /publishing/toutiao/login/window`）——
     用**有头**浏览器（系统 Chrome / Playwright 的完整 chromium），窗口里就是登录页，扫完自动关窗；
     **打包进来的 `chrome-headless-shell` 是无头专用构建，开不了窗口**，所以这条链单独解析、不用它；
  ② **应用内扫码**（无头）——后端从登录页 DOM 直接取二维码（`data:image/png;base64,…`，实测 512×512），
     界面用 `<img src>` 显示后轮询状态；二维码约 10 分钟过期，**点「取消并重新获取二维码」即可**（服务端不允许两个会话并存，所以要先取消）。
  两条路写的是**同一个持久化 profile**（`storage/toutiao/profile`），所以登录一次之后发布与只读侦察都不用再扫。
- **每一步都有读回校验**：标题填完读回 `value`、正文粘完读回编辑器纯文本、封面传完读回图片是否出现、
  「同时发布微头条」点完读回勾选状态。**任何一步失败都停在点「发布」之前**并写明已完成到哪一步 ——
  参考项目正是在这些地方静默失败（封面上传失败也返回「发布成功」）。
- ⚠️ **不需要勾的选项也要「真的去取消」，不能只检查**（2026-09-20 用户真机实测）：持久化 profile 会把
  上次草稿的勾选状态带回来，于是「本次不勾头条首发」时页面**已经是勾的**，而我们原先只检查、不取消，
  直接把提交拦下了。正确姿势（照 `ensureWeitoutiaoUnchecked` 的范式）：**已是目标状态就不点任何东西 →
  不是就点一下 → 读回确认 → 改不掉才 fail closed**（`toutiao_page_first_publish_uncheck_failed`）。
  拦截的理由仍然成立：**绝不能带着一个用户没选的声明发出去**。
- **「同时发布微头条」默认关闭且 fail closed**：头条发布页上这一项**默认是勾选的**，
  关不掉就**不发布**（宁可停住，也不要在用户不知情时多发一条内容）。
- **`task.status` 全程不变**：与抖音通路同一条不变式 —— 点了「发布」也只记 `succeeded`（已提交），
  绝不写 `published`；由人工在头条后台核实后点既有「标记已发布」。
- **结果独立校验**：`verification: "confirmed" | "unconfirmed"`。拿不到页面判据时 message 会写明
  「已点击发布，但未能从页面确认结果」，并要求先去头条后台核实 —— **重复发布是本功能最大的风险**。
- **文章包复用 `article` 内容类型**（与公众号同一形状）：包内 `article.html` + `cover.jpg`；
  `articleCopy.htmlSha256` 是正文完整性凭据，`toutiaoOptions`（首发/声明/微头条）**参与 `previewRevision`**。
  提交前服务层会比对包内 HTML 的 sha256，不一致直接拒绝。
- **文章正文以纯文本往返**：小标题用 `## ` 标记（`articleDraftToBodyText` / `articleBodyToDraft` 无损往返），
  HTML 由服务端渲染成内联样式；渲染后**断言正文长度**并指出从第几段开始超限。
  **展示用**的正文文本由 `articleHtmlToBodyText()` 从包内 HTML 还原（同样带 `## `，有用例断言与
  `articleDraftToBodyText` 逐字相同）；`htmlToPlainText()` 是**另一条**用途 —— 粘进编辑器与编辑器读回校验，
  编辑器里小标题是真标题、没有 `## ` 记号，**两者不能互换**。
- ⚠️ **包级预览的文案检查必须走「平台政策」，不能走「图文政策」**（2026-09-18 真浏览器验收实测）。
  `copyCheck()` 的第 5 个参数是 `copyPolicy: "platform" | "note"`：文章包与视频包走 `"platform"`，
  只有图文包走 `"note"`。**文章包照图文包传 `"note"` 的后果不是「口径松一点」，而是整条通路不可达**：
  `PUBLISH_NOTE_POLICIES` 里只有抖音 → `validateNoteCopy("toutiao")` 抛「平台 toutiao 尚未接入图文发布」
  → `GET /publishing/packages/:id/preview` **500**（界面只显示「发布服务暂时不可用」）→ 而
  `auto-publish` 要的 `previewRevision` **只能由这个接口产出**，于是「提交到头条号」永远点不出结果。
  头条的**平台政策本身就是文章口径**（`PUBLISH_PLATFORMS.toutiao`：titleMax 30 / 正文 20000），别再加第三份政策。
  当时文章用例直接读 store 里的 revision，把接口整个绕过去了 —— 所以**凡是有 `previewRevision` 约束的通路，
  用例必须真的打一次预览接口**。
- **封面必填**：服务端用既有 ffmpeg 裁成 **16:9（1280×720）**（静帧是 9:16，直接传会被平台乱裁）。
  **封面在真页上的流程**（2026-09-18 发布前演练实测）：点 `.article-cover-add`（**不能带 `force`**，
  加号常在折叠线以下，force 跳过滚动进视口 → 点击落在别处、抽屉压根不开）→ 打开上传抽屉
  （`byte-drawer … mp-ic-img-drawer`，页签「上传图片/本地上传/扫码上传」，**抽屉里有两个
  `input[type=file]`** → 裸选择器会因严格模式多匹配报错，必须限定在抽屉内取第一个）→ 点「本地上传」弹原生
  选择框（优先接 `filechooser` 事件，拿不到再退回抽屉内的文件框）→ **读回封面上真的出现了图** →
  **关掉抽屉**（不收起来会挡住下方的发布按钮）。
- **发布前演练（`--dry-run`）**：`node --import tsx scripts/probe-toutiao-publish-page.ts --dry-run`
  会在**真实页面**上把每一步都做完（填标题、粘正文、传封面、勾首发/声明、关微头条），
  **绝不点「发布」**，唯一副作用是头条会把页面自动存成一条草稿。这是验证「fixture 复刻不了的动态行为」
  的唯一手段 —— 上面那两个封面坑就是它抓出来的（fixture 用例当时全绿）。
- **文章任务不提供「编辑文案」**：正文是包级 `article.html` 的渲染结果，改任务文案会让预览与实际漂移；
  要改就重建文章包。降级通路是「下载文章 HTML」（任何时候可用、零依赖）。
- **`contentType: "article"` 必须在路由白名单里**（历史上路由只放行 video/note，漏了这一处
  的表现是文章包根本创建不出来）。
- **界面入口**：作品详情页成果画布「创建头条文章包」（与「创建图文包」并列，`CreateToutiaoArticleDialog`）；
  发布中心任务行的「提交到头条号」（必经预览）与「下载文章 HTML」（降级通路）；
  设置页「今日头条」区的应用内扫码登录。
- **选择器已按真实页面校准**（2026-09-18 只读侦察实测，产物在 `storage/toutiao/recon/`）：
  标题框是 `textarea[placeholder*="标题"]`（placeholder 原文「请输入文章标题（2～30个字）」）、
  正文是 **`.ProseMirror`**（**富文本粘贴实测有效**）、「头条首发」默认**未**勾选，而
  「**发布得更多收益**」那只 `LABEL.byte-checkbox` 默认**带 `byte-checkbox-checked`**（= 微头条默认勾选）。
  离线 fixture（`src/lib/fixtures/toutiao-publish-page.html`）是从快照里**逐段抠出来的**，
  页面步骤与发布编排的用例用**真浏览器**跑它（18 项：含两种封面形态、确认/无确认两种确认页形态）。
- ⚠️ **两条实测踩出来的坑（别踩第二次）**：
  ① **页面侧代码必须用字符串下发**：tsx/esbuild 会给内联函数（尤其里面的具名 const 箭头函数）包上
     `__name(...)` 助手，而 Playwright 是把**函数源码**丢进页面执行 → 页面里没有 `__name`，
     直接 `ReferenceError`。`dist/` 由 tsc 编译不受影响，所以这个坑**只在 tsx 下**出现（脚本与测试都跑 tsx）。
  ② **点复选框不能按「第一个文案命中」**：`div.exclusive-checkbox-wraper` 的文本也是「头条首发」，
     且在文档序里排在 `LABEL.byte-checkbox` 前面 —— 点外层 div 状态丝毫不变，而调用方以为勾上了。
     `clickCheckboxByText()` 因此**优先点拥有 checkbox 的 LABEL**，并且「头条首发」勾完还要**读回确认**。
- **「确认发布」必须读回**（2026-09-18 代码评审抓到的漏洞）：只点「预览并发布」而没点到确认按钮，
  事实上什么都没发出去 —— 所以 `submitAndConfirm` 返回 `confirmClicked`，为 false 时
  **返回 `ok:false` 并明说「没有找到确认按钮、本次未提交任何内容」**，绝不写「已点击发布」。
  带确认按钮 / 不带确认按钮两种形态各有一条真浏览器用例。
- **每一步的读回都要比「内容」而不是比「有没有」**：标题先清空再输入并断言**读回等于要发的标题**
  （登录态是持久化 profile，头条可能恢复上次草稿把标题框预填，直接 type 会拼成「旧标题+新标题」）；
  正文要能在编辑器里找到**首段与末段**；封面要读回封面上真的出现了图；勾选框读回只看
  **拥有 checkbox 的元素**（说明性文案如 `div.edit-label` 不算命中，否则会得出「已是未勾选」而带着平台默认的勾选发出去）。
- ⚠️ **清空输入框只能按一个「全选」键**（2026-09-18 真机实测的既有 bug）：
  `clearInput()` 原先同时按 `Meta+A` 与 `Control+A` —— macOS 上 `Cmd+A` 是全选、而 **`Ctrl+A` 是
  Emacs 的「移到行首」，会把选区塌缩掉**，后续 Backspace 什么也删不掉，于是「先清空」形同虚设。
  真机三步确证：`Meta+A→Backspace` 读回 `""`；`Meta+A→Ctrl+A→Backspace` 读回原文；
  选中后 `insertText` 是**替换**选区。现在的做法：按 `process.platform` 选一个全选键 +
  **读回确认**（三轮）+ 原生 setter/`input` 事件兜底。**别再加第二个全选键**。
- ⚠️ **自检/发布前的登录态判定要「重试后才作数」**（真机实测 2026-09-18）：`checkLogin()` 只读一次 URL
  就下结论时，应用刚启动的第一次自检会报「未登录」，几秒后再查**同一份 profile** 却是「已登录（昵称）」
  —— 首页那次跳转还没落地。假阴性的代价是发布会**被自己拦在**「登录态已失效，请重新扫码」上，
  用户跑去重扫一个其实好好的码。现在 `LOGIN_CHECK_ATTEMPTS = 2`：停在登录页要**再确认一次**才作数
  （重试只是给页面落地的机会，**不放松判定**：两次都在登录页才是真的没登录）。
- ⚠️ **标题写入是概率性丢字符的，必须「尝试阶梯 + 延后读回」**：同一条标题、同一种写法，
  真机上有时 28/28、有时丢一个空格（用户 2026-09-18 那次就是被这条拦下的：读回 27 字、期望 28 字）。
  `fillTitle` 因此按可靠性排序多试几次：**整体插入（`keyboard.insertText`，单次事件、不走逐键竞态）
  → 再来一次 → 逐字输入兜底**，每次写完**先等 250ms 再读回**（受控输入可能稍后才把模型值写回 `.value`）。
  读回不一致时的报错必须带**字符级差异**（`第 N 个字符起不同/少了/多了`），只报字数没法排查。
- **退出清理**：装配时调用 `ToutiaoRunner.installExitCleanup()`（`exit`/`SIGINT`/`SIGTERM` 尽力关掉登录会话的浏览器），
  避免退出后留下持有 profile 的孤儿进程。
- **浏览器的 Playwright 缓存层会真的探测**（不是无条件乐观）：探测不到就继续往下，
  最终给出可照抄的指引，而不是把真正的失败拖到 `launch()` 那一刻（那会变成 500，且
  `autoPublish` 会卡在 `running` 直到 30 分钟僵死阈值）。发布流程里的**任何**异常都收敛成
  `ok:false`（含 Playwright 自己的超时/元素失效），保证记录一定落到 `failed`。
- ⚠️ **头条这一族错误必须在路由层的错误边界里登记**（2026-09-18 应用内实测的事故）。
  `publishing-routes.ts` 的错误边界原先只认 `Publishing*Error` / `SauRunnerError` / `VideoOutputError`，
  **一个头条错误类都没认** → 它们全都落进兜底 500「发布服务暂时不可用，请稍后重试」。后果不是
  「状态码不准」，而是**指引整条丢掉**：界面上的「扫码登录 / 校验登录」只剩一句无从下手的话，
  而真正的 `EPERM: … mkdir` 连日志都没有（兜底分支当时**什么都不打**，现已加一行 `console.error`）。
  已登记：`ToutiaoRunnerError` / `ToutiaoBrowserError` / `ToutiaoPageError` / `ToutiaoArticleError` /
  `ToutiaoMediaError`（它们各自带 `status` + `code`）。**新增头条侧错误类时必须一起加进去**，
  用例：`toutiao runner errors surface with their own status, code and guidance`。
- ⚠️ **启动失败要带原因 + 带动作，会话目录由我们自己建**：
  `openToutiaoSession()` 把 `launch()` 抛出的**任意**异常包成
  `ToutiaoRunnerError("toutiao_browser_unavailable", "头条浏览器启动失败：<原始原因>。可照抄的动作：…")`；
  `defaultLaunch()` 自己 `mkdir(profileDir)`，失败时报 `toutiao_profile_dir_unsafe`
  并写出**是哪个目录、什么原因**。这两处都是 2026-09-18 踩出来的：交给 Playwright 建目录时，
  目录不可写只会得到一句 `launchPersistentContext: EPERM … mkdir`，看不出是权限问题还是浏览器问题。
- ⚠️ **发布路径上「任何异常都要落成 `failed` 记录」**：`publishArticle()` 的第一行 `openSession()`
  在它自己的 `try` **之外**，所以浏览器起不来会直接抛到 `publishing-service`。
  服务层原先只把 `ToutiaoRunnerError` 记成失败、其余**原样抛出** → 500 + `autoPublish` 停在 `running`
  （界面只显示「正在进行中」、按钮灰掉，直到 30 分钟僵死阈值）——正是上一条要避免的形态。
  现在服务层把所有异常都落成 `failed`（非执行器错误会带 `头条发布过程中出现意外错误：<原因>`）。
  用例：`toutiao publish: a launch failure is recorded as failed…` 与 `…even an unexpected raw error…`。
- ✅ **真实站点端到端已跑通一次**（2026-09-20，用户手动确认「已成功发送到今日头条平台」）：
  候选确认文案**命中了**（步骤里出现「点击发布并确认」、文章真的发出去了），
  但页面上没有我们认识的 `successTexts` → 如实记 `succeeded` + `verification: "unconfirmed"` +
  「请先到头条后台核实」，用户核实后点了「标记已发布」（任务状态才变 `published`）。
  **这条不变式在真机上被完整走了一遍：机器只记「已提交」，是否真发出由人工核实。**
- ⚠️ **成功提示的真实文案仍未拿到**（因此「点到了但读不到判据」这条路仍是常态）。为此
  `submitAndConfirm()` **每次都带回 `postConfirm` 证据**（确认后的 URL、是否已离开发布页、
  页面可见文案的**头+尾**摘要）并写进 `autoPublish.message` —— 下一次真机跑一把就能照着校准
  `successTexts`。**注意**：`leftPublishPage` 只是**旁证**，会话失效也会跳到登录页，
  **绝不能**拿它冒充 `confirmed`。
- ⚠️ **服务层不要再给 runner 的文案加前缀**：`verification === "unconfirmed"` 时 runner 的文案
  本身就以「已点击发布，但未能从页面确认结果…」开头，早先服务层又拼了「已提交，但」→
  真机记录里成了「已提交，但已点击发布，但…」。现在未确认时**原样记 runner 的文案**。
- **确认页的真实按钮**：候选文案（`TOUTIAO_SELECTORS.confirmButtons`）在真机上命中过一次，
  但这个文案随时可能变；而「有没有点到」始终由**读回**决定，不靠猜。

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
0. **明明配了 `SAU_BINARY` / `SAU_BASE_DIR`，重启后仍报「未配置」** → 先查 `dist-electron/` 是不是旧的：
   `grep -c SAU_BINARY dist-electron/server.js`（应为 ≥1，为 0 就是没编译主进程，跑 `npm run build:electron` 再重启）。
   用 `lsof -nP -iTCP -sTCP:LISTEN | grep -i electron` 找内嵌后端端口，`ps -Eww -p <PID> | grep -o "SAU_[A-Z_]*=[^ ]*"`
   可确认环境变量是否真的进了进程（注意用 `grep -o`，`ps -Eww` 的环境段不一定在行首）。
1. 报「未配置 sau 可执行文件」→ 按提示装好引擎并设置 `SAU_BINARY` / `SAU_BASE_DIR`，**然后重启后端**（env 只在启动时读）。
2. 预检输出 `invalid` → 登录态失效，需重新扫码登录（`~/.douyin-ai-video/douyin-cookie.txt` 是唯一真源）。
3. 点「发布图文到抖音」时先弹出预览是**预期行为**（必经确认），确认后才真正提交。
4. 提交后长时间无变化 → 上游发布循环没有次数上限，超时前不会返回；超时落在 `failed` 时**先去抖音后台核实**再重试。

### 今日头条文章发布不工作
1. 报「未找到可用于头条号发布的浏览器」→ 按提示二选一：`npm run prepare:package:mac` 或
   `npx playwright install chromium`；也可以用 `TOUTIAO_BROWSER_BINARY` 直接指定路径，**然后重启后端**。
2. 发布页被重定向回登录页 → 登录态失效：到「设置 → 今日头条」点「打开浏览器扫码登录」（或「扫码登录」），
   用今日头条 App 扫码；也可以直接跑 `node --import tsx scripts/probe-toutiao-publish-page.ts --login`。
3. 点「打开浏览器扫码登录」报「本机没有可用于打开浏览器扫码的浏览器」→ 打包的 headless shell 开不了窗口：
   装上 Google Chrome，或 `npx playwright install chromium`，或改用「应用内扫码」。
4. 报「找不到标题输入框 / 正文编辑器 / 封面上传入口 / 同时发布微头条勾选框」→ **页面结构已改版**：
   先跑只读侦察脚本 `node --import tsx scripts/probe-toutiao-publish-page.ts`（登录 → 进发布页 → 落 DOM 快照，
   **不填表、不点发布**），按它的证据改 `toutiao-page.ts` 里的选择器，**不要盲目重试**。
5. 提示「已点击发布，但未能从页面确认结果」→ **先去头条后台「内容管理」核实是否已发出**，再决定是否重试
   （重复发布是本功能最大的风险）。
6. 取消勾选「同时发布微头条」失败时**不会发布**：这是刻意 fail closed，避免在不知情时多发一条微头条。
7. 点「提交到头条号」后界面只说「发布服务暂时不可用」→ 先看 `GET /api/publishing/packages/:id/preview`
   是不是 **500**（浏览器 Network 面板）。这条接口必须回来，因为 `auto-publish` 的 `previewRevision`
   只能由它产出；历史事故是文章包被按**图文口径**校验（`PUBLISH_NOTE_POLICIES` 里只有抖音）→ 见上方
   ⚠️「包级预览的文案检查必须走平台政策」。**改完记得 `npm run build:backend` 再重启**。
8. **设置页点「扫码登录 / 校验登录」也报「发布服务暂时不可用」** → 这句话就是兜底 500，说明抛出的异常
   **没被错误边界认出来**（头条那一族错误类漏登记，见上方 ⚠️）。现在后端会打印
   `[publishing] 未预期的错误: …`，**直接看后端/Electron 的输出**即可拿到真原因；若原因形如
   `EPERM: operation not permitted, mkdir '<storage>/toutiao'`，那就是**会话目录不可写**：
   确认 storage 目录存在且当前用户可写（打包/沙箱环境里尤其常见），或用 `TOUTIAO_PROFILE_DIR`
   指向 storage 内另一个可写目录后重启后端。修好后界面会直接显示这条原因与可照抄的动作，不再是「稍后重试」。
9. 提示「**标题框里读回的内容与要发的标题不一致**」→ 这条是**我们自己拦下的**（没提交任何内容）。
   若差的是**空格的多少/位置**或只差一两个字，通常是受控输入竞态或输入法组合导致的偶发丢字符：
   现在已经会「换写法重试并延后读回」，再报错时**把报错里那句「第 N 个字符起…」一起发出来**即可定位。
   若差得很多（例如读回是「旧标题+新标题」或越写越长），说明**清空没生效** → 见上方
   ⚠️「清空输入框只能按一个全选键」。

### 前端无法连接后端
1. Electron 内嵌后端使用随机本地端口，前端通过 `window.electron.getServerPort()` 获取。
2. 开发模式下确认 `npm run dev` 正在运行。
3. 检查防火墙设置。

---

**最后更新**: 2026-09-20
**维护者**: Codex
**仓库**: https://github.com/LiChangZheng10086/doyin_ai_video.git
