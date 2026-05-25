# doyin_ai_video

输入抖音视频链接，自动提取文案 → AI Agent 清洗整理 → 生成 PPT + 演讲稿 + 配音。

## 工作流程

```
抖音链接 → 下载视频 → Whisper 转录 → AI 清洗整理 → 生成 PPT + 演讲稿 + 配音
```

整个流程通过 LangGraph Agent 流水线自动执行，中间包含两个人工确认节点，确保输出质量。

## 技术栈

| 组件 | 技术 |
|------|------|
| 后端 | Python 3.13, FastAPI, SQLAlchemy |
| AI 编排 | LangGraph + DeepSeek API |
| ASR | faster-whisper |
| TTS | edge-tts |
| 前端 | Vue 3, Vite, Element Plus, Pinia |
| PPT | python-pptx + 预置模板 |

## 快速开始

### 后端

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# 配置 DeepSeek API Key
echo "DEEPSEEK_API_KEY=your_key_here" > .env

uvicorn main:app --reload
```

### 前端

```bash
cd frontend
npm install
npm run dev
```

### Docker

```bash
docker compose up
```

## 项目结构

```
├── backend/          # FastAPI 后端
│   ├── app/
│   │   ├── api/          # 路由
│   │   ├── agents/       # LangGraph Agent（清洗/写作/PPT生成）
│   │   ├── services/     # 下载/ASR/TTS/事件总线
│   │   ├── models/       # ORM + Pydantic schema
│   │   ├── core/         # 配置 + 数据库
│   │   └── templates/    # PPT 模板
│   └── main.py
├── frontend/         # Vue 3 前端
│   └── src/
│       ├── views/        # 主页 + 历史页
│       ├── api/          # API 封装
│       └── stores/       # Pinia 状态管理
└── docker-compose.yml
```

## License

MIT
