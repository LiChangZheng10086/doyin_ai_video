"""
Legacy Python/Vue backend ASR — faster-whisper.

The maintained desktop app uses src/lib/asr.ts with bundled whisper.cpp.
"""

import asyncio
import logging
from pathlib import Path
from typing import Optional
from functools import partial
from app.core.config import WHISPER_MODEL_SIZE

logger = logging.getLogger(__name__)

_whisper_model = None
_model_lock = asyncio.Lock()


async def _load_model():
    """异步初始化 Whisper 模型（在 executor 中运行避免阻塞）"""
    global _whisper_model
    if _whisper_model is not None:
        return _whisper_model

    async with _model_lock:
        if _whisper_model is not None:
            return _whisper_model

        from faster_whisper import WhisperModel
        loop = asyncio.get_running_loop()
        logger.info(f"[ASR] 加载 Whisper 模型: {WHISPER_MODEL_SIZE}")
        _whisper_model = await loop.run_in_executor(
            None,
            partial(WhisperModel, WHISPER_MODEL_SIZE, device="cpu", compute_type="int8"),
        )
        logger.info(f"[ASR] 模型加载完成")
    return _whisper_model


async def transcribe(audio_path: str) -> Optional[str]:
    """
    对音频文件执行 ASR 转录
    返回原始文案文本
    """
    try:
        model = await _load_model()

        logger.info(f"[ASR] 开始转录: {audio_path}")

        loop = asyncio.get_running_loop()
        segments, info = await loop.run_in_executor(
            None,
            partial(model.transcribe, audio_path, language="zh", beam_size=5),
        )

        text_parts = []
        for segment in segments:
            text_parts.append(segment.text.strip())

        full_text = "\n".join(text_parts)
        logger.info(f"[ASR] 转录完成: {len(full_text)} 字")

        return full_text

    except Exception as e:
        logger.error(f"[ASR] 转录失败: {e}")
        return None
