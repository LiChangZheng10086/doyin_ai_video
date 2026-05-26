# AI 视频二创工具 — douyin_ppt

## 项目概述
输入抖音视频链接或纯文案，自动提取文案 → AI Agent 清洗整理 → 生成 PPT + 演讲稿 + 配音。

## 项目结构
```
douyin_ppt/
├── backend/                  # FastAPI 后端
│   ├── app/
│   │   ├── api/              # 路由（tasks.py, events.py）
│   │   ├── core/             # 配置 + 数据库
│   │   ├── models/           # Task ORM + Pydantic schemas
│   │   ├── services/         # 下载、ASR、TTS、事件总线、Pipeline
│   │   ├── agents/           # Cleaner、Writer、PPT Generator
│   │   └── templates/        # PPT 模板 (.pptx)
│   ├── remotion/             # Remotion 视频渲染项目
│   │   └── src/
│   │       ├── slides/       # 幻灯片 React 组件
│   │       ├── Root.tsx      # Composition 注册
│   │       └── VideoComposition.tsx
│   ├── data/                 # DB + 输出文件（gitignored）
│   ├── main.py               # 入口
│   └── requirements.txt
├── frontend/                 # Vue 3 + Vite
│   ├── src/
│   │   ├── api/index.ts      # Axios API 封装
│   │   ├── stores/task.ts    # Pinia 状态（含 SSE）
│   │   ├── views/Home.vue    # 新建任务 + 实时进度
│   │   └── views/History.vue # 历史记录
│   ├── vite.config.ts
│   └── package.json
├── docker-compose.yml
├── .env.example
└── PROJECT_PLAN.md           # 详细设计文档
```

## 技术栈
- **后端**: Python 3.13, FastAPI, SQLAlchemy + aiosqlite, LangChain, DeepSeek API
- **Agent**: cleaner（清洗+大纲）、writer（内容+演讲稿）、ppt_generator
- **ASR**: faster-whisper (medium, int8)
- **TTS**: edge-tts
- **视频渲染**: Remotion 4.x (React/TS, CSS 动画, 1080×1920 竖屏)
- **前端**: Vue 3, Vite, Pinia, Element Plus, Axios
- **流式**: SSE (Server-Sent Events) 实时推送 agent token

## 任务状态流转
```
waiting → downloading → transcribing → cleaning → confirm_1（人工确认）
→ writing → confirm_2（人工确认）→ generating → completed
任何阶段可 → failed
```

## 常用命令

### 后端
```bash
cd backend
source .venv/bin/activate
uvicorn main:app --reload   # 开发（默认 8000）
```

### 视频渲染（Remotion）
```bash
cd backend/remotion
REMOTION_CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npx remotion render src/index.ts TechVideo output/test.mp4 --props=<(echo '{"slides":[...]}')
```

### 前端
```bash
cd frontend
npm run dev       # 开发（默认 3000）
npm run build     # 生产构建
```

### 启动前后端
后端先起，前端开发服务器通过 Vite proxy 将 `/api` 转发到后端。

## 关键模式

### SSE 流式
- 前端通过 `EventSource` 连接 `/api/tasks/{taskId}/events`
- Agent 使用 `astream()` 逐 token 推送到事件总线
- 事件类型: `agent_token`, `agent_done`, `stage_change`, `error`

### API 封装
- `frontend/src/api/index.ts` — 所有后端接口集中定义
- Pinia store `task.ts` — 管理当前任务状态 + SSE + 轮询

### 视频下载
三重 fallback: API 解析 → Playwright → 用户上传

### DEEPSEEK_API_KEY
环境变量，从 `backend/.env` 加载。需自行配置。

## 目录说明
- `.claude/` — Claude Code 配置文件、MCP、skills 存放位置
- `backend/data/` — 运行时数据（gitignored），包含 videos/ audios/ ppts/ uploads/
- `backend/app/templates/` — PPT 模板文件
