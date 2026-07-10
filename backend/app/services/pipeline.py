"""
Task processing pipeline orchestrator with SSE events.
"""

import asyncio
import logging
from sqlalchemy import select
from app.core.database import async_session
from app.core.utils import parse_json_field
from app.models.task import Task, TaskStatus
from app.services.downloader import download_video
from app.services.audio import extract_audio
from app.services.asr import transcribe
from app.services.events import publish, publish_status
from app.agents.cleaner import run_stream as run_cleaner_stream
from app.agents.writer import run_stream as run_writer_stream
from app.agents.ppt_generator import generate as generate_ppt
from app.services.tts import synthesize_speech
from app.services.remotion_service import generate_video as generate_remotion_video

from app.core.config import require_deepseek_key

logger = logging.getLogger(__name__)
# Internal helpers
# ---------------------------------------------------------------------------

async def _update(task_id: str, **kwargs):
    async with async_session() as db:
        result = await db.execute(select(Task).where(Task.id == task_id))
        task = result.scalar_one_or_none()
        if task:
            for k, v in kwargs.items():
                setattr(task, k, v)
            await db.commit()


async def _get_task(task_id: str):
    async with async_session() as db:
        result = await db.execute(select(Task).where(Task.id == task_id))
        return result.scalar_one_or_none()


# ---------------------------------------------------------------------------
# Stage 1: 下载 → 音频提取 → 转录 → Agent 1 (清洗+规划)
# ---------------------------------------------------------------------------

async def run_download_pipeline(task_id: str):
    """Run after task creation (both URL mode and text mode)."""
    try:
        task = await _get_task(task_id)
        if not task:
            return

        # -- 纯文本模式，跳过下载和转录 --
        if not task.douyin_url and task.text_input and not task.video_path:
            logger.info(f"[Pipeline] 纯文本模式 task={task_id}")
            raw_text = task.text_input
            await _update(task_id, raw_text=raw_text)

        else:
            # 如果已上传视频，跳过下载
            if not task.video_path:
                await publish_status(task_id, TaskStatus.DOWNLOADING.value, 1)
                await _update(task_id, status=TaskStatus.DOWNLOADING.value, current_step=1)
                dl = await download_video(task.douyin_url)
                if not dl.success:
                    logger.warning(f"[Pipeline] 下载失败，等待用户上传: {task_id}")
                    await _update(task_id, status=TaskStatus.FAILED.value,
                                  error_message="自动下载失败，请手动上传视频")
                    await publish(task_id, {"type": "error", "message": "自动下载失败，请手动上传视频"})
                    return
                await _update(task_id, video_path=dl.path, download_method=dl.method)
                video_path = dl.path
            else:
                video_path = task.video_path
                logger.info(f"[Pipeline] 跳过下载，使用已上传视频: {video_path}")

            # Step 2: Extract audio
            audio_path = await extract_audio(video_path, task_id)
            await _update(task_id, audio_path=audio_path)

            # Step 3: Transcribe (legacy faster-whisper stack; desktop app uses bundled whisper.cpp)
            await publish_status(task_id, TaskStatus.TRANSCRIBING.value, 2)
            await _update(task_id, status=TaskStatus.TRANSCRIBING.value, current_step=2)
            raw_text = await transcribe(audio_path)
            if not raw_text:
                await _update(task_id, status=TaskStatus.FAILED.value,
                              error_message="语音转录失败")
                await publish(task_id, {"type": "error", "message": "语音转录失败"})
                return
            await _update(task_id, raw_text=raw_text)

        # Step 4: Agent 1 — clean + structure (streaming)
        require_deepseek_key()
        await publish_status(task_id, TaskStatus.CLEANING.value, 3)
        await _update(task_id, status=TaskStatus.CLEANING.value, current_step=3)
        result = await run_cleaner_stream(task_id, raw_text)

        cleaned_text = result.get("cleaned_text", raw_text[:500])
        outline = result.get("outline", [])

        await _update(
            task_id,
            cleaned_text=cleaned_text,
            slide_outline=outline or None,
            status=TaskStatus.CONFIRM_1.value,
            current_step=3,
        )
        await publish_status(task_id, TaskStatus.CONFIRM_1.value, 3)
        logger.info(f"[Pipeline] Agent 1 完成 → confirm_1: {task_id}")

    except Exception as e:
        logger.error(f"[Pipeline] 下载阶段失败: {e}", exc_info=True)
        await _update(task_id, status=TaskStatus.FAILED.value, error_message=str(e)[:500])
        await publish(task_id, {"type": "error", "message": str(e)[:500]})


# ---------------------------------------------------------------------------
# Stage 2: Agent 2 — 写 PPT 内容和演讲稿
# ---------------------------------------------------------------------------

async def run_agent2_pipeline(task_id: str):
    """Run after user confirms cleaned text."""
    try:
        task = await _get_task(task_id)
        if not task:
            return

        await publish_status(task_id, TaskStatus.WRITING.value, 4)
        await _update(task_id, status=TaskStatus.WRITING.value, current_step=4)

        require_deepseek_key()
        outline = parse_json_field(task.slide_outline) or []
        result = await run_writer_stream(task_id, outline)

        slides = result.get("slides", [])
        speech_text = result.get("speech_text", "")

        await _update(
            task_id,
            slide_content=slides,
            speech_text=speech_text,
            status=TaskStatus.CONFIRM_2.value,
            current_step=4,
        )
        await publish_status(task_id, TaskStatus.CONFIRM_2.value, 4)
        logger.info(f"[Pipeline] Agent 2 完成 → confirm_2: {task_id}")

    except Exception as e:
        logger.error(f"[Pipeline] Agent 2 失败: {e}", exc_info=True)
        await _update(task_id, status=TaskStatus.FAILED.value, error_message=str(e)[:500])
        await publish(task_id, {"type": "error", "message": str(e)[:500]})


