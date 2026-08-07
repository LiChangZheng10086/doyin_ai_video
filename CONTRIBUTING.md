# 贡献指南

感谢你对抖创工坊的关注！这份指南会帮助你快速上手开发。

## 📋 目录

- [行为准则](#行为准则)
- [环境搭建](#环境搭建)
- [项目结构概览](#项目结构概览)
- [开发流程](#开发流程)
- [从哪些模块入手](#从哪些模块入手)
- [代码规范](#代码规范)
- [提交规范](#提交规范)
- [PR 流程](#pr-流程)
- [调试技巧](#调试技巧)
- [急需帮助的方向](#急需帮助的方向)

## 行为准则

- 保持友善和尊重
- 讨论聚焦技术问题
- 提交前确保代码通过类型检查
- 新增功能需要同时更新相关文档

## 环境搭建

### 基础要求

- **Node.js** >= 18.0.0（推荐 20+；视频生成步骤需要 22+）
- **npm** >= 9.0.0
- **macOS** 或 **Windows**（目前主要在 macOS arm64 上开发和测试）
- 开发模式需要以下工具可用（打包后应用自带）：
  - `ffmpeg` / `ffprobe`
  - `yt-dlp`
  - Playwright Chromium（用户主页爬取、扫码登录）

### 快速启动

```bash
# 克隆仓库
git clone https://github.com/LiChangZheng10086/doyin_ai_video.git
cd doyin_ai_video

# 安装依赖
npm install

# 安装 Playwright 浏览器
npx playwright install chromium

# 准备 Whisper 资源（语音转录功能需要）
npm run prepare:whisper

# 启动开发模式
npm run dev
```

### 可选工具

```bash
# 视频生成步骤需要（可选功能）
brew install ffmpeg  # macOS，已随打包内置

# HyperFrames 环境检查
npx --yes hyperframes doctor
```

## 项目结构概览

```
douyin/
├── src/                          # 后端（Express + TypeScript）
│   ├── server.ts                # HTTP 服务器入口
│   ├── app.ts                   # Express 应用配置
│   └── lib/                     # 核心业务逻辑
│       ├── jobs.ts              # 任务管理、CRUD、垃圾桶
│       ├── ai-cleaner.ts        # AI 洗稿（OpenAI-compatible API）
│       ├── media.ts             # 视频下载（yt-dlp）、音频提取（ffmpeg）
│       ├── asr.ts               # 语音转录（内置 whisper.cpp）
│       ├── storage.ts           # 文件存储管理
│       ├── config-server.ts     # 用户配置读写
│       └── hyperframes-video.ts # HyperFrames 本地视频渲染
│
├── renderer/                     # 前端（React + Vite + Tailwind）
│   └── src/
│       ├── App.tsx              # 路由和布局
│       ├── pages/               # 页面组件
│       │   ├── JobListPage.tsx   # 任务列表 & 合集
│       │   ├── JobDetailPage.tsx # 任务详情
│       │   ├── TrashPage.tsx     # 垃圾桶
│       │   └── SettingsPage.tsx  # 设置
│       ├── components/          # 可复用组件
│       ├── services/api.ts      # 前端 API 调用
│       └── types/index.ts       # 前端类型定义
│
├── electron/                     # Electron 主进程
│   ├── main.ts                  # 窗口管理、后端生命周期
│   └── handlers/                # IPC 处理器
│       └── config-handler.ts    # 配置读写（含加密）
│
├── scripts/                      # 构建和准备脚本
│   ├── prepare-whisper.mjs      # 下载/编译 whisper.cpp
│   ├── prepare-package-assets.mjs # 准备打包资源
│   └── check-package-assets.mjs # 打包资源校验
│
└── dist/                         # 编译输出（TypeScript → JS）
```

### 关键数据流

```
用户输入 URL → 创建 JobRecord
  → 视频下载（页面解析 → 签名API → yt-dlp 多策略降级）
  → 音频提取（ffmpeg: pcm_s16le, 16kHz, mono WAV）
  → ASR 转录（whisper.cpp ggml-small）
  → AI 洗稿（DeepSeek/OpenAI/中转API）
  → 分镜生成（AI 生成视频提示词）
  → 视频渲染（HyperFrames: HTML/CSS/GSAP → MP4）
```

## 开发流程

```bash
# 启动完整开发环境（Vite + Electron）
npm run dev

# 仅启动前端开发服务器
npm run dev:renderer

# 构建 Electron 后启动桌面应用
npm run dev:electron

# 运行测试
npm test

# 类型检查
npm run check
```

### 常用命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动 Vite + Electron（开发模式） |
| `npm test` | 运行所有测试（tsx + Node 内置 test runner） |
| `npm run check` | 后端 TypeScript 类型检查 |
| `npm run build:backend` | 编译后端 |
| `npm run build:renderer` | 构建前端 |
| `npm run build:electron` | 编译 Electron 主进程 |
| `npm run prepare:whisper` | 准备 whisper.cpp 和 ggml-small 模型 |
| `npm run package:mac` | 打包 macOS 应用（DMG + ZIP） |

## 从哪些模块入手

根据你的兴趣选择切入点：

### 🟢 入门级（无需深入理解业务逻辑）

- **前端 UI 改进** — `renderer/src/components/` 和 `renderer/src/pages/`
  - 优化表单交互、加载状态、错误展示
  - 改进移动端 / 小窗口布局
  - 添加暗色模式支持
- **错误消息完善** — 在后端各步骤中改善用户可见的错误信息
- **文档更新** — README、代码注释、JSDoc

### 🟡 中级（需要了解某个子系统）

- **AI 提示词优化** — `src/lib/ai-cleaner.ts`
  - 调整洗稿、分镜生成的 system prompt
  - 添加自定义提示词模板功能
- **视频下载策略** — `src/lib/media.ts`
  - 优化多策略降级逻辑
  - 增加新的视频源支持
- **配置管理** — `electron/handlers/config-handler.ts`
  - 改善配置 UI 和校验逻辑

### 🔴 进阶（需要深入理解整体架构）

- **Whisper 模型优化** — `src/lib/asr.ts`
  - 尝试不同大小的 ggml 模型
  - 中文转录准确率优化
  - 流式转录支持
- **抖音签名算法** — 项目内 a_bogus / X-Bogus 实现
  - 签名逻辑稳定性维护
  - 新签名参数适配
- **HyperFrames 视频模板** — `src/lib/hyperframes-video.ts`
  - 设计新的视频样式和动画
  - TTS 配音集成
  - BGM 和音效支持
- **Windows 平台适配** — 路径处理、二进制兼容、安装包测试

## 代码规范

### TypeScript

- 使用严格模式（`strict: true`）
- 优先使用 `interface` 而非 `type`（对象类型）
- 后端类型定义集中在 `src/types.ts`
- 前端类型定义集中在 `renderer/src/types/index.ts`
- 避免 `any`，使用 `unknown` 或具体类型

### React

- 函数组件 + Hooks，不使用 Class 组件
- 状态管理使用 Zustand
- 样式使用 Tailwind CSS utility class
- 组件文件放在 `renderer/src/components/`，页面放在 `pages/`

### 后端

- Express 路由注册在 `src/app.ts`
- 业务逻辑放在 `src/lib/` 下对应模块
- 文件 I/O 通过 `src/lib/storage.ts` 统一管理
- 配置通过 `src/lib/config-server.ts` 读取

### 命名约定

- 文件：kebab-case（`ai-cleaner.ts`, `job-list-page.tsx`）
- 函数/变量：camelCase（`extractAudio`, `jobRecord`）
- 类型/接口：PascalCase（`JobRecord`, `PipelineStep`）
- 常量：UPPER_SNAKE_CASE（`MAX_RETRY_COUNT`）

## 提交规范

本项目使用 [Conventional Commits](https://www.conventionalcommits.org/)：

```
<type>: <简短描述>

feat: 添加批量任务导入功能
fix: 修复视频下载 403 错误
docs: 更新 README 安装说明
refactor: 提取签名算法到独立模块
style: 统一按钮圆角样式
test: 添加音频提取单元测试
chore: 升级依赖版本
```

## PR 流程

1. **Fork 仓库** 并创建功能分支
   ```bash
   git checkout -b feat/my-feature
   ```

2. **开发和测试**
   ```bash
   npm run check        # 类型检查必须通过
   npm test             # 运行测试
   ```

3. **提交代码**（遵循 Conventional Commits）

4. **推送并创建 PR**
   - 描述清楚做了什么、为什么这样做
   - 如果是 UI 改动，附上截图
   - 关联相关 Issue（`Closes #123`）

5. **Code Review**
   - 保持 PR 小而聚焦（尽量 < 500 行改动）
   - 一个 PR 只做一件事
   - 响应 Review 意见，及时修改

## 调试技巧

### 后端调试

```bash
# 查看后端日志
# 开发模式下后端运行在 Electron 内嵌进程中
# 日志输出到终端和控制台

# 单独启动后端（用于调试 API）
npm run build:backend && node dist/server.js
```

### 前端调试

- 开发模式下打开浏览器 DevTools（Electron: `Cmd+Option+I`）
- React 组件使用 React DevTools
- 网络请求在 DevTools Network 标签查看

### 数据目录

- 配置文件：`~/.douyin-ai-video/config.json`
- 数据存储：`~/.douyin-ai-video/storage/`
- 日志：`~/.douyin-ai-video/storage/logs/`

## 急需帮助的方向

以下方向目前特别需要贡献者：

| 方向 | 难度 | 说明 |
|------|------|------|
| 抖音签名稳定性维护 | 🔴 高 | a_bogus / X-Bogus 算法随抖音更新需要适配 |
| Whisper 模型优化 | 🟡 中 | 模型体积与中文准确率的平衡 |
| TTS 配音集成 | 🟡 中 | 为 HyperFrames 视频生成配音 |
| 视频模板/样式设计 | 🟡 中 | 新的 HyperFrames 动画模板 |
| UI/UX 改进 | 🟢 低 | 交互优化、暗色模式、响应式布局 |
| Windows 打包测试 | 🟡 中 | 确认 Windows 11 打包和运行正常 |
| 单元测试覆盖 | 🟢 低 | 为核心模块补充测试用例 |
| 文档完善 | 🟢 低 | 使用指南、API 文档、示例视频 |

如果你对某个方向感兴趣但不知如何开始，欢迎在 [Issues](https://github.com/LiChangZheng10086/doyin_ai_video/issues) 中提出，或创建 [Discussion](https://github.com/LiChangZheng10086/doyin_ai_video/discussions) 进行讨论。

---

感谢你的贡献！🎉
