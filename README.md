# 抖创工坊

> 抖音视频采集 → 转录 → AI 洗稿 → 视频生成，并把内容**自动发布到抖音（图文）与今日头条（文章）**

## 🚀 两条自动发布通路（核心能力）

**抖音图文**与**今日头条文章**都能由本机浏览器自动提交到平台 —— 各自带包级预览、逐字段字数校验与发布选项，提交前必经确认：

| 通路 | 引擎 | 登录方式 | 关键约束 |
| --- | --- | --- | --- |
| **抖音图文** | 外部 `social-auto-upload` CLI（可选装） | 复用已有抖音登录态 | 一次只允许一个任务；不自动重试 |
| **今日头条文章** | **自研执行器**（Playwright，复用打包好的 headless Chromium） | 扫码（应用内二维码 / 浏览器窗口） | AI 成文 + 16:9 封面；封面必填 |

两条通路共同的纪律：**每一步都读回校验**（任何一步失败都停在点「发布」之前并写明停在哪一步）；**提交后只记「已提交」**，是否真的发出由人工到平台后台核实后点「标记已发布」；**绝不自动重试**（重试前必须先确认上一次是否已发出 —— 重复发布是最大的风险）。**视频与其余平台（小红书 / 视频号 / B 站）仍以人工交付为主**。

发布中心按渠道分栏（抖音图文 / 今日头条文章 / 视频人工交付），三个渠道各自独立，不会混在一起看。

## 能力概览

