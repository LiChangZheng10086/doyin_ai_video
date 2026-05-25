"""
Layer 1: 直接解析抖音页面获取无水印视频下载链接

方案：解析抖音分享链接 → 获取页面 HTML → 提取 window._ROUTER_DATA
→ 获取无水印视频地址 → 下载

参考：https://github.com/yzfly/douyin-mcp-server
"""

import json
import logging
import re
from pathlib import Path
from typing import Optional
import httpx
from app.core.config import DATA_DIR

logger = logging.getLogger(__name__)

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/121.0.2277.107 Version/17.0 Mobile/15E148 Safari/604.1'
}


class APIParser:
    """抖音视频解析下载器"""

    def __init__(self):
        self.client = httpx.AsyncClient(headers=HEADERS, follow_redirects=True, timeout=30)

    async def parse(self, url: str) -> Optional[str]:
        """
        解析抖音链接，下载无水印视频
        返回视频文件路径，失败返回 None
        """
        try:
            video_info = await self._parse_video_info(url)
            if not video_info:
                return None

            video_path = await self._download_video(video_info)
            return video_path

        except Exception as e:
            logger.warning(f"[APIParser] 解析失败: {e}")
            return None

    async def _parse_video_info(self, share_url: str) -> Optional[dict]:
        """解析分享链接，获取无水印视频地址和视频信息"""
        # 1. 跟随重定向获取真实页面地址
        share_response = await self.client.get(share_url)
        share_response.raise_for_status()

        final_url = str(share_response.url)
        video_id = final_url.split("?")[0].strip("/").split("/")[-1]
        logger.info(f"[APIParser] 视频ID: {video_id}")

        # 2. 请求 iesdouyin 页面获取完整数据
        ies_url = f'https://www.iesdouyin.com/share/video/{video_id}'
        page_response = await self.client.get(ies_url)
        page_response.raise_for_status()

        # 3. 从 HTML 中提取 _ROUTER_DATA JSON
        pattern = re.compile(
            r"window\._ROUTER_DATA\s*=\s*(.*?)</script>",
            flags=re.DOTALL,
        )
        match = pattern.search(page_response.text)
        if not match:
            raise ValueError("未能从页面中解析到视频信息")

        json_data = json.loads(match.group(1).strip())
        loader_data = json_data.get("loaderData", {})

        # 兼容视频和图集两种格式
        video_info_res = None
        for key in ["video_(id)/page", "note_(id)/page"]:
            if key in loader_data:
                video_info_res = loader_data[key].get("videoInfoRes")
                break

        if not video_info_res:
            raise ValueError("无法从JSON中解析视频信息")

        item = video_info_res["item_list"][0]

        # 4. 获取无水印视频 URL (playwm → play)
        video_url = item["video"]["play_addr"]["url_list"][0].replace("playwm", "play")
        desc = item.get("desc", "").strip() or f"douyin_{video_id}"

        return {
            "url": video_url,
            "title": re.sub(r'[\\/:*?"<>|]', '_', desc),
            "video_id": video_id,
            "desc": desc,
        }

    async def _download_video(self, video_info: dict) -> str:
        """下载视频到本地"""
        video_dir = DATA_DIR / "videos"
        video_dir.mkdir(exist_ok=True)

        filename = f"{video_info['video_id']}.mp4"
        filepath = str(video_dir / filename)

        logger.info(f"[APIParser] 开始下载视频: {video_info['title']}")
        async with httpx.AsyncClient(headers=HEADERS, follow_redirects=True, timeout=120) as dl_client:
            response = await dl_client.get(video_info["url"])
            response.raise_for_status()

            with open(filepath, "wb") as f:
                async for chunk in response.aiter_bytes(chunk_size=8192):
                    f.write(chunk)

        logger.info(f"[APIParser] 下载完成: {filepath}")
        return filepath

    async def close(self):
        await self.client.aclose()
