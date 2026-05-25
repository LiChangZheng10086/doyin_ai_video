"""
下载入口 · 双层 Fallback
Layer 1: 直接解析抖音页面获取无水印视频 (主力)
Layer 2: 用户手动上传 (兜底)
"""

import logging
from typing import Optional
from .api_parser import APIParser

logger = logging.getLogger(__name__)


class DownloadResult:
    path: Optional[str] = None
    method: str = ""
    success: bool = False


async def download_video(url: str) -> DownloadResult:
    """
    按优先级尝试下载
    返回 DownloadResult 包含路径和方法信息
    """
    result = DownloadResult()

    # Layer 1: 直接解析抖音页面
    logger.info(f"[下载] Layer 1: 解析抖音页面获取无水印视频: {url}")
    parser = APIParser()
    try:
        video_path = await parser.parse(url)
        if video_path:
            result.path = video_path
            result.method = "api"
            result.success = True
            logger.info(f"[下载] Layer 1 成功: {video_path}")
            return result
    except Exception as e:
        logger.warning(f"[下载] Layer 1 异常: {e}")
    finally:
        await parser.close()

    # Layer 2 不在此触发，由用户主动上传
    logger.warning(f"[下载] 自动下载失败，等待用户上传: {url}")
    return result
