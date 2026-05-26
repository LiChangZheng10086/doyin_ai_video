import json
import re
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlalchemy import select, desc, func
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.database import get_db
from app.core.config import DATA_DIR
from app.core.utils import parse_json_field, safe_filename
from app.models.task import Task, TaskStatus
from app.models.schemas import (
    TaskCreate, TaskResponse, TaskListResponse,
    ConfirmCleanBody, ConfirmContentBody, SelectTemplateBody, TaskIdBody,
)

from app.services.pipeline import (
    start_download_pipeline,
    start_agent2_pipeline,
    start_agent3_pipeline,
    start_cleaner_pipeline,
    restart_failed_pipeline,
    run_download_pipeline,
)

router = APIRouter(prefix="/api/tasks", tags=["tasks"])

# 抖音分享文本解析
DOUYIN_URL_PATTERN = re.compile(r"https?://(?:v\.)?douyin\.com/\S+")
HASHTAG_PATTERN = re.compile(r"#\s*([^\s#]+)")  # 匹配 #skill 或 # skill

ALLOWED_VIDEO_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".webm"}
MAX_UPLOAD_BYTES = 500 * 1024 * 1024  # 500 MB


def parse_douyin_share(text: str) -> dict:
    """
    解析抖音分享文本，返回结构化信息
    输入: "4.12 a@A.gO iCH:/ 02/02 :1pm 强烈推荐6个自用skill... https://v.douyin.com/xxxxx/ 复制此链接..."
    输出: { url, description, hashtags, full_text }
    """
    # 1. 提取链接
    url_match = DOUYIN_URL_PATTERN.search(text)
    url = ""
    if url_match:
        url = url_match.group().rstrip("/.,;:!?，。；：！？")

    # 2. 提取话题标签
    hashtags = HASHTAG_PATTERN.findall(text)

    # 3. 提取描述文字
    desc_text = DOUYIN_URL_PATTERN.sub("", text)
    desc_text = re.sub(r"复制此链接，打开Dou音搜索，直接观看[！!。]*", "", desc_text)
    desc_text = re.sub(r"\s*https?://\S+", "", desc_text)

    match = re.search(r"[一-鿿]", desc_text)
    if match and match.start() > 0:
        desc_text = desc_text[match.start():]

    desc_text = desc_text.strip().strip("，,。.")

    if len(desc_text) < 6:
        before_url = text.split("https://")[0] if "https://" in text else text
        desc_text = before_url.strip()[:100]

    title = re.sub(r"#\s*\S+", "", desc_text).strip()[:60] or "抖音视频"

    return {
        "url": url,
        "description": desc_text or "抖音视频",
        "title": title or "抖音视频",
        "hashtags": hashtags,
        "full_text": text,
    }


def _task_to_response(task: Task) -> TaskResponse:
    hashtags = parse_json_field(task.hashtags) if task.hashtags else []
    if not isinstance(hashtags, list):
        hashtags = []

    outline = parse_json_field(task.slide_outline)
    content = parse_json_field(task.slide_content)

    return TaskResponse(
        id=task.id,
        title=task.title,
        description=task.description,
        hashtags=hashtags,
        douyin_url=task.douyin_url,
        text_input=task.text_input,
        status=task.status,
        current_step=task.current_step,
        raw_text=task.raw_text,
        cleaned_text=task.cleaned_text,
        slide_outline=outline,
        slide_content=content,
        speech_text=task.speech_text,
        ppt_path=task.ppt_path,
        ppt_template=task.ppt_template,
        video_path=task.video_path,
        audio_path_output=task.audio_path_output,
        video_path_output=task.video_path_output,
        error_message=task.error_message,
        created_at=task.created_at.isoformat() if task.created_at else "",
    )


@router.post("", response_model=TaskResponse)
async def create_task(body: TaskCreate, db: AsyncSession = Depends(get_db)):
    """创建任务：输入抖音分享文本、纯文案，或仅上传视频"""
    raw_input = body.text_input.strip()

    if body.upload_only:
        if raw_input:
            raise HTTPException(400, "上传模式不需要填写文案，请直接上传视频")
        task = Task(
            title="上传视频",
            text_input="",
            ppt_template=body.ppt_template,
            status=TaskStatus.WAITING.value,
        )
        db.add(task)
        await db.commit()
        await db.refresh(task)
        return _task_to_response(task)

    if not raw_input:
        raise HTTPException(400, "请输入内容")

    parsed = parse_douyin_share(raw_input)

    task = Task(
        douyin_url=parsed["url"] or None,
        title=parsed["title"],
        description=parsed["description"],
        hashtags=json.dumps(parsed["hashtags"], ensure_ascii=False) if parsed["hashtags"] else None,
        text_input=raw_input,
        ppt_template=body.ppt_template,
        status=TaskStatus.WAITING.value,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)

    start_download_pipeline(task.id)
    return _task_to_response(task)


@router.get("", response_model=TaskListResponse)
async def list_tasks(page: int = 1, size: int = 20, db: AsyncSession = Depends(get_db)):
    """查询历史任务"""
    offset = (page - 1) * size
    result = await db.execute(select(Task).order_by(desc(Task.created_at)).offset(offset).limit(size))
    tasks = result.scalars().all()
    count_result = await db.execute(select(func.count()).select_from(Task))
    total = count_result.scalar_one()
    return TaskListResponse(
        tasks=[_task_to_response(t) for t in tasks],
        total=total,
    )


@router.get("/{task_id}", response_model=TaskResponse)
async def get_task(task_id: str, db: AsyncSession = Depends(get_db)):
    """查询单个任务详情"""
    result = await db.execute(select(Task).where(Task.id == task_id))
    task = result.scalar_one_or_none()
    if not task:
        raise HTTPException(404, "任务不存在")
    return _task_to_response(task)


