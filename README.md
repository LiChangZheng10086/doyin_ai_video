# 抖音 AI 视频助手

> 基于 Electron 的桌面应用，从抖音视频链接或分享文本生成视频转录、AI 洗稿内容、PPT 和本地竖屏视频

一个面向内容复盘和二次创作的本地桌面工具。当前主链路聚焦为：下载视频、提取音频、内置 Whisper 转录、AI 洗稿、生成 PPT，并可选使用 HyperFrames 本地渲染 9:16 MP4。新任务采用手动分步执行，每一步都支持自动 3 次重试和失败后的手动重试。

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)
![Electron](https://img.shields.io/badge/electron-34.x-blue.svg)
![React](https://img.shields.io/badge/react-19.x-blue.svg)

## 核心功能

### 手动分步流程

```
输入：抖音分享链接 / 分享文本
  ↓
创建任务：解析并保存输入，不自动跑完整链路
  ↓
用户逐步确认执行：
  1️⃣ 下载视频（yt-dlp）
  2️⃣ 提取音频（ffmpeg → 16kHz mono WAV）
  3️⃣ ASR 转文案（内置 whisper.cpp）
  4️⃣ AI 洗稿
  5️⃣ 生成 PPT 内容和 PPTX
  6️⃣ 生成本地竖屏视频（可选，HyperFrames）
  ↓
输出：📝 结构化转录 + ✍️ 清洗稿 + 📊 PPTX + 🎬 MP4
```

每个步骤都有明确状态：`pending | running | succeeded | failed`。用户点击某一步后，后端会在该请求内自动重试最多 3 次；失败后停在当前步骤，用户可手动重试。

### 功能特性

- ✅ **视频下载** - 支持抖音链接解析和视频下载
- ✅ **音频提取** - 使用 ffmpeg 抽取标准化音频，并保存音频 manifest
- ✅ **语音转录** - 内置 whisper.cpp + ggml-small，本机完成中文转录
- ✅ **离线 ASR** - 无需 ASR API Key、Python、FunASR 或 faster-whisper
- ✅ **AI 洗稿** - 基于转录优先清洗，输出标题、摘要、要点、清洗稿、口播稿和质量提示
- ✅ **PPT 生成** - 基于清洗稿、核心要点和大纲生成结构化 PPT 内容与 PPTX
- ✅ **本地视频生成** - 使用 HyperFrames CLI 将清洗稿、PPT 大纲和字幕节奏渲染为 9:16 MP4
- ✅ **任务垃圾桶** - 删除任务后保留 30 天，可恢复或永久删除
- ✅ **多 AI 模型** - 支持 DeepSeek、OpenAI 等多种 AI 服务
- ✅ **桌面应用** - 基于 Electron，支持 macOS 和 Windows
- ✅ **实时反馈** - 任务进度实时更新，详细展示每个步骤状态和错误

## 界面预览

### 主界面 - 任务列表
- 创建新任务（URL 或分享文本）
- 查看所有任务状态
- 查看当前可执行步骤或失败步骤
- 删除任务到应用内垃圾桶

### 任务详情页
- **概览** - 任务基本信息和处理状态
- **主链路步骤** - 下载视频、提取音频、ASR 转文案、AI 洗稿、生成 PPT、生成视频
- **视频转录** - 从视频音频提取的真实转录文字
- **AI 洗稿** - 清洗后的标题、摘要、核心要点、脚本、口播稿和质量提示
- **PPT 内容** - 基于清洗稿生成的 6-10 页结构化演示内容和 PPTX 下载
- **视频成片** - HyperFrames 本地渲染的 MP4、项目路径和场景列表

### 设置页面
- **AI 密钥管理** - 管理多个 AI 服务 API Key
- **语音识别状态** - 展示内置 Whisper 本地转录能力

## 技术架构

```
┌─────────────────────────────────────────┐
│         Electron 主进程                  │
│  - 窗口管理                              │
│  - IPC 通信                              │
│  - 后端服务启动                           │
└─────────────────────────────────────────┘
           │                    │
    ┌──────┘                    └──────┐
    ▼                                  ▼
┌─────────────────┐          ┌──────────────────┐
│  React 前端      │  HTTP    │  Express 后端     │
│                 │ ◄────►   │                  │
│  - React 19     │          │  - 任务管理       │
│  - Vite         │          │  - 视频下载       │
│  - Zustand      │          │  - 音频提取       │
│  - Tailwind CSS │          │  - 语音转录       │
│  - React Router │          │  - AI 清洗        │
│                 │          │  - PPT 生成       │
│                 │          │  - 本地视频渲染    │
└─────────────────┘          └──────────────────┘
                                      │
                      ┌───────────────┴───────────────┐
                      ▼                               ▼
             ┌─────────────────┐             ┌────────────┐
             │ AI / 本地 ASR    │             │ 文件存储    │
             │ - DeepSeek      │             │            │
             │ - OpenAI        │             │ ~/Documents│
             │ - whisper.cpp   │             │ /抖音AI视频 │
             │ - ggml-small    │             └────────────┘
             └─────────────────┘
```

## 技术栈

### 后端
- **运行时**: Node.js 18+
- **框架**: Express 4
- **语言**: TypeScript 5.x
- **视频处理**: yt-dlp, ffmpeg
- **AI 服务**: OpenAI SDK（兼容 DeepSeek / OpenAI-compatible）
- **ASR**: 内置 whisper.cpp + ggml-small（随安装包携带）
- **视频渲染**: HyperFrames CLI（可选，生成视频步骤需要 Node.js 22+ 和 FFmpeg）

### 前端
- **框架**: React 19
- **构建**: Vite 6
- **路由**: React Router DOM 7
- **状态管理**: Zustand 5
- **样式**: Tailwind CSS（自定义设计系统）

### 桌面端
- **框架**: Electron 34
- **打包**: electron-builder

## 安装与运行

### 环境要求

- Node.js >= 18.0.0
- npm >= 9.0.0
- macOS 或 Windows
- 开发模式需要本机可用的 yt-dlp、ffmpeg 和 npx HyperFrames
- 打包命令会自动准备完整运行资源；构建机需要联网、`tar`、`unzip` 和基础命令行工具
- 安装包会内置 yt-dlp、ffmpeg、ffprobe、whisper.cpp、ggml-small、HyperFrames CLI 和 Chrome headless shell

### 安装依赖

```bash
# 克隆仓库
git clone https://github.com/LiChangZheng10086/doyin_ai_video.git
cd doyin_ai_video

# 安装依赖
npm install
```

### 开发模式

```bash
# 一次性启动 Vite + Electron
npm run dev

# 或分别启动
npm run dev:renderer
npm run dev:electron
```

### 生产构建

```bash
# 打 macOS Apple Silicon DMG/ZIP
npm run package:mac

# 打 Windows 11 x64 NSIS 安装器
npm run package:win

# 连续打 macOS + Windows
npm run package:all
```

打包脚本会按目标平台准备 `vendor/package-assets`，并把运行所需资源复制到安装包：

- `bin/`：yt-dlp、ffmpeg、ffprobe
- `whisper/`：whisper-cli、ggml-small 模型和 Windows DLL
- `hyperframes/`：HyperFrames CLI 及其 Node 依赖
- `browser/`：Chrome headless shell

当前 `package:mac` 生成 macOS arm64 包；`package:win` 生成 Win11 x64 包。安装后的应用不要求用户再安装 Python、FunASR、Whisper、ffmpeg、yt-dlp、Node.js 或 HyperFrames。抖音下载和 AI 洗稿仍然需要网络，AI 洗稿/PPT 内容生成仍需要有效的 AI API Key。

## 配置说明

### 1. AI API 配置

在应用设置页面添加 AI API Key：

**DeepSeek**（推荐）
- API Key: https://platform.deepseek.com/api_keys
- 模型: deepseek-chat
- 性价比高，适合中文内容

**OpenAI**
- API Key: https://platform.openai.com/api-keys
- 模型: gpt-4o, gpt-4o-mini
- 质量稳定

### 2. 语音转录配置

语音转录已经内置到桌面应用中：

- 引擎：`whisper.cpp`
- 模型：`ggml-small` 多语言模型
- 音频：ffmpeg 提取 `pcm_s16le`、16kHz、单声道 WAV
- 运行方式：本机转录，不需要 ASR API Key、Python、FunASR 或 faster-whisper

开发模式或单独准备 Whisper 时运行：

```bash
npm run prepare:whisper
```

该命令会生成：

```text
vendor/whisper/
├── whisper-cli
└── models/
    └── ggml-small.bin
```

旧配置文件里的 `asrProvider`、`asrApiKey`、`asrBaseURL`、`asrModel` 会继续被兼容读取，但后端转录不再使用它们。

### 3. 外部依赖

开发模式会使用以下系统工具；正式安装包已经内置同类资源：

- **yt-dlp** - 视频下载
  ```bash
  brew install yt-dlp  # macOS
  ```

- **ffmpeg** - 音视频处理
  ```bash
  brew install ffmpeg  # macOS
  ```

- **HyperFrames** - 本地 HTML 动画渲染为 MP4（开发模式生成视频步骤需要）
  ```bash
  npx --yes hyperframes@0.7.48 doctor
  ```

HyperFrames 是本地 HTML/CSS/GSAP 到视频的渲染链路，不是 Sora、Remotion 自动成片或 HeyGen 云端视频生成 API。开发环境默认通过 `npx --yes hyperframes@0.7.48` 调用 CLI；打包后优先使用安装包内置的 HyperFrames CLI 和 Chrome headless shell。当前 v1 生成无真人、无数字人的图文解释视频；`voiceoverScript` 用作字幕和画面节奏，暂不自动生成 TTS 配音。

## 📖 使用指南

### 创建任务

1. 点击主页的"+ 新建任务"按钮
2. 选择输入方式：
   - **URL 模式**: 粘贴抖音分享链接
   - **文本模式**: 粘贴分享文本
3. 输入主题标签（可选）
4. 创建后进入任务详情页

### 执行主链路

在任务详情页按顺序点击：

1. 下载视频
2. 提取音频
3. ASR 转文案
4. AI 洗稿
5. 生成 PPT
6. 生成视频（可选）

未满足前置条件的步骤会禁用；运行中的步骤会禁止重复触发。某一步失败时，可查看错误信息并手动重试。

### 查看结果

生成对应产物后，可在详情页查看：

- **视频转录** - 查看视频音频的真实转录文字
  - 支持整段正文和结构化分段
  - 需要完成 ASR 转文案步骤
  - 未配置时显示分享文本

- **AI 洗稿** - 查看清洗后的脚本
  - 标题
  - 摘要和核心要点
  - 清洗稿和口播稿
  - 质量提示

- **PPT 内容** - 查看基于清洗稿生成的页面结构，并下载 `.pptx`
- **视频成片** - 查看 HyperFrames 渲染结果、场景列表并下载 `.mp4`

### 删除与垃圾桶

- 删除任务后会进入应用内垃圾桶。
- 垃圾桶保留 30 天，期间可恢复。
- 已完成任务可永久删除；处理中任务不允许永久删除，避免后台写入产生孤儿文件。

## 📂 数据存储

所有数据存储在：`~/Documents/抖音AI视频/`

```
抖音AI视频/
├── raw/                    # 原始数据
│   ├── videos/            # 下载的视频
│   ├── audio/             # 提取的音频
│   ├── transcripts/       # 结构化转录 JSON
│   └── page/              # 页面元数据
│
├── processed/             # 处理结果
│   ├── scripts/           # 脚本资产
│   ├── cleaned/           # 清洗后内容
│   └── scenes/            # 场景数据
│
└── output/                # 最终输出
    ├── ppt/               # PPTX 输出
    └── videos/            # HyperFrames 项目和 MP4
```

## 🔧 故障排查

### 视频下载失败
- 开发模式确认已安装 yt-dlp；安装包确认 `resources/bin/yt-dlp` 或 `resources/bin/yt-dlp.exe` 存在
- 检查网络连接
- 验证抖音链接格式

### 转录功能不工作
- 确认打包前已经运行 `npm run prepare:whisper`
- 确认安装包内存在 `resources/whisper/whisper-cli` 和 `resources/whisper/models/ggml-small.bin`
- 开发模式下确认 `vendor/whisper/whisper-cli` 和 `vendor/whisper/models/ggml-small.bin` 存在
- 查看 `raw/transcripts/` 目录是否有文件生成
- 查看任务详情页 ASR 步骤的错误信息

### 视频生成失败
- 开发模式确认当前 Node.js 版本 >= 22：`node -v`
- 开发模式确认 FFmpeg 和 HyperFrames 可用：`ffmpeg -version`、`npx --yes hyperframes@0.7.48 doctor`
- 安装包确认 `resources/hyperframes/node_modules/hyperframes/dist/cli.js` 和 `resources/browser/.../chrome-headless-shell` 存在
- 如果在生成项目目录内手动排查，优先使用项目脚本 `npm run check` / `npm run render`，或使用固定包版本的 `npx --yes hyperframes@0.7.48 ...`
- 新版本会在任务错误详情里展示失败命令、stdout 和 stderr；若只看到 `Command failed with exit code 1`，请先更新到最新代码后重试
- 查看任务详情页“生成视频”步骤的错误信息
- 渲染成功后，MP4 位于 `output/videos/{jobId}/hyperframes/renders/video.mp4`

### 前端无法连接后端
- Electron 内嵌后端使用随机本地端口，前端通过 `window.electron.getServerPort()` 获取
- 开发模式下确认 `npm run dev` 正在运行
- 检查防火墙设置

## 🗺️ 开发路线图

### 已完成 ✅
- [x] Electron 桌面应用框架
- [x] 视频下载和音频提取
- [x] 内置 whisper.cpp 本地转录
- [x] AI 内容清洗
- [x] 基于清洗稿生成 PPT 内容和 PPTX
- [x] HyperFrames 本地竖屏视频生成
- [x] 手动分步执行和步骤级自动重试
- [x] 任务垃圾桶和 30 天保留
- [x] 多 AI 模型支持
- [x] 设置页面（API Key 管理）
- [x] 任务详情页面

### 进行中 🚧
- [ ] Whisper 模型体积和速度优化
- [ ] 视频视觉样式优化
- [ ] 视频 TTS 配音和 BGM 支持

### 计划中 📋
- [ ] 批量任务导入
- [ ] 导出为 Markdown/Word
- [ ] 自定义 AI 提示词模板
- [ ] 任务历史搜索

## 🤝 贡献指南

欢迎提交 Issue 和 Pull Request！

### 开发规范
- 遵循 TypeScript 严格模式
- 提交信息遵循 Conventional Commits
- 代码格式化使用 ESLint + Prettier

### 提交规范
- `feat:` - 新功能
- `fix:` - Bug 修复
- `docs:` - 文档更新
- `refactor:` - 重构
- `style:` - 代码格式
- `test:` - 测试

## 📄 许可证

MIT License

## 👨‍💻 维护者

[@LiChangZheng10086](https://github.com/LiChangZheng10086)

---

**最后更新**: 2026-07-10
**仓库**: https://github.com/LiChangZheng10086/doyin_ai_video.git
