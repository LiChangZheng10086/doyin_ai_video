"""
In-memory event bus for SSE streaming.

Simple pub/sub: tasks publish events, SSE subscribers consume them.
"""

import asyncio
import logging
from collections import defaultdict

logger = logging.getLogger(__name__)

_subscribers: dict[str, list[asyncio.Queue]] = defaultdict(list)


async def subscribe(task_id: str) -> asyncio.Queue:
    """Create a new subscriber queue for a task."""
    q: asyncio.Queue = asyncio.Queue()
    _subscribers[task_id].append(q)
    return q


def unsubscribe(task_id: str, q: asyncio.Queue):
    """Remove a subscriber queue."""
    if task_id in _subscribers:
        _subscribers[task_id] = [x for x in _subscribers[task_id] if x is not q]
        if not _subscribers[task_id]:
            del _subscribers[task_id]


async def publish(task_id: str, event: dict):
    """Publish an event to all subscribers of a task."""
    if task_id not in _subscribers:
        return
    for q in _subscribers[task_id]:
        try:
            await q.put(event)
        except Exception as e:
            logger.warning(f"[Events] publish error: {e}")


async def publish_status(task_id: str, status: str, current_step: int):
    await publish(task_id, {
        "type": "stage_change",
        "status": status,
        "current_step": current_step,
    })
