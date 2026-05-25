# doyin_ai_video

AI 视频二创工具 — 输入**抖音视频链接**（或纯文案），自动完成从文案提取、AI 清洗整理到 PPT 生成、演讲稿撰写、配音合成的全流程。辅助快速产出 AI 教程类视频内容。

## 效果

| 输入 | 输出 |
|------|------|
| 🎬 抖音视频链接 | 📊 PPT 文件（.pptx） |
| 📝 纯文案 | 📝 演讲稿 |
| | 🎵 配音音频 |

---

## 目录

- [整体流程](#整体流程)
- [架构设计](#架构设计)
- [AI Agent 流水线](#ai-agent-流水线)
- [技术栈](#技术栈)
- [快速开始](#快速开始)
- [项目结构](#项目结构)
- [API 接口](#api-接口)
- [配置说明](#配置说明)
- [后续规划](#后续规划)

## 整体流程

```
用户粘贴抖音链接
    │
    ▼
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  📥 下载层 · 三重 Fallback
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Layer 1: 社区 API 解析库 (Evil0ctal/Douyin_TikTok_Download_API)
  Layer 2: Playwright 浏览器 (stealth 插件)
  Layer 3: 用户手动上传 (兜底)
    │
    ▼
[ffmpeg] → 提取音频轨道
    │
    ▼
[faster-whisper] → ASR 语音识别，产出原始文案
    │
    ▼
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  🧠 LangGraph Agent Pipeline
  (3 节点 + 人工确认 Checkpoint)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    │
    ├─ Agent 1: Cleaner + Structurer（合并）
    │    清洗文案 → 输出 Pydantic 大纲
    │    → 👤 用户确认/修改
    │
    ├─ Agent 2: Writer
    │    填充每页内容 + 写演讲稿
    │    → 👤 用户预览/调整
    │
    └─ Agent 3: PPT Generator
         选模板 → 填充占位符 → 生成 .pptx
    │
    ▼
📤 输出：PPT 文件 + 演讲稿 + 配音音频
```

### 任务状态流转

```
waiting → downloading → transcribing → cleaning → confirm_1（人工确认）
→ writing → confirm_2（人工确认）→ generating → completed
任何阶段可 → failed
```

支持**断点续跑**：失败只重跑当前节点，不重跑前面。

---

## 架构设计

```
┌─────────────────────────────────────────────────────────┐
│                    🖥️ Web UI (Vue 3)                     │
│  粘贴链接 / 上传视频 → 实时进度 → 人工确认 → 下载结果    │
└────────────────────────┬────────────────────────────────┘
                         │ HTTP / SSE
┌────────────────────────▼────────────────────────────────┐
│                    🐍 FastAPI 后端                       │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │ API 路由  │→│  Task Manager │→│  任务队列 (ARQ)    │  │
│  └──────────┘  └──────┬───────┘  └───────────────────┘  │
│                       │                                  │
│                ┌──────▼───────┐                          │
│                │   SQLite DB   │                          │
│                └──────────────┘                          │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│               📥 下载层 · 三重 Fallback                  │
│  API 解析库 → Playwright → 用户上传                     │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│               🎙️ 转录层 (faster-whisper)                │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│          🧠 Agent Pipeline (LangGraph + DeepSeek)        │
│  Agent 1         Agent 2          Agent 3               │
│  清洗+大纲  →  写内容+稿  →  生成 PPT                   │
│       ↑              ↑                                   │
│   ┌──────┐      ┌──────┐                                 │
│   │确认点1│      │确认点2│                                 │
│   └──────┘      └──────┘                                 │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│                    📤 输出层                              │
│  PPT (.pptx) + 演讲稿 + 配音 (Edge-TTS)                  │
└─────────────────────────────────────────────────────────┘
```

---

## AI Agent 流水线

### 设计原则

1. **3 个 Agent，不接太长链路** — 减少累计错误放大
2. **Pydantic schema 硬约束** — 每个 Agent 的输入输出都是结构化模型，不用自由文本传递
3. **人工确认 Checkpoint** — 关键节点让用户看一眼，防止错误累积
4. **断点续跑** — 失败只重跑当前节点，不重跑前面

### Agent 职责

| Agent | 职责 | 输入 | 输出 |
|-------|------|------|------|
| **Agent 1: Cleaner + Structurer** | 去口语化 → 提炼要点 → 规划 PPT 结构 | 原始转录文本 | `list[SlideOutline]`（Pydantic 约束）|
| **Agent 2: Writer** | 填充每页详细内容 + 写演讲稿 | `list[SlideOutline]` | 每页完整内容 + 演讲口播稿 |
| **Agent 3: PPT Generator** | 选模板 → 填充占位符 → 生成 .pptx 文件 | 结构化内容 + 模板选择 | `.pptx` 文件路径 |

### 稳定性保障

| 问题 | 方案 |
|------|------|
| Prompt 漂移 | Pydantic schema 硬约束输出格式 |
| 错误累计放大 | 人工确认 Checkpoint + 独立校验 |
| 调试困难 | 每步结果写入数据库，前后端可查看中间产物 |
| DeepSeek 限流 | 自动重试 + 任务队列排队 |
| 抖音下载失败 | 三重 Fallback：API → Playwright → 用户上传 |

---

## PPT 模板体系

不靠 Agent 从零写 PPT，而是 Agent 往设计师做好的模板里填内容。

预置 3-5 套专业 PPT 模板（.pptx 格式）：

| 模板 | 风格 | 适用场景 |
|------|------|---------|
| 科技蓝 | 科技感、蓝色主调 | AI 工具介绍、技术教程 |
| 简约白 | 简洁干净、白底黑字 | 通用教程、知识分享 |
| 活力橙 | 温暖活泼、橙色点缀 | 入门科普、轻松话题 |

模板包含 Slide Master（统一配色/字体/间距）、预置布局（标题页、内容页、代码页、总结页）、占位符标记（python-pptx 定位填充），保留模板原有动画效果。

---

## 技术栈

### 后端

| 组件 | 技术 | 说明 |
|------|------|------|
| Web 框架 | FastAPI | 异步后端 |
| Agent 编排 | LangGraph | 多 Agent 流水线核心 |
| LLM | DeepSeek API | 文案清洗/内容生成 |
| 下载 Layer 1 | Evil0ctal/Douyin_TikTok_Download_API | 第一优先下载方案 |
| 下载 Layer 2 | Playwright | 第二优先下载方案 |
| 音视频 | ffmpeg | 音频提取 |
| ASR | faster-whisper (medium, int8) | 语音转文字 |
| PPT | python-pptx + 预置模板 | 基于模板填充内容 |
| TTS | edge-tts | 语音合成（免费、中文好）|
| 任务队列 | ARQ | 异步处理耗时任务 |
| 数据库 | SQLite + SQLAlchemy | 任务/配置/历史 |

### 前端

| 组件 | 技术 |
|------|------|
| 框架 | Vue 3 + Vite |
| UI | Element Plus |
| 状态管理 | Pinia |
| 流式通信 | SSE (Server-Sent Events) |

---

## 快速开始

### 前置条件

- Python 3.13+
- Node.js 18+
- ffmpeg（系统安装）
- DeepSeek API Key

### 后端

```bash
cd backend

# 创建虚拟环境
python -m venv .venv
source .venv/bin/activate

# 安装依赖
pip install -r requirements.txt

# 配置环境变量
echo "DEEPSEEK_API_KEY=your_api_key_here" > .env

# 启动开发服务器
uvicorn main:app --reload
# 默认监听 http://localhost:8000
```

### 前端

```bash
cd frontend

# 安装依赖
npm install

# 启动开发服务器
npm run dev
# 默认监听 http://localhost:3000
# 通过 Vite proxy 将 /api 转发到后端
```

### 生产构建

```bash
cd frontend
npm run build     # 产出到 dist/
```

### Docker 部署

```bash
docker compose up
```

---

## 项目结构

```
doyin_ai_video/
├── backend/                       # FastAPI 后端
│   ├── app/
│   │   ├── api/                   # FastAPI 路由
│   │   │   ├── tasks.py           # 任务创建/查询/下载/重试
│   │   │   └── events.py          # SSE 事件流
│   │   ├── core/
│   │   │   ├── database.py        # SQLite 连接
│   │   │   └── config.py          # 全局配置
│   │   ├── models/
│   │   │   ├── task.py            # 任务 ORM 模型
│   │   │   └── schemas.py         # Pydantic schema
│   │   ├── services/
│   │   │   ├── downloader/        # 三重 Fallback 下载
│   │   │   │   ├── __init__.py    # 统一入口
│   │   │   │   ├── api_parser.py  # Layer 1: API 解析库
│   │   │   │   ├── playwright.py  # Layer 2: Playwright
│   │   │   │   └── upload.py      # Layer 3: 用户上传
│   │   │   ├── asr.py             # Whisper 转录
│   │   │   ├── tts.py             # Edge-TTS 合成
│   │   │   ├── audio.py           # 音频处理
│   │   │   ├── events.py          # 事件总线 (SSE)
│   │   │   ├── pipeline.py        # 任务流水线编排
│   │   │   └── video_generator.py # 视频生成
│   │   ├── agents/
│   │   │   ├── graph.py           # LangGraph 组装
│   │   │   ├── cleaner.py         # Agent 1: 清洗+规划
│   │   │   ├── writer.py          # Agent 2: 内容+演讲稿
│   │   │   └── ppt_generator.py   # Agent 3: PPT 生成
│   │   └── templates/             # PPT 模板文件 (.pptx)
│   │       ├── tech_blue.pptx
│   │       ├── clean_white.pptx
│   │       └── warm_orange.pptx
│   ├── data/                      # 运行时数据 (gitignored)
│   │   ├── videos/
│   │   ├── audios/
│   │   ├── ppts/
│   │   └── uploads/
│   ├── main.py                    # 入口
│   ├── requirements.txt
│   └── Dockerfile
├── frontend/                      # Vue 3 前端
│   ├── src/
│   │   ├── views/
│   │   │   ├── Home.vue           # 新建任务（粘贴链接/上传视频/实时进度）
│   │   │   └── History.vue        # 历史记录（搜索/下载/重新生成）
│   │   ├── components/
│   │   │   ├── TaskCard.vue       # 任务卡片
│   │   │   ├── ProgressBar.vue    # 进度条
│   │   │   ├── TextReview.vue     # 文案预览/编辑（人工确认节点）
│   │   │   └── SlidePreview.vue   # PPT 预览
│   │   ├── api/
│   │   │   └── index.ts           # 后端 API 封装 (Axios)
│   │   ├── stores/
│   │   │   └── task.ts            # Pinia 状态管理（含 SSE 连接）
│   │   ├── App.vue
│   │   ├── main.ts
│   │   └── router.ts
│   ├── index.html
│   ├── vite.config.ts
│   ├── package.json
│   └── Dockerfile
├── docker-compose.yml
├── .env.example                   # 环境变量示例
└── CLAUDE.md                      # Claude Code 项目配置
```

---

## API 接口

### 任务管理

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/tasks` | 创建任务（链接或上传）|
| GET | `/api/tasks` | 获取任务列表 |
| GET | `/api/tasks/{id}` | 获取任务详情 |
| POST | `/api/tasks/{id}/retry` | 重试失败步骤 |
| GET | `/api/tasks/{id}/events` | SSE 实时事件流 |
| GET | `/api/tasks/{id}/download/ppt` | 下载 PPT 文件 |
| GET | `/api/tasks/{id}/download/audio` | 下载配音音频 |
| POST | `/api/tasks/{id}/confirm` | 人工确认节点 |

### SSE 事件类型

| 事件类型 | 说明 |
|---------|------|
| `agent_token` | Agent 逐 token 输出（流式展示） |
| `agent_done` | Agent 节点完成 |
| `stage_change` | 阶段变更（如 cleaning → confirm_1） |
| `error` | 错误信息 |

---

## 配置说明

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `DEEPSEEK_API_KEY` | DeepSeek API 密钥 | — |
| `DEEPSEEK_API_URL` | DeepSeek API 地址 | `https://api.deepseek.com/v1` |
| `DEEPSEEK_MODEL` | 模型名称 | `deepseek-chat` |

### 下载层 Fallback 策略

| 层级 | 方案 | 预期成功率 |
|------|------|-----------|
| Layer 1 | 社区 API 解析库 | ~80% |
| Layer 2 | Playwright 浏览器 (stealth) | ~15% |
| Layer 3 | 用户手动上传视频 | 100%（用户提供） |

---

## 后续规划

- [ ] 支持更多平台（B站、小红书、YouTube）
- [ ] Token 用量看板（每日/每任务消耗统计）
- [ ] PPT 模板自定义上传
- [ ] 多语言输出（翻译 Agent）
- [ ] 批量处理（批量链接输入）
- [ ] 封面图生成（Image Generation Agent）
- [ ] 纯文案模式（不下载视频，直接粘贴文案开始）

---

## License

MIT
