import uuid
from datetime import datetime
from sqlalchemy import String, Text, DateTime, Integer, JSON, Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column
from app.core.database import Base
import enum


class TaskStatus(str, enum.Enum):
    WAITING = "waiting"
    DOWNLOADING = "downloading"
    TRANSCRIBING = "transcribing"
    CLEANING = "cleaning"
    CONFIRM_1 = "confirm_1"       # 人工确认清洗结果
    WRITING = "writing"
    CONFIRM_2 = "confirm_2"       # 人工确认 PPT 内容
    GENERATING = "generating"
    GENERATING_VIDEO = "generating_video"
    COMPLETED = "completed"
    FAILED = "failed"


class DownloadMethod(str, enum.Enum):
    API = "api"
    UPLOAD = "upload"


class Task(Base):
    __tablename__ = "tasks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    title: Mapped[str] = mapped_column(String(255), nullable=True)
    description: Mapped[str] = mapped_column(Text, nullable=True)  # 视频描述文本
    hashtags: Mapped[str] = mapped_column(Text, nullable=True)     # JSON 话题标签
    douyin_url: Mapped[str] = mapped_column(String(1024), nullable=True)
    text_input: Mapped[str] = mapped_column(Text, nullable=True)  # 原始输入（含链接+文字）
    status: Mapped[str] = mapped_column(String(20), default=TaskStatus.WAITING.value)
    current_step: Mapped[int] = mapped_column(Integer, default=0)

    # 下载
    download_method: Mapped[str] = mapped_column(String(20), nullable=True)
    video_path: Mapped[str] = mapped_column(Text, nullable=True)
    audio_path: Mapped[str] = mapped_column(Text, nullable=True)

    # 文案
    raw_text: Mapped[str] = mapped_column(Text, nullable=True)
    cleaned_text: Mapped[str] = mapped_column(Text, nullable=True)

    # PPT
    ppt_template: Mapped[str] = mapped_column(String(100), nullable=True)
    slide_outline: Mapped[str] = mapped_column(JSON, nullable=True)
    slide_content: Mapped[str] = mapped_column(JSON, nullable=True)
    ppt_path: Mapped[str] = mapped_column(Text, nullable=True)
    speech_text: Mapped[str] = mapped_column(Text, nullable=True)
    audio_path_output: Mapped[str] = mapped_column(Text, nullable=True)
    video_path_output: Mapped[str] = mapped_column(Text, nullable=True)

    # 错误
    error_message: Mapped[str] = mapped_column(Text, nullable=True)

    # Token 用量
    token_usage: Mapped[str] = mapped_column(JSON, nullable=True)

    # 时间
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