# ---------------------------------------------------------------------------
# Stage 3: Agent 3 — 生成 PPT + TTS
# ---------------------------------------------------------------------------

async def run_agent3_pipeline(task_id: str):
    """Run after user confirms slide content."""
    try:
        task = await _get_task(task_id)
        if not task:
            return

        await publish_status(task_id, TaskStatus.GENERATING.value, 5)
        await _update(task_id, status=TaskStatus.GENERATING.value, current_step=5)

        slides_content = parse_json_field(task.slide_content) or []
        template_id = task.ppt_template or "tech_blue"
        speech_text = task.speech_text or ""

        # Generate PPT
        ppt_path = await generate_ppt(slides_content, template_id, task_id)
        await _update(task_id, ppt_path=ppt_path)

        # TTS — 按页生成，实现音画同步
        slide_audio_paths: list[str | None] = []
        full_audio_output = None
        for i, slide in enumerate(slides_content):
            notes = slide.get("notes", "").strip()
            if notes:
                audio_path = await synthesize_speech(notes, f"{task_id}_slide_{i}")
                slide_audio_paths.append(audio_path)
            else:
                slide_audio_paths.append(None)

        # 额外生成完整演讲稿的 TTS（供下载用）
        if speech_text:
            full_audio_output = await synthesize_speech(speech_text, task_id)
            if full_audio_output:
                await _update(task_id, audio_path_output=full_audio_output)

        # Generate video from slides + per-slide audio
        await publish_status(task_id, TaskStatus.GENERATING_VIDEO.value, 6)
        await _update(task_id, status=TaskStatus.GENERATING_VIDEO.value, current_step=6)
        try:
            video_path = await generate_remotion_video(
                slides_content=slides_content,
                theme_id=template_id,
                task_id=task_id,
                slide_audio_paths=slide_audio_paths,
            )
            await _update(task_id, video_path_output=video_path)
        except Exception as e:
            logger.warning(f"[Pipeline] 视频生成失败（可选）: {e}")
            await publish(task_id, {"type": "error", "message": f"视频生成失败（可选，其他输出可下载）: {str(e)[:200]}"})

        await _update(task_id, status=TaskStatus.COMPLETED.value, current_step=7)
        await publish_status(task_id, TaskStatus.COMPLETED.value, 7)
        logger.info(f"[Pipeline] 全部完成: {task_id}")

    except Exception as e:
        logger.error(f"[Pipeline] Agent 3 失败: {e}", exc_info=True)
        await _update(task_id, status=TaskStatus.FAILED.value, error_message=str(e)[:500])
        await publish(task_id, {"type": "error", "message": str(e)[:500]})


# ---------------------------------------------------------------------------
# Re-run Agent 1 only (user rejected clean result)
# ---------------------------------------------------------------------------

async def run_cleaner_pipeline(task_id: str):
    """Re-run Agent 1 from existing raw_text."""
    try:
        task = await _get_task(task_id)
        if not task or not task.raw_text:
            await _update(task_id, status=TaskStatus.FAILED.value,
                          error_message="缺少原始文案，无法重新清洗")
            return

        await publish_status(task_id, TaskStatus.CLEANING.value, 3)
        await _update(task_id, status=TaskStatus.CLEANING.value, current_step=3,
                      cleaned_text=None, slide_outline=None)

        require_deepseek_key()
        result = await run_cleaner_stream(task_id, task.raw_text)
        cleaned_text = result.get("cleaned_text", task.raw_text[:500])
        outline = result.get("outline", [])

        await _update(
            task_id,
            cleaned_text=cleaned_text,
            slide_outline=outline or None,
            status=TaskStatus.CONFIRM_1.value,
            current_step=3,
        )
        await publish_status(task_id, TaskStatus.CONFIRM_1.value, 3)
        logger.info(f"[Pipeline] Agent 1 重新完成 → confirm_1: {task_id}")

    except Exception as e:
        logger.error(f"[Pipeline] 重新清洗失败: {e}", exc_info=True)
        await _update(task_id, status=TaskStatus.FAILED.value, error_message=str(e)[:500])
        await publish(task_id, {"type": "error", "message": str(e)[:500]})


# ---------------------------------------------------------------------------
# Entry points for API layer
# ---------------------------------------------------------------------------

def start_download_pipeline(task_id: str):
    asyncio.create_task(run_download_pipeline(task_id))


def start_agent2_pipeline(task_id: str):
    asyncio.create_task(run_agent2_pipeline(task_id))


def start_agent3_pipeline(task_id: str):
    asyncio.create_task(run_agent3_pipeline(task_id))


def start_cleaner_pipeline(task_id: str):
    asyncio.create_task(run_cleaner_pipeline(task_id))


def restart_failed_pipeline(task_id: str, current_step: int, slide_content=None, slide_outline=None):
    """Resume from the failed stage."""
    if current_step >= 5 and slide_content:
        start_agent3_pipeline(task_id)
    elif current_step >= 4 and slide_outline:
        start_agent2_pipeline(task_id)
    else:
        start_download_pipeline(task_id)
