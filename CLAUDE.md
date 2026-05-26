# AI 视频二创工具 — douyin_ppt

## 项目概述

输入抖音分享链接、上传视频或纯文案，自动提取/接收文案 → AI Agent 清洗整理 → 生成 PPT + 演讲稿 + 配音 + Remotion 竖屏视频。

## 项目结构

```
douyin_ppt/
├── backend/                  # FastAPI 后端
│   ├── app/
│   │   ├── api/              # tasks.py, events.py
│   │   ├── core/             # config, database, utils
│   │   ├── models/           # Task ORM + Pydantic schemas
│   │   ├── services/         # pipeline, downloader, asr, tts, remotion
│   │   └── agents/           # cleaner, writer, ppt_generator
│   ├── remotion/             # Remotion 视频渲染（1080×1920）
│   ├── data/                 # DB + 输出（gitignored）
│   ├── main.py
│   └── requirements.txt
├── frontend/                 # Vue 3 + Vite
│   ├── src/
│   │   ├── api/index.ts
│   │   ├── stores/task.ts    # Pinia + SSE
│   │   └── views/            # Home.vue, History.vue
│   ├── nginx.conf            # Docker 生产 /api 反代
│   └── vite.config.ts
├── docker-compose.yml
├── .env.example
└── PROJECT_PLAN.md
```

## 技术栈

- **后端**: Python 3.13, FastAPI, SQLAlchemy + aiosqlite, LangChain, DeepSeek API
- **Agent**: cleaner（清洗+大纲）、writer（内容+演讲稿）、ppt_generator（程序化 PPT）
- **ASR**: faster-whisper (medium, int8)
- **TTS**: edge-tts
- **视频**: Remotion 4.x（React/TS，竖屏 1080×1920）
- **前端**: Vue 3, Vite, Pinia, Element Plus
- **流式**: SSE（agent_token, stage_change, error）

## 任务状态流转

```
waiting → downloading → transcribing → cleaning → confirm_1
→ writing → confirm_2 → generating → generating_video → completed
任何阶段可 → failed
```

## 常用命令

### 后端

```bash
cd backend
source .venv/bin/activate
uvicorn main:app --reload   # 默认 8000
```

### Remotion（本地调试渲染）

```bash
cd backend/remotion
npm install   # 首次
REMOTION_CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  npx remotion render src/index.ts TechVideo output/test.mp4 --props=props.json
```

### 前端

```bash
cd frontend
npm run dev       # 默认 3000，/api 代理到后端
npm run build     # vue-tsc + vite build
```

### Docker

```bash
docker compose up --build
```

## 关键模式

### SSE 流式

- 前端 `EventSource` → `/api/tasks/{taskId}/events`
- Agent `astream()` 推送 `agent_token`
- 流水线推送 `stage_change`；前端 store 实时更新状态

### 下载 Fallback

Layer 1: `api_parser.py` 解析抖音页面 → Layer 2: 用户上传视频

### 环境变量

`DEEPSEEK_API_KEY` 从 `backend/.env` 加载（见 `.env.example`）。未配置时 AI 阶段失败，启动日志会警告。

### 主题

三套主题 ID：`tech_blue` / `clean_white` / `warm_orange`，PPT 与 Remotion 视频共用。

## 目录说明

- `backend/data/` — 运行时 videos/ audios/ ppts/ uploads/
- `backend/remotion/` — 独立 Node 项目，后端通过 subprocess 调用
- `.claude/` — Claude Code 配置与 skills
