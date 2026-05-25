"""
LangGraph Agent Graph 组装
定义完整的多 Agent 流水线
"""

import json
import logging
from typing import TypedDict, Annotated, Sequence, Optional
from langgraph.graph import StateGraph, END
from app.agents import cleaner, writer, ppt_generator

logger = logging.getLogger(__name__)


class AgentState(TypedDict):
    """Agent 流水线的全局状态"""
    task_id: str
    raw_text: str
    cleaned_text: str
    slide_outline: list
    slide_content: list
    speech_text: str
    ppt_template: str
    ppt_path: str
    status: str
    current_step: int
    error: Optional[str]


async def node_clean_and_structure(state: AgentState) -> dict:
    """Agent 1: 清洗 + 结构规划"""
    logger.info(f"[Graph] Agent 1 开始: task={state['task_id']}")
    try:
        result = await cleaner.run(state["raw_text"])
        return {
            "cleaned_text": result.get("cleaned_text", ""),
            "slide_outline": result.get("outline", []),
            "status": "confirm_1",
            "current_step": 2,
        }
    except Exception as e:
        logger.error(f"[Graph] Agent 1 失败: {e}")
        return {"status": "failed", "error": str(e), "current_step": 2}


async def node_write_content(state: AgentState) -> dict:
    """Agent 2: 写内容 + 演讲稿"""
    logger.info(f"[Graph] Agent 2 开始: task={state['task_id']}")
    try:
        result = await writer.run(state.get("slide_outline", []))
        slides = result.get("slides", [])
        # 转成前端需要的格式
        formatted_slides = []
        for s in slides:
            formatted_slides.append({
                "title": s.get("title", ""),
                "content": s.get("content", ""),
                "notes": s.get("notes", ""),
            })
        return {
            "slide_content": formatted_slides,
            "speech_text": result.get("speech_text", ""),
            "status": "confirm_2",
            "current_step": 4,
        }
    except Exception as e:
        logger.error(f"[Graph] Agent 2 失败: {e}")
        return {"status": "failed", "error": str(e), "current_step": 4}


async def node_generate_ppt(state: AgentState) -> dict:
    """Agent 3: 生成 PPT"""
    logger.info(f"[Graph] Agent 3 开始: task={state['task_id']}")
    try:
        ppt_path = await ppt_generator.generate(
            slides_content=state.get("slide_content", []),
            template_id=state.get("ppt_template", "tech_blue"),
            task_id=state["task_id"],
        )
        return {
            "ppt_path": ppt_path,
            "status": "completed",
            "current_step": 6,
        }
    except Exception as e:
        logger.error(f"[Graph] Agent 3 失败: {e}")
        return {"status": "failed", "error": str(e), "current_step": 6}


def create_graph() -> StateGraph:
    """创建完整的 Agent Graph"""
    workflow = StateGraph(AgentState)

    # 节点
    workflow.add_node("clean_and_structure", node_clean_and_structure)
    workflow.add_node("write_content", node_write_content)
    workflow.add_node("generate_ppt", node_generate_ppt)

    # 边
    workflow.add_edge("clean_and_structure", "write_content")
    workflow.add_edge("write_content", "generate_ppt")
    workflow.add_edge("generate_ppt", END)

    return workflow


# 全局 graph 实例
agent_graph = create_graph()