@router.post("/{task_id}/start")
async def start_task(task_id: str, db: AsyncSession = Depends(get_db)):
    """手动触发任务开始处理"""
    result = await db.execute(select(Task).where(Task.id == task_id))
    task = result.scalar_one_or_none()
    if not task:
        raise HTTPException(404, "任务不存在")
    if task.status != TaskStatus.WAITING.value:
        raise HTTPException(400, f"当前状态不允许开始: {task.status}")

    task.status = TaskStatus.DOWNLOADING.value
    await db.commit()
    start_download_pipeline(task_id)
    return {"message": "任务已启动", "task_id": task_id}


@router.post("/confirm_clean", response_model=TaskResponse)
async def confirm_clean(body: ConfirmCleanBody, db: AsyncSession = Depends(get_db)):
    """确认点1：用户确认/编辑清洗后的文案"""
    result = await db.execute(select(Task).where(Task.id == body.task_id))
    task = result.scalar_one_or_none()
    if not task:
        raise HTTPException(404, "任务不存在")

    task.cleaned_text = body.cleaned_text
    task.status = TaskStatus.WRITING.value
    task.current_step = 3
    await db.commit()

    start_agent2_pipeline(task.id)
    return _task_to_response(task)


@router.post("/reject_clean", response_model=TaskResponse)
async def reject_clean(body: TaskIdBody, db: AsyncSession = Depends(get_db)):
    """退回清洗结果，重新运行 Agent 1"""
    result = await db.execute(select(Task).where(Task.id == body.task_id))
    task = result.scalar_one_or_none()
    if not task:
        raise HTTPException(404, "任务不存在")
    if task.status != TaskStatus.CONFIRM_1.value:
        raise HTTPException(400, "当前状态不允许退回清洗")

    task.status = TaskStatus.CLEANING.value
    task.current_step = 3
    await db.commit()

    start_cleaner_pipeline(task.id)
    return _task_to_response(task)


@router.post("/confirm_content", response_model=TaskResponse)
async def confirm_content(body: ConfirmContentBody, db: AsyncSession = Depends(get_db)):
    """确认点2：用户确认/编辑 PPT 内容"""
    result = await db.execute(select(Task).where(Task.id == body.task_id))
    task = result.scalar_one_or_none()
    if not task:
        raise HTTPException(404, "任务不存在")

    task.slide_content = [c.model_dump() for c in body.slide_content]
    task.speech_text = body.speech_text or task.speech_text
    task.status = TaskStatus.GENERATING.value
    task.current_step = 5
    await db.commit()

    start_agent3_pipeline(task.id)
    return _task_to_response(task)


@router.post("/select_template", response_model=TaskResponse)
async def select_template(body: SelectTemplateBody, db: AsyncSession = Depends(get_db)):
    """选择 PPT 模板"""
    result = await db.execute(select(Task).where(Task.id == body.task_id))
    task = result.scalar_one_or_none()
    if not task:
        raise HTTPException(404, "任务不存在")
    task.ppt_template = body.ppt_template
    await db.commit()
    await db.refresh(task)
    return _task_to_response(task)


@router.post("/{task_id}/retry")
async def retry_task(task_id: str, db: AsyncSession = Depends(get_db)):
    """重试失败的任务，从失败阶段继续"""
    result = await db.execute(select(Task).where(Task.id == task_id))
    task = result.scalar_one_or_none()
    if not task:
        raise HTTPException(404, "任务不存在")
    if task.status != TaskStatus.FAILED.value:
        raise HTTPException(400, "只有失败的任务可以重试")

    step = task.current_step
    outline = parse_json_field(task.slide_outline)
    content = parse_json_field(task.slide_content)

    task.error_message = None
    if step >= 5 and content:
        task.status = TaskStatus.GENERATING.value
    elif step >= 4 and outline:
        task.status = TaskStatus.WRITING.value
    else:
        task.status = TaskStatus.DOWNLOADING.value if not task.raw_text else TaskStatus.CLEANING.value
    await db.commit()

    restart_failed_pipeline(task_id, step, content, outline)
    return {"message": "任务已重新开始", "task_id": task_id}


@router.post("/upload_video/{task_id}")
async def upload_video(task_id: str, file: UploadFile = File(...), db: AsyncSession = Depends(get_db)):
    """用户上传视频文件（Layer 3 fallback）"""
    result = await db.execute(select(Task).where(Task.id == task_id))
    task = result.scalar_one_or_none()
    if not task:
        raise HTTPException(404, "任务不存在")

    content = await file.read()
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(400, "文件过大，最大支持 500MB")

    ext = "." + (file.filename or "").rsplit(".", 1)[-1].lower() if file.filename and "." in file.filename else ""
    if ext not in ALLOWED_VIDEO_EXTENSIONS:
        raise HTTPException(400, f"不支持的文件类型，允许: {', '.join(sorted(ALLOWED_VIDEO_EXTENSIONS))}")

    upload_dir = DATA_DIR / "uploads"
    upload_dir.mkdir(exist_ok=True)

    filename = safe_filename(file.filename or f"{task_id}.mp4")
    file_path = upload_dir / f"{task_id}_{filename}"
    with open(file_path, "wb") as f:
        f.write(content)

    task.video_path = str(file_path)
    task.download_method = "upload"
    task.status = TaskStatus.TRANSCRIBING.value
    task.current_step = 2
    await db.commit()

    import asyncio
    asyncio.create_task(run_download_pipeline(task.id))

    return {"message": "上传成功", "video_path": str(file_path)}
