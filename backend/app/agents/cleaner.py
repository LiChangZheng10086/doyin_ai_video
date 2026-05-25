"""
Agent 1: Cleaner + Structurer
职责: 清洗原始文案 → 输出去口语化内容 → 规划 PPT 结构
"""

import json
import logging
from typing import TypedDict, Optional
from langchain_core.messages import SystemMessage, HumanMessage
from langchain_deepseek import ChatDeepSeek
from app.core.config import DEEPSEEK_API_KEY, DEEPSEEK_API_URL, DEEPSEEK_MODEL

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """你是 AI 视频文案清洗和 PPT 结构规划专家。

## 你的职责
1. 接收一段视频的语音转录文字（含口语、废话、重复、语气词）
2. 清洗：去掉"嗯、啊、这个、那个、就是说"等口语废词，保留所有技术细节
3. 将文案**改写成科技博主的口播风格**——专业、有感染力、像在跟观众聊天
4. 规划：将改写后的内容组织成 PPT 大纲结构

## 改写风格要求（科技博主口播风）

### 开场要有"钩子"
用问句、惊人事实、或反常识观点开头，不要平铺直叙。

### 用"你"拉近距离
全程面向观众，让对方感觉你在跟他一对一交流。用"你知道吗"、"相当于"、"简单来说"等过渡。

### 复杂概念要"翻译"
保留专业术语（Transformer、CNN、RLHF 等），但用类比/比喻来解释。比如"自注意力机制就像你在人群中找人，会自动锁定最相关的目标"。

### 段落有节奏
长短句交替，适当口语化但不啰嗦。信息密度高，语速感强。

### 保留所有技术点
不删减任何技术信息（模型名、数据指标、架构名、代码等）。

### 收尾有总结
用一句话概括核心观点，或抛出思考题。

### 风格参考
- 技术自信，不模棱两可
- 可以有个人观点："我觉得"、"我认为"
- 偶尔用"惊了"、"绝了"、"离谱"等感叹（节制）
- 用数字和列举增加可信度

## 输出格式要求
严格按照 JSON 输出，不要包含任何其他内容：
```json
{
  "cleaned_text": "改写后的科技博主风格文案，保留所有技术细节，口语化但不啰嗦",
  "outline": [
    {
      "title": "页面标题",
      "key_points": ["要点1", "要点2"],
      "code_example": "如果有代码示例在这里，没有则为空字符串"
    }
  ]
}
```

## 规则
- outline 3-6 页为宜
- code_example 只有原文明确提到代码时才有，不编造
- cleaned_text 不要超过原文的 80% 长度（去废词换表达，不增编内容）"""


def create_llm():
    return ChatDeepSeek(
        model=DEEPSEEK_MODEL,
        api_key=DEEPSEEK_API_KEY,
        base_url=DEEPSEEK_API_URL,
        temperature=0.3,
        streaming=True,
    )


def _build_messages(raw_text: str) -> list:
    return [
        SystemMessage(content=SYSTEM_PROMPT),
        HumanMessage(content=f"请清洗以下视频文案，并规划 PPT 结构：\n\n{raw_text}"),
    ]


def _parse_response(content: str) -> dict:
    try:
        result = json.loads(content.strip().removeprefix("```json").removesuffix("```").strip())
        logger.info(f"[Cleaner] 完成, 大纲共 {len(result.get('outline', []))} 页")
        return result
    except json.JSONDecodeError as e:
        logger.error(f"[Cleaner] JSON 解析失败: {e}")
        return {
            "cleaned_text": content,
            "outline": [{"title": "内容概要", "key_points": [content[:200]], "code_example": ""}],
        }


async def run(raw_text: str) -> dict:
    """执行清洗和结构规划（非流式）"""
    llm = create_llm()
    logger.info("[Cleaner] 开始清洗文案")
    response = await llm.ainvoke(_build_messages(raw_text))
    return _parse_response(response.content)


async def run_stream(task_id: str, raw_text: str) -> dict:
    """执行清洗和结构规划（流式）"""
    from app.services.events import publish

    llm = create_llm()
    messages = _build_messages(raw_text)

    logger.info(f"[Cleaner] 流式开始 task={task_id}")
    full_content = ""
    async for chunk in llm.astream(messages):
        token = chunk.content or ""
        if token:
            full_content += token
            await publish(task_id, {
                "type": "agent_token",
                "agent": "cleaner",
                "content": token,
            })

    logger.info(f"[Cleaner] 流式完成 task={task_id}")
    result = _parse_response(full_content)

    await publish(task_id, {
        "type": "agent_done",
        "agent": "cleaner",
        "result": result,
    })
    return result
