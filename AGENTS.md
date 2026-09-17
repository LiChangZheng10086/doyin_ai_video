# 抖创工坊

基于 Electron + React 的桌面应用，用于抖音视频采集、转录、AI 洗稿、Skills 蒸馏和本地竖屏视频生成。当前视频生成通过 HyperFrames CLI 本地渲染 HTML/CSS/GSAP 成 MP4。

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
│   │   ├── components/PublishPreviewDialog.tsx # 发布前预览弹窗（视频播放器 / 图文横滑）
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
- `POST /api/jobs/:id/publishing/preview`（body 可带 `contentType: "note"` 走图文） / `GET /api/jobs/:id/publishing/assets`
- `POST /api/publishing/packages`（body 可带 `contentType: "note"` + `noteCopy` 建图文包）、`GET /api/publishing/packages`、`GET /api/publishing/packages/:id`
- `GET /api/publishing/packages/:id/preview` - **包级预览**（产出 `previewRevision`；下发 `copyChecks`，前端只渲染不复刻字数规则）
- `GET /api/publishing/packages/:id/images/:index` - 图文包第 `index` 张图（0 基，对应 `imagePaths`；越界 404）
- `POST /api/publishing/tasks/:id/auto-publish` - 提交抖音图文（**必须带 `previewRevision`**：缺失 400 / 不一致 409）
- `POST /api/publishing/tasks/:id/auto-publish/code` - 投喂短信验证码（写入 `<sauBaseDir>/verify_code.txt`）
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
- 媒体元素（`<img>`/`<video>`）**不能用相对 URL、也不能带自定义请求头**：页面在 Vite(5173)、API 在
  另一个端口，相对路径会打到 Vite 的开发代理。图片走 `apiClient` 取 blob，视频走
  `apiClient.getJobVideoStreamUrl()` 的**绝对 URL**（与既有 `getAssetRawUrl` 同一套做法）。

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

### 前端无法连接后端
1. Electron 内嵌后端使用随机本地端口，前端通过 `window.electron.getServerPort()` 获取。
2. 开发模式下确认 `npm run dev` 正在运行。
3. 检查防火墙设置。

---

**最后更新**: 2026-09-17
**维护者**: Codex
**仓库**: https://github.com/LiChangZheng10086/doyin_ai_video.git
