# 抖音 AI 视频助手

> 基于 Electron 的桌面应用，从抖音视频链接或分享文本生成视频转录、AI 洗稿内容和 PPT

一个面向内容复盘和二次创作的本地桌面工具。当前主链路聚焦为：下载视频、提取音频、ASR 转文案、AI 洗稿、生成 PPT。暂不做视频生成；历史视频提示词能力保留兼容，但不作为新任务的主流程入口。

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
  2️⃣ 提取音频（ffmpeg）
  3️⃣ ASR 转文案（OpenAI Whisper / 本地 Whisper / 本地 FunASR）
  4️⃣ AI 洗稿
  5️⃣ 生成 PPT 内容和 PPTX
  ↓
输出：📝 结构化转录 + ✍️ 清洗稿 + 📊 PPT
```

每个步骤都有明确状态：`pending | running | succeeded | failed`。用户点击某一步后，后端会在该请求内自动重试最多 3 次；失败后停在当前步骤，用户可手动重试。

### 功能特性

- ✅ **视频下载** - 支持抖音链接解析和视频下载
- ✅ **音频提取** - 使用 ffmpeg 抽取标准化音频，并保存音频 manifest
- ✅ **语音转录** - 支持 OpenAI Whisper API、本地 faster-whisper、本地 FunASR
- ✅ **本地 FunASR** - 中文推荐方案，无需第三方 ASR API Key
- ✅ **AI 洗稿** - 基于转录优先清洗，输出标题、摘要、要点、清洗稿、口播稿和质量提示
- ✅ **PPT 生成** - 基于清洗稿生成结构化 PPT 内容和 `.pptx`
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
- **主链路步骤** - 下载视频、提取音频、ASR 转文案、AI 洗稿、生成 PPT
- **视频转录** - 从视频音频提取的真实转录文字
- **AI 洗稿** - 清洗后的标题、摘要、核心要点、脚本、口播稿和质量提示
- **PPT 内容** - 生成的 PPT 预览和下载

### 设置页面
- **AI 密钥管理** - 管理多个 AI 服务 API Key
- **语音识别配置** - 选择 OpenAI Whisper、本地 Whisper 或本地 FunASR

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
└─────────────────┘          └──────────────────┘
                                      │
                      ┌───────────────┴───────────────┐
                      ▼                               ▼
             ┌─────────────────┐             ┌────────────┐
             │ AI / ASR 服务    │             │ 文件存储    │
             │ - DeepSeek      │             │            │
             │ - OpenAI        │             │ ~/Documents│
             │ - 本地 FunASR   │             │ /抖音AI视频 │
             │ - 本地 Whisper  │             └────────────┘
             └─────────────────┘
```

## 技术栈

### 后端
- **运行时**: Node.js 18+
- **框架**: Express 4
- **语言**: TypeScript 5.x
- **视频处理**: yt-dlp, ffmpeg
- **AI 服务**: OpenAI SDK（兼容 DeepSeek / OpenAI-compatible）
- **ASR**: OpenAI Whisper API、本地 faster-whisper、本地 FunASR（Python 可选依赖）

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
- yt-dlp、ffmpeg（视频下载和音频提取需要）

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
# 构建前端
npm run build:renderer

# 构建 Electron 主进程
npm run build:electron

# 构建后端
npm run build:backend

# 打包应用
npm run package        # 当前平台
npm run package:mac    # macOS
npm run package:win    # Windows
```

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

配置语音识别服务以获得视频的真实转录：

**本地 FunASR（中文推荐，无需 ASR API Key）**
- 设置页选择：`本地 FunASR（中文推荐，无需 API Key）`
- 默认模型：`paraformer-zh`
- 默认 VAD：`fsmn-vad`
- 默认标点恢复：`ct-punc`
- 依赖：Python 3.8+、`torch`、`torchaudio`、`funasr`

```bash
pip install torch torchaudio funasr
```

首次运行可能需要下载模型；模型缓存完成后可本地执行转录。

**OpenAI Whisper API**
- API Key: 与 OpenAI API Key 相同
- 模型: whisper-1
- 准确度高，支持多语言

**本地 Whisper**
- 设置页选择：`本地 Whisper（需要 Python）`
- 需要在 ASR Python 环境中安装 faster-whisper
- 适合已经有本地 Whisper 环境的用户

未配置时，系统将使用分享文本作为后备。

配置文件示例：

```json
{
  "asrProvider": "funasr",
  "asrModel": "paraformer-zh"
}
```

### 3. 外部依赖

系统会自动使用以下工具（需提前安装）：

- **yt-dlp** - 视频下载
  ```bash
  brew install yt-dlp  # macOS
  ```

- **ffmpeg** - 音视频处理
  ```bash
  brew install ffmpeg  # macOS
  ```

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
  - PPT 大纲建议
  - 质量提示

- **PPT 内容** - 查看生成的幻灯片结构并下载 `.pptx`

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
    └── ppt/               # 生成的 PPT
```

## 🔧 故障排查

### 视频下载失败
- 确认已安装 yt-dlp
- 检查网络连接
- 验证抖音链接格式

### 转录功能不工作
- 设置页确认 ASR provider 是否正确：
  - FunASR：确认当前 Python 环境已安装 `torch`、`torchaudio`、`funasr`
  - OpenAI Whisper API：确认 ASR API Key、Base URL 和模型正确
  - 本地 Whisper：确认 `faster-whisper` 已安装
- 首次使用 FunASR 时，确认网络可访问模型下载源，并预留足够磁盘空间
- 查看 `raw/transcripts/` 目录是否有文件生成
- 查看任务详情页 ASR 步骤的错误信息

### 前端无法连接后端
- Electron 内嵌后端使用随机本地端口，前端通过 `window.electron.getServerPort()` 获取
- 开发模式下确认 `npm run dev` 正在运行
- 检查防火墙设置

## 🗺️ 开发路线图

### 已完成 ✅
- [x] Electron 桌面应用框架
- [x] 视频下载和音频提取
- [x] 语音转录集成（OpenAI Whisper API）
- [x] 本地 FunASR 中文转录
- [x] 本地 Whisper 转录入口
- [x] AI 内容清洗
- [x] 基于清洗稿生成 PPT 内容和 PPTX
- [x] 手动分步执行和步骤级自动重试
- [x] 任务垃圾桶和 30 天保留
- [x] 多 AI 模型支持
- [x] 设置页面（API Key 管理）
- [x] 任务详情页面

### 进行中 🚧
- [ ] 本地 ASR 安装体验优化
- [ ] PPT 模板和视觉样式优化

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

**最后更新**: 2026-07-02
**仓库**: https://github.com/LiChangZheng10086/doyin_ai_video.git
