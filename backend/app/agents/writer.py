"""
Agent 2: Writer
职责: 根据结构化大纲 → 填充每页详细内容 + 写演讲稿
"""

import json
import logging
from langchain_core.messages import SystemMessage, HumanMessage
from langchain_deepseek import ChatDeepSeek
from app.core.config import DEEPSEEK_API_KEY, DEEPSEEK_API_URL, DEEPSEEK_MODEL

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """你是科技博主风格的 PPT 文案撰写专家和演讲稿撰写专家。

## 你的职责
根据 PPT 大纲结构，以科技博主的口吻撰写每页内容和对应的演讲稿。

## 风格要求（科技博主风）
- **有感染力**：用"你"拉近距离，像在跟观众面对面聊天
- **专业但不枯燥**：保留技术术语，但用类比/比喻让概念好懂
- **信息密度高**：每句话都有干货，不要空洞的套话
- **收尾有力**：每页内容结尾用一句总结或思考题收住

## 输出格式
严格按照 JSON 输出：
```json
{
  "slides": [
    {
      "title": "页面标题",
      "content": "页面详细内容，使用 Markdown 格式，包含标题、要点、代码块等",
      "notes": "该页的演讲稿/备注，用科技博主的口语化方式讲解这页内容，适合 TTS 朗读"
    }
  ],
  "speech_text": "整篇连贯的演讲稿，从头到尾串起来，口语化、自然流畅、有感染力，适合配音"
}
```

## 规则
- content 写详细，代码块用 ``` 标注
- notes 200-300 字/页，口语化带感情
- speech_text 全文 1000-2000 字，读起来 3-5 分钟"""


def _build_llm():
    return ChatDeepSeek(
        model=DEEPSEEK_MODEL,
        api_key=DEEPSEEK_API_KEY,
        base_url=DEEPSEEK_API_URL,
        temperature=0.5,
        streaming=True,
    )


def _build_messages(outline: list[dict]) -> list:
    outline_str = json.dumps(outline, ensure_ascii=False, indent=2)
    return [
        SystemMessage(content=SYSTEM_PROMPT),
        HumanMessage(content=f"请根据以下 PPT 大纲撰写每页内容和演讲稿：\n\n{outline_str}"),
    ]


def _parse_response(content: str) -> dict:
    try:
        result = json.loads(content.strip().removeprefix("```json").removesuffix("```").strip())
        logger.info(f"[Writer] 完成, 共 {len(result.get('slides', []))} 页")
        return result
    except json.JSONDecodeError as e:
        logger.error(f"[Writer] JSON 解析失败: {e}")
        return {
            "slides": [{"title": "内容", "content": content, "notes": ""}],
            "speech_text": content,
        }


async def run(outline: list[dict]) -> dict:
    """根据大纲写内容和演讲稿（非流式）"""
    llm = _build_llm()
    logger.info("[Writer] 开始撰写内容")
    response = await llm.ainvoke(_build_messages(outline))
    return _parse_response(response.content)


async def run_stream(task_id: str, outline: list[dict]) -> dict:
    """根据大纲写内容和演讲稿（流式）"""
    from app.services.events import publish

    llm = _build_llm()
    messages = _build_messages(outline)

    logger.info(f"[Writer] 流式开始 task={task_id}")
    full_content = ""
    async for chunk in llm.astream(messages):
        token = chunk.content or ""
        if token:
            full_content += token
            await publish(task_id, {
                "type": "agent_token",
                "agent": "writer",
                "content": token,
            })

    logger.info(f"[Writer] 流式完成 task={task_id}")
    result = _parse_response(full_content)

    await publish(task_id, {
        "type": "agent_done",
        "agent": "writer",
        "result": result,
    })
    return result
