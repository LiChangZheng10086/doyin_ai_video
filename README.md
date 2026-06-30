# 🎬 抖音 AI 视频助手

> 基于 Electron 的桌面应用，从抖音视频链接或分享文本生成 AI 洗稿内容、视频提示词和 PPT

一个完整的 AI 驱动的抖音视频内容处理工具，支持视频下载、语音转录、AI 内容清洗、视频场景增强和 PPT 自动生成。

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)
![Electron](https://img.shields.io/badge/electron-34.x-blue.svg)
![React](https://img.shields.io/badge/react-19.x-blue.svg)

## ✨ 核心功能

### 🎯 一键处理流程

```
输入：抖音分享链接 / 分享文本
  ↓
自动处理：
  1️⃣ 下载视频（yt-dlp）
  2️⃣ 提取音频（ffmpeg）
  3️⃣ 语音转录（Whisper API，可选）
  4️⃣ AI 内容清洗
  5️⃣ 生成视频提示词
  6️⃣ 生成 PPT（计划中）
  ↓
输出：📝 洗稿脚本 + 🎬 视频提示词 + 📊 PPT
```

### 🌟 功能特性

- ✅ **视频下载** - 支持抖音链接解析和视频下载
- ✅ **语音转录** - 可选配置 OpenAI Whisper API 进行视频音频转文字
- ✅ **AI 洗稿** - 智能清洗视频内容，提取核心要点
- ✅ **视频提示词** - 为每个场景生成专业的 AI 视频生成提示词
- ✅ **PPT 生成** - 自动生成结构化演示文稿（开发中）
- ✅ **多 AI 模型** - 支持 DeepSeek、OpenAI 等多种 AI 服务
- ✅ **桌面应用** - 基于 Electron，支持 macOS 和 Windows
- ✅ **实时反馈** - 任务进度实时更新，详细展示每个处理阶段

## 🖥️ 界面预览

### 主界面 - 任务列表
- 创建新任务（URL 或分享文本）
- 查看所有任务状态
- 实时显示处理进度

### 任务详情页
- **概览** - 任务基本信息和处理状态
- **视频转录** - 从视频音频提取的真实转录文字
- **AI 洗稿** - 清洗后的脚本内容和标签
- **视频提示词** - AI 生成的视频场景提示词
- **PPT 内容** - 生成的 PPT 预览和下载

### 设置页面
- **AI 密钥管理** - 管理多个 AI 服务 API Key
- **语音识别配置** - 配置 OpenAI Whisper API 用于视频转录

## 🏗️ 技术架构

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
└─────────────────┘          └──────────────────┘
                                      │
                             ┌────────┴────────┐
                             ▼                 ▼
                    ┌─────────────┐    ┌────────────┐
                    │   AI APIs   │    │ 文件存储    │
                    │             │    │            │
                    │ - DeepSeek  │    │ ~/Documents│
                    │ - OpenAI    │    │ /抖音AI视频 │
                    └─────────────┘    └────────────┘
```

## 🛠️ 技术栈

### 后端
- **运行时**: Node.js 18+
- **框架**: Express 4
- **语言**: TypeScript 5.x
- **视频处理**: yt-dlp, ffmpeg
- **AI 服务**: OpenAI SDK（兼容 DeepSeek）

### 前端
- **框架**: React 19
- **构建**: Vite 6
- **路由**: React Router DOM 7
- **状态管理**: Zustand 5
- **样式**: Tailwind CSS（自定义设计系统）

### 桌面端
- **框架**: Electron 34
- **打包**: electron-builder

## 📦 安装与运行

### 环境要求

- Node.js >= 18.0.0
- npm >= 9.0.0
- macOS 或 Windows

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
# 启动后端服务（端口 59380）
npm run dev:server

# 启动前端开发服务器
npm run dev:renderer

# 启动 Electron
npm run dev:electron
```

### 生产构建

```bash
# 构建后端
npm run build:server

# 构建前端
npm run build:renderer

# 打包应用
npm run package        # 当前平台
npm run package:mac    # macOS
npm run package:win    # Windows
```

## ⚙️ 配置说明

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

### 2. 语音转录配置（可选）

配置语音识别服务以获得视频的真实转录：

**OpenAI Whisper API**（推荐）
- API Key: 与 OpenAI API Key 相同
- 模型: whisper-1
- 准确度高，支持多语言

未配置时，系统将使用分享文本作为后备。

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
4. 点击"开始处理"

### 查看结果

任务完成后，点击查看详情：

- **视频转录** - 查看视频音频的真实转录文字
  - ⚠️ 需要配置 ASR 才能看到真实转录
  - 未配置时显示分享文本
  
- **AI 洗稿** - 查看清洗后的脚本
  - 标题
  - 清洗后的完整脚本
  - 标签列表

- **视频提示词** - 查看生成的视频场景提示词
  - 每个场景一个提示词
  - 包含画面描述、运镜、风格等

## 📂 数据存储

所有数据存储在：`~/Documents/抖音AI视频/`

```
抖音AI视频/
├── raw/                    # 原始数据
│   ├── videos/            # 下载的视频
│   ├── audio/             # 提取的音频
│   ├── transcripts/       # 转录文本
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
- 检查是否配置了 ASR API Key（设置页面）
- 验证 API Key 有效性
- 查看 `raw/transcripts/` 目录是否有文件生成

### 前端无法连接后端
- 确认后端服务正在运行（端口 59380）
- 检查防火墙设置

## 🗺️ 开发路线图

### 已完成 ✅
- [x] Electron 桌面应用框架
- [x] 视频下载和音频提取
- [x] 语音转录集成（Whisper API）
- [x] AI 内容清洗
- [x] 视频提示词生成
- [x] 多 AI 模型支持
- [x] 设置页面（API Key 管理）
- [x] 任务详情页面

### 进行中 🚧
- [ ] PPT 生成功能
- [ ] 本地 Whisper 支持

### 计划中 📋
- [ ] 批量任务导入
- [ ] 导出为 Markdown/Word
- [ ] 自定义 AI 提示词模板
- [ ] 任务历史搜索
- [ ] 视频预览功能

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

**最后更新**: 2026-06-30  
**仓库**: https://github.com/LiChangZheng10086/doyin_ai_video.git
