"""
TTS 语音合成 — edge-tts
"""

import logging
from pathlib import Path
from typing import Optional
from app.core.config import DATA_DIR

logger = logging.getLogger(__name__)


async def synthesize_speech(text: str, task_id: str, voice: str = "zh-CN-XiaoxiaoNeural") -> Optional[str]:
    """
    将演讲稿合成为语音
    voice: edge-tts 支持的中文语音
    """
    try:
        import edge_tts

        output_path = str(DATA_DIR / "audios" / f"{task_id}.mp3")

        logger.info(f"[TTS] 开始合成: {voice}")
        communicate = edge_tts.Communicate(text, voice)
        await communicate.save(output_path)

        logger.info(f"[TTS] 合成完成: {output_path}")
        return output_path

    except Exception as e:
        logger.error(f"[TTS] 合成失败: {e}")
        return None
