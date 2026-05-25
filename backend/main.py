"""
AI 视频二创工具 — 后端入口
"""

import asyncio
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from app.core.config import HOST, PORT
from app.core.database import init_db
from app.api.tasks import router as tasks_router
from app.api.events import router as events_router

# 日志配置
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期"""
    logger.info("启动中...")
    await init_db()
    logger.info("数据库初始化完成")

    # 后台预加载 Whisper 模型
    from app.services.asr import _load_model
    asyncio.create_task(_load_model())
    logger.info("后台预加载 ASR 模型")

    yield
    logger.info("应用关闭")


app = FastAPI(
    title="AI 视频二创工具",
    description="从抖音视频链接 → 提取文案 → AI 清洗 → 生成 PPT + 演讲稿 + 配音",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 路由
app.include_router(tasks_router)
app.include_router(events_router)


@app.get("/api/health")
async def health():
    return {"status": "ok", "version": "0.1.0"}


@app.get("/api/files/{filename}")
async def download_file(filename: str):
    """文件下载（PPT / 音频）"""
    from fastapi.responses import FileResponse
    from app.core.config import DATA_DIR
    for subdir in ["ppts", "audios", "videos"]:
        f = DATA_DIR / subdir / filename
        if f.exists():
            return FileResponse(str(f), filename=filename)
    raise HTTPException(404, "文件不存在")


@app.get("/api/templates")
async def list_templates():
    """获取 PPT 模板列表"""
    from app.agents.ppt_generator import list_templates
    return {"templates": list_templates()}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=HOST, port=PORT, reload=True)
