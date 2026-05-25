"""
Audio extraction from video via ffmpeg
"""

import asyncio
import logging
from app.core.config import DATA_DIR

logger = logging.getLogger(__name__)


async def extract_audio(video_path: str, task_id: str) -> str:
    """Extract audio from video file using ffmpeg"""
    audio_dir = DATA_DIR / "audios"
    audio_dir.mkdir(exist_ok=True)
    audio_path = str(audio_dir / f"{task_id}.mp3")

    cmd = ["ffmpeg", "-i", video_path, "-q:a", "0", "-map", "a", audio_path, "-y"]
    logger.info(f"[Audio] 提取音频: {video_path}")

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()

    if proc.returncode != 0:
        err = stderr.decode()[:500]
        raise RuntimeError(f"ffmpeg 提取音频失败: {err}")

    logger.info(f"[Audio] 提取完成: {audio_path}")
    return audio_path
