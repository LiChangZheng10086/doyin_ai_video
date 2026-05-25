from pydantic import BaseModel, Field
from typing import Optional


class SlideOutline(BaseModel):
    title: str = Field(description="页面标题")
    key_points: list[str] = Field(description="核心要点")
    code_example: Optional[str] = Field(None, description="代码示例（如果有）")


class SlideContent(BaseModel):
    title: str = Field(description="页面标题")
    content: str = Field(description="页面详细内容，Markdown 格式")
    notes: str = Field(description="演讲稿/备注")


class TaskCreate(BaseModel):
    text_input: str = Field(description="抖音分享文本（含链接+文字）或纯文案内容")
    ppt_template: str = Field(default="tech_blue", description="PPT 模板名称")


class TaskResponse(BaseModel):
    id: str
    title: Optional[str]
    description: Optional[str]
    hashtags: Optional[list[str]]
    douyin_url: Optional[str]
    text_input: Optional[str]
    status: str
    current_step: int
    raw_text: Optional[str]
    cleaned_text: Optional[str]
    slide_outline: Optional[list[SlideOutline]]
    slide_content: Optional[list[SlideContent]]
    speech_text: Optional[str]
    ppt_path: Optional[str]
    video_path_output: Optional[str]
    error_message: Optional[str]
    created_at: str

    model_config = {"from_attributes": True}


class ConfirmCleanBody(BaseModel):
    task_id: str
    cleaned_text: str


class ConfirmContentBody(BaseModel):
    task_id: str
    slide_content: list[SlideContent]
    speech_text: str


class SelectTemplateBody(BaseModel):
    task_id: str
    ppt_template: str


class TaskListResponse(BaseModel):
    tasks: list[TaskResponse]
    total: int
