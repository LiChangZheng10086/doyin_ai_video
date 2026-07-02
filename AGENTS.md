# 抖音 AI 视频助手

基于 Electron + React 的桌面应用，用于从抖音视频链接或分享文本生成视频转录、AI 洗稿内容和 PPT。当前主链路不做视频生成，新任务也不生成复杂视频提示词；旧视频提示词接口仅保留历史兼容。

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
│   │   ├── asr.ts           # 语音识别（OpenAI / local-whisper / FunASR）
│   │   └── ppt-generator.ts # PPT 内容和 PPTX 生成
│   └── types.ts             # 后端类型定义
│
├── renderer/                 # 前端界面（React + Vite）
│   ├── src/
│   │   ├── App.tsx
│   │   ├── pages/
│   │   │   ├── JobListPage.tsx
│   │   │   ├── JobDetailPage.tsx
│   │   │   ├── TrashPage.tsx
│   │   │   └── SettingsPage.tsx
│   │   ├── components/
│   │   ├── services/api.ts
│   │   └── types/index.ts
│   └── vite.config.ts
│
├── electron/                 # Electron 主进程与配置 IPC
└── dist/                     # 后端编译输出
```

## 技术栈

### 后端
- Node.js 18+、Express 4、TypeScript
- `openai`：OpenAI-compatible AI 与 OpenAI Whisper ASR
- `yt-dlp`：视频下载（外部二进制）
- `ffmpeg` / `ffprobe`：音视频处理（外部二进制）
- FunASR：本地中文 ASR（可选 Python 依赖，不通过 npm 安装）

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
    1. 下载视频（yt-dlp）
    2. 提取音频（ffmpeg）
    3. ASR 转文案（OpenAI Whisper / 本地 Whisper / 本地 FunASR）
    4. AI 洗稿
    5. 生成 PPT 内容和 PPTX
```

每个步骤独立执行。用户点击某一步后，后端在同一次请求内自动重试最多 3 次；失败后停在当前步骤，用户可手动重试。后一步必须等前一步成功后才能执行。

### 数据存储

默认目录：`~/Documents/抖音AI视频/`

```
抖音AI视频/
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
│   └── ppt/                 # PPTX 输出
└── logs/
```

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
  | "generating-ppt"
  | "scripted"
  | "rendered"
  | "failed";

type WorkflowMode = "manual" | "auto";
type PipelineStep = "download" | "extract_audio" | "transcribe" | "clean" | "generate_ppt";
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
- `POST /api/jobs/:id/steps/download`
- `POST /api/jobs/:id/steps/extract-audio`
- `POST /api/jobs/:id/steps/transcribe`
- `POST /api/jobs/:id/steps/clean`
- `POST /api/jobs/:id/steps/generate-ppt`

### 内容获取
- `GET /api/jobs/:id/script` - 历史脚本资产
- `GET /api/jobs/:id/cleaned` - AI 清洗结果
- `GET /api/jobs/:id/raw-transcript` - 结构化原始转录
- `GET /api/jobs/:id/video-prompts` - 历史视频提示词兼容接口
- `GET /api/jobs/:id/ppt-content` - PPT 内容
- `GET /api/jobs/:id/ppt/download` - 下载 PPTX

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
  provider: string; // openai | local-whisper | funasr
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
  pptOutline?: Array<{ title: string; bullets: string[] }>;
  pptContent?: any;
  qualityNotes?: string[];
  tags?: string[];
  videoPrompts?: string[];    // 历史字段，兼容旧任务
  enhancedScenes?: any[];     // 历史字段，兼容旧任务
}
```

## 配置管理

配置文件位置：`~/.douyin-ai-video/config.json`

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

FunASR 本地中文转录：

```json
{
  "asrProvider": "funasr",
  "asrModel": "paraformer-zh"
}
```

OpenAI Whisper API：

```json
{
  "asrProvider": "openai",
  "asrApiKey": "sk-...",
  "asrBaseURL": "https://api.openai.com/v1",
  "asrModel": "whisper-1"
}
```

支持的 ASR provider：

- `funasr`：本地中文 ASR，推荐用于中文短视频；无需 ASR API Key，但需要 Python 3.8+、`torch`、`torchaudio`、`funasr`。
- `openai`：OpenAI Whisper API，需要 `asrApiKey`。
- `local` / `local-whisper` / `whisper` / `faster-whisper`：本地 faster-whisper，需要 Python 环境中安装 `faster-whisper`。

## 构建与运行

```bash
npm install
npm run dev              # 启动 Vite + Electron
npm run dev:renderer     # 单独启动前端
npm run dev:electron     # 构建 Electron 并启动桌面端
npm run check            # 后端类型检查
npm run build:backend
npm run build:renderer
npm run build:electron
npm run package
```

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
- 初期不做视频生成、不接 Sora、不接 Remotion 自动成片。
- `video-prompts` 旧接口可保留兼容，但前端不要恢复为主流程入口。

### 手动步骤
- 新任务默认 `workflowMode: "manual"`。
- `JobStore.create()` 只创建任务，不自动跑完整链路。
- 后一步必须等待前一步 `succeeded`。
- 运行中重复触发步骤返回 `409`。
- 每次用户触发某一步，后端自动最多尝试 3 次。

### 垃圾桶
- 删除任务是软删除：设置 `deletedAt` 和 `trashExpiresAt`。
- 垃圾桶保留 30 天，启动和查询列表时清理过期任务。
- 永久删除会清理该 jobId 关联产物；处理中任务禁止永久删除。

### ASR
- FunASR 无需第三方 ASR API Key，但首次运行可能需要下载模型。
- 缺少 `funasr`、`torch`、`torchaudio` 时，转录步骤应失败并给出可执行安装提示。
- OpenAI Whisper 的 `verbose_json` 若不兼容，应 fallback 到普通转录请求。

## 故障排查

### 转录功能不工作
1. 检查设置页 ASR provider。
2. FunASR：确认当前 Python 环境已安装 `torch`、`torchaudio`、`funasr`。
3. OpenAI Whisper：确认 API Key、Base URL 和模型有效。
4. 本地 Whisper：确认 Python 环境已安装 `faster-whisper`。
5. 查看 `raw/transcripts/` 是否生成 JSON。
6. 查看任务详情页转录步骤错误和后端日志。

### 视频下载失败
1. 确认 `yt-dlp` 二进制存在。
2. 检查网络连接和代理设置。
3. 验证抖音链接格式。
4. 必要时配置 cookies 或浏览器登录态。

### 前端无法连接后端
1. Electron 内嵌后端使用随机本地端口，前端通过 `window.electron.getServerPort()` 获取。
2. 开发模式下确认 `npm run dev` 正在运行。
3. 检查防火墙设置。

---

**最后更新**: 2026-07-02
**维护者**: Codex
**仓库**: https://github.com/LiChangZheng10086/doyin_ai_video.git
