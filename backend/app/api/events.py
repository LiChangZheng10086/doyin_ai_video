"""
SSE (Server-Sent Events) endpoint for real-time task updates.
"""

import asyncio
import json
import logging
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/tasks", tags=["events"])


@router.get("/{task_id}/events")
async def task_events(task_id: str):
    """SSE stream of task events."""

    from app.services.events import subscribe, unsubscribe

    queue = await subscribe(task_id)

    async def event_generator():
        try:
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=30)
                    yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                except asyncio.TimeoutError:
                    # Heartbeat to keep connection alive
                    yield f"data: {json.dumps({'type': 'keepalive'})}\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            unsubscribe(task_id, queue)
            logger.info(f"[SSE] client disconnected: {task_id}")

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
