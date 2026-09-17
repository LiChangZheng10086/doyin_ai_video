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
│   │   │   ├── PublishingPage.tsx     # 发布中心（人工交付）
│   │   │   ├── AssetsPage.tsx         # 素材库（图片/音频）
│   │   │   ├── TrashPage.tsx
│   │   │   └── SettingsPage.tsx
│   │   ├── components/shell/          # 导航框架（侧栏/顶栏/移动端导航）
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
- `POST /api/jobs/:id/publishing/preview` / `GET /api/jobs/:id/publishing/assets`
- `POST /api/publishing/packages`、`GET /api/publishing/packages`、`GET /api/publishing/packages/:id`
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

> ⚠️ **后端改动生效需两步**：开发模式下 Electron 加载的是编译产物 `dist/app.js`（见 `electron/server.ts`），而 `npm run dev` 的 `dev:electron` 只编译 Electron 主进程、**不编译后端**。因此改了 `src/`（`app.ts`、`lib/*.ts`）后，必须先 `npm run build:backend` 再重启 `npm run dev`，否则运行中的应用仍是旧后端。渲染器（`renderer/`）由 Vite 提供并 HMR 热更，改前端无需重启。`npm run check`（`--noEmit`）和 `npm test`（tsx 跑源码）都不产出 `dist/`，不能替代编译。

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

### 前端无法连接后端
1. Electron 内嵌后端使用随机本地端口，前端通过 `window.electron.getServerPort()` 获取。
2. 开发模式下确认 `npm run dev` 正在运行。
3. 检查防火墙设置。

---

**最后更新**: 2026-09-17
**维护者**: Codex
**仓库**: https://github.com/LiChangZheng10086/doyin_ai_video.git
