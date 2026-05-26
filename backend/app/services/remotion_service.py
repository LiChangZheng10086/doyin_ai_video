"""
RemotionService — replaces PIL+movipy video generation with Remotion.

Flow:
1. Take slides_content + slide_audio_paths + theme_id
2. Build JSON input with per-slide duration pre-calculation
3. Write JSON to temp file
4. Call npx remotion render via subprocess
5. Return output video path
"""

import asyncio
import json
import logging
import os
from pathlib import Path
from typing import Optional

from app.core.config import DATA_DIR

logger = logging.getLogger(__name__)

# Path to the Remotion project
REMOTION_DIR = Path(__file__).resolve().parent.parent.parent / "remotion"
ENTRY_POINT = str(REMOTION_DIR / "src/index.ts")

# Duration estimation when no audio is available
CHARS_PER_SECOND = 4
FALLBACK_FRAME_RATE = 30
MIN_SLIDE_FRAMES = 60   # minimum 2 seconds
MAX_SLIDE_FRAMES = 600  # maximum 20 seconds

# Chrome path override (macOS default, fallback for Docker: /usr/bin/google-chrome)
DEFAULT_CHROME_PATHS = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
]


def _find_chrome() -> Optional[str]:
    """Find Chrome executable, checking env var then common paths."""
    env_path = os.environ.get("REMOTION_CHROME_PATH")
    if env_path and os.path.isfile(env_path):
        return env_path
    for p in DEFAULT_CHROME_PATHS:
        if os.path.isfile(p):
            return p
    return None


def _estimate_frames(text: str) -> int:
    """Estimate duration frames from text length when audio is unavailable."""
    seconds = max(len(text) / CHARS_PER_SECOND, 2.0)
    frames = int(min(seconds * FALLBACK_FRAME_RATE, MAX_SLIDE_FRAMES))
    return max(frames, MIN_SLIDE_FRAMES)


def _get_audio_duration(path: Optional[str]) -> Optional[float]:
    """Try to get audio duration using ffprobe."""
    if not path or not os.path.isfile(path):
        return None
    try:
        import subprocess
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries",
             "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode == 0 and result.stdout.strip():
            return float(result.stdout.strip())
    except Exception as e:
        logger.debug(f"[Remotion] ffprobe failed for {path}: {e}")
    return None


def _build_slides_data(
    slides_content: list[dict],
    slide_audio_paths: Optional[list[str]] = None,
) -> list[dict]:
    """Build Remotion-compatible slide data with duration pre-calc."""
    result = []
    for i, slide in enumerate(slides_content):
        title = slide.get("title", "")
        content = slide.get("content", "")
        notes = slide.get("notes", "")

        # Determine layout based on content
        has_code = "```" in content
        is_first = i == 0
        is_last = i == len(slides_content) - 1

        if is_first:
            layout = "title"
        elif is_last and len(slides_content) > 2:
            layout = "summary"
        elif has_code:
            layout = "code"
        else:
            layout = "content"

        # Calculate duration from audio, or estimate from text
        audio_path = slide_audio_paths[i] if slide_audio_paths and i < len(slide_audio_paths) else None
        duration = _get_audio_duration(audio_path)
        if duration is not None:
            duration_frames = int((duration + 0.5) * FALLBACK_FRAME_RATE)
        else:
            duration_frames = _estimate_frames(notes or content)

        # Convert audio path to file:// URL for Remotion
        audio_url = None
        if audio_path and os.path.isfile(audio_path):
            audio_url = Path(audio_path).resolve().as_uri()

        result.append({
            "id": i + 1,
            "title": title,
            "content": content,
            "notes": notes,
            "audioUrl": audio_url,
            "durationFrames": duration_frames,
            "layout": layout,
        })

    return result


async def generate_video(
    slides_content: list[dict],
    theme_id: str,
    task_id: str,
    slide_audio_paths: Optional[list[str]] = None,
) -> str:
    """Generate MP4 video using Remotion.

    Args:
        slides_content: [{"title", "content", "notes"}, ...]
        theme_id: Theme key (tech_blue, clean_white, warm_orange)
        task_id: Task ID for output filename
        slide_audio_paths: Per-slide TTS audio paths

    Returns:
        Path to output MP4 file.
    """
    output_dir = DATA_DIR / "videos"
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = str(output_dir / f"{task_id}.mp4")

    # 1. Build input data
    slides_data = _build_slides_data(slides_content, slide_audio_paths)
    input_props = {
        "fps": FALLBACK_FRAME_RATE,
        "theme": theme_id,
        "slides": slides_data,
    }

    # 2. Write input JSON
    input_json = DATA_DIR / "remotion" / f"{task_id}.json"
    input_json.parent.mkdir(parents=True, exist_ok=True)
    input_json.write_text(json.dumps(input_props, ensure_ascii=False), encoding="utf-8")

    logger.info(f"[Remotion] 渲染开始: {len(slides_data)} 页, task={task_id}")

    # 3. Call remotion CLI
    chrome_path = _find_chrome()
    env = os.environ.copy()
    if chrome_path:
        env["REMOTION_CHROME_PATH"] = chrome_path
        logger.info(f"[Remotion] 使用 Chrome: {chrome_path}")

    cmd = [
        "npx", "--yes", "remotion", "render",
        ENTRY_POINT,
        "TechVideo",
        "--props", str(input_json),
        "--codec", "h264",
        "--fps", str(FALLBACK_FRAME_RATE),
        "--width", "1080",
        "--height", "1920",
        "--concurrency", "1",
        "--timeout", "120000",
        "--log", "error",
        output_path,
    ]

    logger.info(f"[Remotion] 命令: {' '.join(str(c) for c in cmd)}")

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=str(REMOTION_DIR),
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()

        if proc.returncode != 0:
            err_msg = stderr.decode("utf-8", errors="replace")[:1000]
            raise RuntimeError(f"Remotion render failed (exit {proc.returncode}): {err_msg}")

        logger.info(f"[Remotion] 渲染完成: {output_path}")
        return output_path

    except FileNotFoundError:
        logger.error("[Remotion] npx not found — is Node.js installed?")
        raise
    except Exception as e:
        logger.error(f"[Remotion] 渲染异常: {e}")
        raise
