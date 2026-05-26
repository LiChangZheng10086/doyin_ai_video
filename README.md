# douyin_ppt

AI 视频二创工具 — 输入**抖音分享链接**、**上传视频**或**纯文案**，自动完成文案提取、AI 清洗、PPT 生成、演讲稿撰写、配音合成与竖屏视频渲染。

## 效果

| 输入 | 输出 |
|------|------|
| 抖音分享链接 | PPT（.pptx） |
| 本地视频上传 | 演讲稿 |
| 纯文案 | 配音音频（Edge-TTS） |
| | 竖屏视频（Remotion 1080×1920） |

---

## 整体流程

```
用户输入（链接 / 上传 / 文案）
    │
    ▼
下载层 · 双层 Fallback
  Layer 1: 解析抖音页面 → 无水印视频
  Layer 2: 用户手动上传（兜底）
    │
    ▼
ffmpeg 提取音频 → faster-whisper ASR
    │
    ▼
Agent Pipeline（DeepSeek + 人工确认）
  Agent 1: 清洗 + 大纲  → 👤 确认点 1
  Agent 2: 写内容 + 稿   → 👤 确认点 2
  Agent 3: 生成 PPT
    │
    ▼
Edge-TTS 配音 → Remotion 渲染竖屏视频
    │
    ▼
completed（可下载 PPT / 音频 / 视频）
```

### 任务状态

```
waiting → downloading → transcribing → cleaning → confirm_1
→ writing → confirm_2 → generating → generating_video → completed
任何阶段可 → failed（支持从失败阶段重试）
```

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 后端 | Python 3.13, FastAPI, SQLAlchemy + aiosqlite |
| LLM | DeepSeek API（LangChain） |
| ASR | faster-whisper (medium, int8) |
| TTS | edge-tts |
| PPT | python-pptx 程序化生成（三套主题） |
| 视频 | Remotion 4.x + Chrome |
| 前端 | Vue 3, Vite, Pinia, Element Plus |
| 实时 | SSE（agent token + stage_change） |

后台任务通过 `asyncio.create_task` 在 FastAPI 进程内异步执行（当前未接入 Celery/ARQ）。

---

## 快速开始

### 前置条件

- Python 3.13+
- Node.js 18+（Remotion 视频渲染）
- ffmpeg
- Google Chrome（Remotion 渲染，macOS 通常已安装）
- DeepSeek API Key

### 1. 配置环境变量

```bash
cp .env.example backend/.env
# 编辑 backend/.env，填入 DEEPSEEK_API_KEY
```

### 2. 后端

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload
# http://localhost:8000
```

### 3. Remotion 依赖（首次需要）

```bash
cd backend/remotion
npm install
```

### 4. 前端

```bash
cd frontend
npm install
npm run dev
# http://localhost:3000（/api 代理到后端）
```

### Docker 部署

```bash
docker compose up --build
# 前端 http://localhost:3000
# 后端 http://localhost:8000
```

---

## 项目结构

```
douyin_ppt/
├── backend/
│   ├── app/
│   │   ├── api/              # tasks.py, events.py
│   │   ├── agents/           # cleaner, writer, ppt_generator
│   │   ├── core/             # config, database, utils
│   │   ├── models/           # Task ORM + Pydantic schemas
│   │   └── services/
│   │       ├── downloader/   # api_parser（抖音页面解析）
│   │       ├── pipeline.py   # 流水线编排
│   │       ├── remotion_service.py
│   │       ├── asr.py, tts.py, audio.py, events.py
│   ├── remotion/             # Remotion 竖屏视频项目
│   ├── data/                 # 运行时数据（gitignored）
│   ├── main.py
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── views/Home.vue    # 新建任务 + 进度 + 确认
│   │   ├── views/History.vue
│   │   ├── stores/task.ts    # Pinia + SSE
│   │   └── api/index.ts
│   ├── nginx.conf            # Docker 生产反代
│   └── Dockerfile
├── docker-compose.yml
├── .env.example
├── CLAUDE.md
└── PROJECT_PLAN.md           # 详细设计（部分与实现有差异，以代码为准）
```

---

## API 接口

### 任务

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/tasks` | 创建任务（`text_input` / `upload_only` / `ppt_template`） |
| GET | `/api/tasks` | 任务列表 |
| GET | `/api/tasks/{id}` | 任务详情 |
| POST | `/api/tasks/{id}/retry` | 从失败阶段重试 |
| POST | `/api/tasks/upload_video/{id}` | 上传视频（下载失败兜底） |
| POST | `/api/tasks/confirm_clean` | 确认清洗结果 |
| POST | `/api/tasks/reject_clean` | 退回，重新清洗 |
| POST | `/api/tasks/confirm_content` | 确认 PPT 内容 |
| POST | `/api/tasks/select_template` | 选择主题 |
| GET | `/api/tasks/{id}/events` | SSE 事件流 |
| GET | `/api/files/{filename}` | 下载 PPT / 音频 / 视频 |
| GET | `/api/templates` | 主题列表 |
| GET | `/api/health` | 健康检查 |

### SSE 事件

| 类型 | 说明 |
|------|------|
| `agent_token` | Agent 流式 token |
| `agent_done` | Agent 完成 |
| `stage_change` | 阶段变更 |
| `error` | 错误信息 |
| `keepalive` | 心跳 |

---

## 配置说明

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `DEEPSEEK_API_KEY` | DeepSeek 密钥（**必填**） | — |
| `DEEPSEEK_API_URL` | API 地址 | `https://api.deepseek.com/v1` |
| `DEEPSEEK_MODEL` | 模型 | `deepseek-chat` |
| `WHISPER_MODEL_SIZE` | Whisper 大小 | `medium` |
| `REMOTION_CHROME_PATH` | Chrome 路径 | 自动检测 |

---

## PPT / 视频主题

三套程序化主题（非 .pptx 模板文件），PPT 与 Remotion 视频共用：

| ID | 名称 | 风格 |
|----|------|------|
| `tech_blue` | 科技蓝 | 深色科幻、青色点缀 |
| `clean_white` | 简约白 | 深色底 + 橙色强调 |
| `warm_orange` | 活力橙 | 暖色深色底 |

---

## 后续规划

- [ ] 任务队列（Celery/ARQ）与并发控制
- [ ] 更多视频平台（B站、小红书）
- [ ] Token 用量统计
- [ ] 批量任务

---

## License

MIT