一个面向内容复盘和二次创作的本地桌面工具。当前主链路聚焦为：下载视频、提取音频、内置 Whisper 转录、AI 洗稿、生成视频分镜，并可选使用 HyperFrames 本地渲染 9:16 MP4。支持**用户主页批量采集**、**签名 API 直调**、**无水印视频下载**、**合集增量更新**，新任务采用手动分步执行，每一步都支持自动 3 次重试和失败后的手动重试。

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)
![Electron](https://img.shields.io/badge/electron-34.x-blue.svg)
![React](https://img.shields.io/badge/react-19.x-blue.svg)

> ⚠️ **免责声明**：本项目仅供学习和技术研究使用。使用者应遵守相关平台的服务条款和法律法规，不得将本项目用于任何商业用途或侵犯第三方权益。作者不对使用本项目产生的任何后果承担责任。

## 🤝 寻找贡献者

本项目目前由个人维护，欢迎一起完善！

**当前特别需要帮助的方向：**
- 抖音签名（a_bogus / X-Bogus）稳定性维护
- Whisper 模型体积与中文准确率优化
- HyperFrames 视频样式 / TTS 配音
- UI/UX 改进与 Windows 打包测试
- 文档、测试用例、示例视频

→ [查看贡献指南](CONTRIBUTING.md) | [提交 Issue](https://github.com/LiChangZheng10086/doyin_ai_video/issues) | [讨论区](https://github.com/LiChangZheng10086/doyin_ai_video/discussions)

## 核心功能

### 手动分步流程

```
输入：抖音分享链接 / 分享文本 / 用户主页链接
  ↓
创建任务 / 合集：解析并保存输入，不自动跑完整链路
  ↓
用户逐步确认执行：
  1️⃣ 下载视频（无水印优先 → 签名 API → yt-dlp）
  2️⃣ 提取音频（ffmpeg → 16kHz mono WAV）
  3️⃣ ASR 转文案（内置 whisper.cpp）
  4️⃣ AI 洗稿
  5️⃣ 生成视频提示词 / 分镜
  6️⃣ 生成本地竖屏视频（可选，HyperFrames）
  7️⃣ 发布中心交付（可选；抖音图文 / 今日头条文章可自动提交，提交后人工核实）
  ↓
输出：📝 结构化转录 + ✍️ 清洗稿 + 🎬 MP4 + 📦 发布交付包
```

### 功能特性

- ✅ **视频下载** — 无水印优先下载，支持签名 API 和 yt-dlp 多策略降级
- ✅ **用户主页采集** — 输入博主主页链接，批量获取全部作品列表
- ✅ **合集管理** — 按博主创建合集，批量创建子任务、批量执行步骤
- ✅ **合集增量更新** — 一键检查博主新视频，去重追加到已有合集
- ✅ **签名 API 直调** — a_bogus + X-Bogus 签名，绕过浏览器直接调用抖音内部 API
- ✅ **Cookie 管理** — 支持扫码登录、手动粘贴 Cookie 两种方式获取登录态
- ✅ **音频提取** — 使用 ffmpeg 抽取标准化音频，并保存音频 manifest
- ✅ **语音转录** — 内置 whisper.cpp + ggml-small，本机完成中文转录
- ✅ **离线 ASR** — 无需 ASR API Key、Python、FunASR 或 faster-whisper
- ✅ **AI 洗稿** — 基于转录优先清洗，输出标题、摘要、要点、清洗稿、口播稿和质量提示
- ✅ **视频分镜生成** — 基于清洗稿生成视频提示词和分镜脚本
- ✅ **Skill 知识蒸馏** — 从合集转录文本 AI 蒸馏生成 Claude Code Skill（SKILL.md）
- ✅ **Skill 管理** — 独立的 Skill 管理页面，支持查看、重命名、删除已生成的 Skill
- ✅ **本地视频生成** — 使用 HyperFrames CLI 将清洗稿和字幕节奏渲染为 9:16 MP4
- ✅ **原视频回看** — 详情页可在「原视频 / 成片」之间切换，直接回看转录时下载的抖音原片
- ✅ **素材库** — 独立「素材」页面，手动上传与管理图片、音频（图片可选入图文发布）
- ✅ **发布中心** — 将成片整理为独立交付包，生成四平台简体中文文案；按渠道分栏，标注进度与人工发布跟踪
- ✅ **今日头条文章发布** — AI 成文 + 16:9 封面 + 扫码登录，自动提交到头条号（提交前必经预览，提交后由人工核实再「标记已发布」）。**2026-09-20 真机实测发布成功**
- ✅ **可折叠侧栏** — 桌面端左侧导航可展开/收起，展开时显示文字标签，收起为纯图标
- ✅ **任务垃圾桶** — 删除任务后保留 30 天，可恢复或永久删除
- ✅ **多 AI 模型** — 支持 DeepSeek、OpenAI 及 OpenAI-compatible 中转服务
- ✅ **桌面应用** — 基于 Electron，支持 macOS 和 Windows
- ✅ **实时反馈** — 任务进度实时更新，详细展示每个步骤状态和错误

## 本机操作者与权限

- 面向使用者的**登录、账号切换、用户管理界面已移除**：应用启动时自动取得「本机操作者」会话，无需登录或选择账号。
- 自动会话优先复用已有的启用中管理员（按 `createdAt` / `id` 升序确定性选取）；只有在**不存在任何管理员**时才创建一个无 PIN 的「本机用户」。不会删除、不改名任何历史用户。
- 管理员 PIN 的**接口契约没有被放宽**：直接调用 `POST /api/local-sessions` 开管理员会话仍必须提供正确 PIN。无 PIN 分支只存在于 `POST /api/local-sessions/auto` 这一条显式命名的路径上。
- 角色仍然决定**发布权限与审计**：撤回已发布状态、删除/恢复发布包属于管理员操作；每条审计记录仍带 `actor` 快照。单机使用下当前操作者即管理员，因此这些操作都可用。
- 本地角色用于工作流权限控制和操作者审计，不是云端账号，也不是强安全边界；能够访问本机存储或操作系统账户的人仍可能读取或修改本地数据。

## 发布中心

- 发布中心默认只准备本地交付包和辅助人工操作。**视频不会自动上传**；**抖音图文**可选地调用外部
  `social-auto-upload`（`sau`）CLI 自动提交，且**提交前必经预览确认**、提交后仍由人工点「标记已发布」确认。
- **今日头条文章**走另一条通路：自研 Playwright 执行器（复用打包好的 `chrome-headless-shell`，零额外下载），
  按「洗稿内容 → AI 成文 → 文章包（`article.html` + 16:9 封面）→ 预览 → 提交」完成发布。
  **登录只能扫码**（头条号没有可粘贴的凭据）：到「设置 → 今日头条」点「扫码登录」（应用内显示二维码）
  或「打开浏览器扫码登录」（弹出真实浏览器窗口）；登录态保存在 storage 内的持久化 profile，
  扫一次之后发布与自检都不用再扫。相关环境变量：`TOUTIAO_BROWSER_BINARY`（浏览器路径，
  缺省按「显式配置 → 打包资源 → Playwright 缓存 → 系统 Chrome」解析）、`TOUTIAO_PROFILE_DIR`（会话目录，必须落在 storage 内）。
  **每一步都有读回校验**：任何一步失败都停在点「发布」之前；「同时发布微头条」默认关闭且关不掉就不发布。
- 与抖音通路同一条不变式：机器只把内容**送出去**，记录为「已提交」；`task.status` 全程不变，
  也**绝不**自动重试（重试前必须先确认上一次是否已发出 —— 重复发布是本功能最大的风险）。
- 发布中心自身不保存平台凭据；走图文自动发布时，会把已有的抖音登录态（`~/.douyin-ai-video/douyin-cookie.txt`）
  转换成 Playwright `storage_state` 写到 `<SAU_BASE_DIR>/cookies/douyin_<account>.json`（权限 600）供外部引擎使用。
- 从任务详情页的已生成成片进入「加入发布中心」，按“成片 → 平台 → 文案 → 排期 → 确认”向导创建交付包。
- 支持抖音、小红书、微信视频号和哔哩哔哩；一个交付包可包含多个平台任务，也可以为同一成片创建独立版本。
- 文案优先由当前 AI 配置按平台生成；AI 不可用时回退到洗稿内容，并明确标记为回退文案。用户编辑后的内容会记录为用户编辑。
- **按渠道分栏**：一级页签「抖音图文 / 今日头条文章 / 视频人工交付」——三者的提交方式完全不同
  （前两个自动提交、第三个纯人工交付），各自带包数与说明，渠道与状态都记在 URL 里（`?channel=`）。
  抖音图文与头条文章只有一个平台，因此这两个渠道不显示平台下拉。
- 发布中心提供复制标题/正文/标签、打开平台、在 Finder 中定位视频、标记已发布、记录失败和修改排期等人工辅助操作。
- 发布者可维护未发布内容；管理员额外负责撤回已发布状态和发布垃圾桶管理。
- 发布包存放在 **storage 根目录**下的 `output/publishing/{sourceJobId}/v{version}-{packageId}/`。storage 根目录取决于运行方式：桌面端为 `~/Library/Application Support/douyin-ai-video/storage`（macOS），独立后端为仓库内的 `storage/`。
- 发布包是**自包含**的：成片、封面与图文图片都会复制进包目录，因此事后删除素材或改动源文件不影响已建好的包。
- 发布排期仅在应用运行时检查；应用退出期间到期的任务会在下次启动时补处理，但不会自动打开平台。
- 发布垃圾桶独立于任务垃圾桶，保留 30 天。到期清理只删除本地发布资产，不影响源作品、其他版本或平台上的视频。
- 若 `cache/publishing-index.json` 损坏，发布写操作会进入只读保护。请先备份原文件，再从有效备份恢复或人工修复；创作流程仍可继续使用。

## 界面预览

### 主界面 - 任务列表 & 合集
- 创建新任务（URL / 主页链接 / 分享文本）
- 合集视图：按博主聚合查看所有子任务进度
- 查看所有任务状态
- 查看当前可执行步骤或失败步骤
- 删除任务到应用内垃圾桶

### 任务详情页
- **概览** — 任务基本信息和处理状态
- **主链路步骤** — 下载、提取音频、ASR 转录、AI 洗稿、生成分镜、生成视频
- **视频转录** — 从视频音频提取的真实转录文字
- **AI 洗稿** — 清洗后的标题、摘要、核心要点、脚本、口播稿和质量提示
- **分镜内容** — 基于清洗稿生成的短剧分镜和视频提示词
- **视频成片** — HyperFrames 本地渲染的 MP4、项目路径和场景列表

### 合集详情页
- 顶部用户信息（昵称、头像、作品总数）+ "检查更新" 按钮
- 视频列表（封面、描述、状态、复选框），按发布时间倒序排列
- 批量操作：创建选中任务、批量转录、批量洗稿、批量分镜、批量生成视频
- 子任务总进度条
- 查看全部转录文本 + "生成 Skill" 按钮

### Skill 管理页
- 卡片式网格布局，展示所有已生成的 Skill
- 每张卡片显示：Skill 名称、来源合集、自动同步状态、转录数量、生成日期
- 操作：查看内容（3 标签页：SKILL.md 渲染、原始来源、元信息 JSON ）、在合集页面中复用
- 支持内联重命名，自动同步 SKILL.md frontmatter 和文件目录

### 发布中心
- 查看待处理、待发布、已排期、已发布、失败、资产异常和发布垃圾桶
- 按标题/文案、平台、源任务、版本号和创建者筛选
- 展开发布包查看各平台文案、排期、资产健康状态和审计记录
- 执行复制文案、预览、打开平台、定位视频、标记发布、失败记录、取消、恢复和创建新版本
- 图文包额外提供「发布图文到抖音」（先预览再提交）与「提交验证码」
- 文章包（今日头条）额外提供「提交到头条号」（先预览再提交）与「下载文章 HTML」（降级通路：
  导出 `article.html`，任何时候可用、可直接粘进头条编辑器）；文章任务**不提供**「编辑文案」——
  正文是包级 `article.html` 的渲染结果，要改就重建文章包

### 设置页面
- **AI 密钥管理** — 管理多个 AI 服务 API Key，支持 DeepSeek、OpenAI 及中转代理
- **抖音登录** — 扫码登录或手动粘贴 Cookie，查看登录状态
- **今日头条** — 头条号扫码登录（应用内二维码 / 打开浏览器窗口扫码）与「校验登录」零副作用自检
- **语音识别状态** — 展示内置 Whisper 本地转录能力

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
┌─────────────────┐          ┌──────────────────────┐
│  React 前端      │  HTTP    │  Express 后端         │
│                 │ ◄────►   │                      │
│  - React 19     │          │  - 任务管理           │
│  - Vite         │          │  - 用户主页爬取       │
│  - Zustand      │          │  - 合集管理+增量更新  │
│  - Tailwind CSS │          │  - 签名算法 (a_bogus) │
│  - React Router │          │  - Cookie 管理        │
│                 │          │  - 视频下载           │
│                 │          │  - 音频提取           │
│                 │          │  - 语音转录           │
│                 │          │  - AI 清洗            │
│                 │          │  - 分镜生成           │
│                 │          │  - Skill 知识蒸馏     │
│                 │          │  - 头条文章发布       │
└─────────────────┘          └──────────────────────┘
                                      │
                      ┌───────────────┴───────────────┐
                      ▼                               ▼
             ┌─────────────────┐             ┌────────────┐
             │ AI / 本地 ASR    │             │ 文件存储    │
             │ - DeepSeek      │             │            │
             │ - OpenAI        │             │ ~/.douyin  │
             │ - 中转代理      │             │   -ai-video/│
             │ - whisper.cpp   │             │   storage   │
             │ - ggml-small    │             │ ~/.claude  │
             └─────────────────┘             │ /skills/   │
                                             └────────────┘
```

## 技术栈

### 后端
- **运行时**: Node.js 18+
- **框架**: Express 4
- **语言**: TypeScript 5.x
- **视频处理**: yt-dlp, ffmpeg
- **浏览器自动化**: Playwright（用户主页爬取和扫码登录）
- **AI 服务**: OpenAI SDK（兼容 DeepSeek / OpenAI-compatible）
- **ASR**: 内置 whisper.cpp + ggml-small（随安装包携带）
- **视频渲染**: HyperFrames CLI（可选，生成视频步骤需要 Node.js 22+ 和 FFmpeg）
- **签名算法**: SM3/MD5 + RC4 + 自定义 Base64（纯 TypeScript 实现）

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
- 开发模式需要本机可用的 yt-dlp、ffmpeg 和 Playwright 浏览器
- 视频生成步骤需要 Node.js >= 22 和 HyperFrames CLI
- 打包命令会自动准备完整运行资源；构建机需要联网、`tar`、`unzip` 和基础命令行工具
- 安装包会内置 yt-dlp、ffmpeg、ffprobe、whisper.cpp、ggml-small、HyperFrames CLI 和 Chrome headless shell

### 安装依赖

```bash
# 克隆仓库
git clone https://github.com/LiChangZheng10086/doyin_ai_video.git
cd doyin_ai_video

# 安装依赖
npm install

# 安装 Playwright 浏览器（用户主页爬取和扫码登录需要）
npx playwright install chromium
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

当前 `package:mac` 生成 macOS arm64 包；`package:win` 生成 Win11 x64 包。安装后的应用不要求用户再安装 Python、FunASR、Whisper、ffmpeg、yt-dlp、Node.js 或 HyperFrames。抖音下载和 AI 洗稿仍然需要网络，AI 洗稿/Skill 生成仍需要有效的 AI API Key。

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

**中转代理 / 自定义**
- 支持任何 OpenAI 兼容 API，填写 baseURL 和模型名即可

### 2. 抖音 Cookie 配置

为使签名 API 直调和批量采集正常工作，需要在设置页面配置抖音登录态。提供两种方式：

**扫码登录**
- 打开设置 → Douyin Login → 点击"打开浏览器扫码登录"
- 在弹出窗口中扫描二维码完成登录
- Cookie 自动保存到 `~/.douyin-ai-video/douyin-cookie.txt`

**手动粘贴**（推荐）
- 在 Chrome 中打开并登录 https://www.douyin.com/
- 按 F12 打开 DevTools → Application → Cookies → douyin.com
- 将所有 Cookie 复制为 `key1=value1; key2=value2; ...` 格式
- 粘贴到设置页面的输入框中，点击"保存 Cookie"

关键认证 Cookie 包括：`sessionid`, `sid_guard`, `passport_csrf_token`, `odin_tt`, `ttwid`

### 3. 语音转录配置

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

### 4. 外部依赖

开发模式会使用以下系统工具；正式安装包已经内置同类资源：

- **yt-dlp** — 视频下载
  ```bash
  brew install yt-dlp  # macOS
  ```

- **ffmpeg** — 音视频处理
  ```bash
  brew install ffmpeg  # macOS
  ```

- **HyperFrames** — 本地 HTML 动画渲染为 MP4（开发模式生成视频步骤需要）
  ```bash
  npx --yes hyperframes@0.7.108 doctor
  ```

HyperFrames 是本地 HTML/CSS/GSAP 到视频的渲染链路，不是 Sora、Remotion 自动成片或 HeyGen 云端视频生成 API。开发环境默认通过 `npx --yes hyperframes@0.7.108` 调用 CLI；打包后优先使用安装包内置的 HyperFrames CLI 和 Chrome headless shell。当前 v1 生成无真人、无数字人的图文解释视频；`voiceoverScript` 用作字幕和画面节奏，暂不自动生成 TTS 配音。

**头条号发布用的浏览器**：复用上述打包好的 Chrome headless shell，**零额外依赖**。若解析不到，按提示二选一：

```bash
npm run prepare:package:mac      # 拉取打包资源里的 chrome-headless-shell
npx playwright install chromium  # 或装一个完整的 Playwright chromium
```

也可用 `TOUTIAO_BROWSER_BINARY` 直接指定可执行文件路径（**改完要重启后端**）。注意打包进来的 headless shell 是**无头专用构建，开不了窗口**，所以「打开浏览器扫码登录」用的是系统 Chrome 或完整 chromium。

**抖音图文自动发布的外部引擎**（可选）：需要自装 `social-auto-upload`，并用 `SAU_BINARY`（`sau` 可执行文件）与 `SAU_BASE_DIR`（其仓库根目录，含 `conf.py`）指向它。两者缺省时该通路返回 422 并给出安装指引，其余发布中心功能不受影响。

## 📖 使用指南

### 创建任务

1. 点击主页的"＋ 新建任务"按钮
2. 选择输入方式：
   - **URL 模式** — 粘贴抖音分享链接（支持打开/关闭下载的视频）
   - **文本模式** — 粘贴分享文本
   - **主页链接** — 粘贴用户主页 URL，批量获取视频列表
3. 输入主题标签（可选）
4. 创建后进入任务详情页或合集详情页

### 批量采集（合集）

1. 在新建任务弹窗中选择"主页链接"
2. 粘贴用户主页 URL（如 `https://www.douyin.com/user/xxxxx`）
3. 可选设置最大采集数量
4. 点击"开始采集"，查看获取的作品列表
5. 勾选想要处理的视频 → 点击"创建选中任务"
6. 进入合集详情页，可批量执行步骤或分别进入单个任务

### 合集增量更新

1. 进入已有合集详情页
2. 点击用户信息卡片右侧的「🔄 检查更新」按钮
3. 系统自动爬取该博主最近发布的新视频，去重后追加到列表中
4. 新视频可按需创建子任务开始处理

### 视频下载策略

下载视频时按以下优先级自动选择最优方案：

1. **页面解析** — 从分享页面 ROUTER_DATA 提取视频 URL，优先使用 `download_addr`（无水印）
2. **签名 API** — 通过 a_bogus + X-Bogus 签名的 `aweme/detail` API 获取无水印下载地址（需要有效的 Cookie）
3. **yt-dlp** — 最终的通用下载工具降级方案

即使抖音关闭视频的"允许下载"开关，前两种方案仍可正常下载无水印视频。

### 执行主链路

在任务详情页按顺序点击：

1. 下载视频
2. 提取音频
3. ASR 转文案
4. AI 洗稿
5. 生成视频提示词（分镜）
6. 生成视频（可选）

未满足前置条件的步骤会禁用；运行中的步骤会禁止重复触发。某一步失败时，可查看错误信息并手动重试。

### Skill 知识蒸馏

将合集转录文本通过 AI 蒸馏为 Claude Code Skill：

1. 在合集详情页完成至少一个视频的转录
2. 点击「🧠 生成 Skill」按钮
3. （可选）填写聚焦方向提示词，控制提取范围
4. 点击生成，AI 将分析全部转录文本，生成结构化 SKILL.md，包含：
   - 核心方法论、金句与观点、术语表、案例库、适用场景、边界与注意事项
5. Skill 保存到 `~/.claude/skills/douyin-{id}/`，可在 Claude Code 中直接调用
6. 可选开启「转录后自动更新」，批量转录完成后自动刷新 Skill

在 **Skills 管理页**（`/skills`）可：
- 浏览所有已生成的 Skill
- 查看 Skill 内容（SKILL.md 渲染视图、原始来源、元信息）
- 内联重命名 Skill
- 删除 Skill 并清除合集关联

### 查看结果

生成对应产物后，可在详情页查看：

- **视频转录** — 查看视频音频的真实转录文字
  - 支持整段正文和结构化分段
  - 需要完成 ASR 转文案步骤
  - 未配置时显示分享文本

- **AI 洗稿** — 查看清洗后的脚本
  - 标题
  - 摘要和核心要点
  - 清洗稿和口播稿
  - 质量提示

- **分镜内容** — 查看视频提示词、短剧脚本和分镜规划
- **视频成片** — 查看 HyperFrames 渲染结果、场景列表并下载 `.mp4`

### 删除与垃圾桶

- 删除任务后会进入应用内垃圾桶。
- 垃圾桶保留 30 天，期间可恢复。
- 已完成任务可永久删除；处理中任务不允许永久删除，避免后台写入产生孤儿文件。

## 📂 数据存储

所有数据存储在：`~/.douyin-ai-video/storage/`

```
.douyin-ai-video/storage/
├── raw/                    # 原始数据
│   ├── videos/            # 下载的视频
│   ├── audio/             # 提取的音频
│   ├── transcripts/       # 结构化转录 JSON
│   ├── page/              # 页面元数据
│   └── text/              # 分享文本解析结果
│
├── processed/             # 处理结果
│   ├── scripts/           # 脚本资产
│   ├── cleaned/           # 清洗后内容
│   └── scenes/            # 场景数据
│
├── output/                # 最终输出
│   ├── videos/            # HyperFrames 项目和 MP4
│   └── publishing/        # 独立发布交付包
│
└── cache/                 # 合集、用户和发布索引
```

Cookie 存储位置：`~/.douyin-ai-video/douyin-cookie.txt`
Skill 存储位置：`~/.claude/skills/douyin-{id}/SKILL.md`

## 🔧 故障排查

### 视频下载失败
- 开发模式确认已安装 yt-dlp；安装包确认 `resources/bin/yt-dlp` 或 `resources/bin/yt-dlp.exe` 存在
- 检查网络连接和抖音链接格式
- 无水印下载需要抖音登录态：前往设置 → Douyin Login 配置 Cookie
- 查看页面解析和签名 API 的降级是否均失败

### 用户主页采集失败
- 确认已安装 Playwright 浏览器：`npx playwright install chromium`
- 确认设置页面已配置抖音 Cookie（需要 sessionid）
- 签名 API 模式依赖有效 Cookie，无 Cookie 时自动降级为浏览器模式
- 验证用户主页 URL 格式：`https://www.douyin.com/user/xxxxx`

### 合集更新无新视频
- 确认博主确实发布了新视频
- Cookie 可能过期，重试登录后重新检查更新
- 增量更新每次获取 50 条最新视频做去重对比

### 转录功能不工作
- 确认打包前已经运行 `npm run prepare:whisper`
- 确认安装包内存在 `resources/whisper/whisper-cli` 和 `resources/whisper/models/ggml-small.bin`
- 开发模式下确认 `vendor/whisper/whisper-cli` 和 `vendor/whisper/models/ggml-small.bin` 存在
- 查看 `raw/transcripts/` 目录是否有文件生成
- 查看任务详情页 ASR 步骤的错误信息

### Skill 生成失败
- 确认 AI API Key 配置有效且模型可用
- Skill 蒸馏可能需要 2-5 分钟（涉及大量转录文本分析），请耐心等待
- 查看合集详情页 Skill 生成的错误信息
- 服务器超时已设为 10 分钟，足够完成蒸馏

### 视频生成失败
- 开发模式确认当前 Node.js 版本 >= 22：`node -v`
- 开发模式确认 FFmpeg 和 HyperFrames 可用：`ffmpeg -version`、`npx --yes hyperframes@0.7.108 doctor`
- 安装包确认 `resources/hyperframes/node_modules/hyperframes/dist/cli.js` 和 `resources/browser/.../chrome-headless-shell` 存在
- 如果在生成项目目录内手动排查，优先使用项目脚本 `npm run check` / `npm run render`，或使用固定包版本的 `npx --yes hyperframes@0.7.108 ...`
- 新版本会在任务错误详情里展示失败命令、stdout 和 stderr；若只看到 `Command failed with exit code 1`，请先更新到最新代码后重试
- 查看任务详情页"生成视频"步骤的错误信息
- 渲染成功后，MP4 位于 `output/videos/{jobId}/hyperframes/renders/video.mp4`

### 今日头条文章发布不工作
- 报「未找到可用于头条号发布的浏览器」→ 见上方「外部依赖」，或用 `TOUTIAO_BROWSER_BINARY` 指定路径后**重启后端**
- 发布页被重定向回登录页 → 登录态失效：到「设置 → 今日头条」重新扫码（应用内二维码或浏览器窗口扫码）
- 点「打开浏览器扫码登录」报「本机没有可用于打开浏览器扫码的浏览器」→ 打包的 headless shell 开不了窗口：装 Google Chrome、`npx playwright install chromium`，或改用「应用内扫码」
- 报「找不到标题输入框 / 正文编辑器 / 封面上传入口 / 同时发布微头条勾选框」→ **页面结构已改版**：先跑只读侦察脚本 `node --import tsx scripts/probe-toutiao-publish-page.ts`（只落 DOM 快照，**不填表、不点发布**），按证据改 `src/lib/toutiao-page.ts` 的选择器，不要盲目重试
- 点「提交到头条号」后界面只说「发布服务暂时不可用」→ 用浏览器 Network 面板确认 `GET /api/publishing/packages/:id/preview` 是不是 500（提交所需的 `previewRevision` 只能由这条接口产出），修完记得 `npm run build:backend` 再重启
- 提示「已点击发布，但未能从页面确认结果」→ **先去头条后台「内容管理」核实是否已发出**，再决定是否重试

### 前端无法连接后端
- Electron 内嵌后端使用随机本地端口，前端通过 `window.electron.getServerPort()` 获取
- 开发模式下确认 `npm run dev` 正在运行
- 检查防火墙设置

## 🗺️ 开发路线图

### 已完成 ✅
- [x] Electron 桌面应用框架
- [x] 视频下载和音频提取
- [x] 多策略视频下载（页面解析 + 签名 API + yt-dlp）
- [x] 无水印视频 URL 提取（download_addr）
- [x] 抖音签名算法 a_bogus + X-Bogus（纯 TypeScript）
- [x] Cookie 管理（扫码登录 + 手动粘贴）
- [x] 用户主页批量采集（签名 API + 浏览器降级）
- [x] 合集管理（按博主聚合、批量创建子任务、批量执行步骤）
- [x] 合集增量更新（检查新视频，去重追加）
- [x] 内置 whisper.cpp 本地转录
- [x] AI 内容清洗
- [x] 视频分镜与提示词生成
- [x] 合集 Skill 知识蒸馏（AI 生成 Claude Code SKILL.md）
- [x] Skill 管理页面（查看、重命名、删除）
- [x] HyperFrames 本地竖屏视频生成
- [x] 发布中心（交付包、平台文案、排期、人工发布状态和垃圾桶）
- [x] 今日头条 AI 文章发布（自研 Playwright 执行器：扫码登录、AI 成文、16:9 封面、预览后提交）
- [x] 手动分步执行和步骤级自动重试
- [x] 任务垃圾桶和 30 天保留
- [x] 多 AI 模型支持（DeepSeek、OpenAI、自定义中转）
- [x] 设置页面（API Key 管理、抖音登录、ASR 状态）

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
- 提交前跑 `npm run check`：它现在包含**凭据扫描**（`check:secrets`）—— 测试假值要写成一眼可辨的（`test-app-id` / `fake-secret`），别用看起来像真的随机串；确需保留形态时在该行写 `secret-scan:allow` 并说明。
- 遵循 TypeScript 严格模式
- 提交信息遵循 Conventional Commits
- 代码格式化使用 ESLint + Prettier

### 提交规范
- `feat:` — 新功能
- `fix:` — Bug 修复
- `docs:` — 文档更新
- `refactor:` — 重构
- `style:` — 代码格式
- `test:` — 测试

## 📄 许可证

MIT License

## 👨‍💻 维护者

[@LiChangZheng10086](https://github.com/LiChangZheng10086)

---

**最后更新**: 2026-09-20
**仓库**: https://github.com/LiChangZheng10086/doyin_ai_video.git
