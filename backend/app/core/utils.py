"""Shared helpers."""

import json
import re
import uuid
from pathlib import Path
from typing import Any, Optional


def parse_json_field(value: Any) -> Any:
    """Parse JSON column values that may be str or already deserialized."""
    if value is None:
        return None
    if isinstance(value, (list, dict)):
        return value
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value
    return value


def safe_filename(name: str, default_ext: str = ".mp4") -> str:
    """Strip path components and unsafe characters from a filename."""
    base = Path(name).name
    base = re.sub(r"[^\w.\-]", "_", base)
    if not base or base.startswith("."):
        return f"upload_{uuid.uuid4().hex[:8]}{default_ext}"
    return base


def resolve_data_file(data_dir: Path, subdir: str, filename: str) -> Optional[Path]:
    """Resolve a file under data_dir/subdir, rejecting path traversal."""
    if not filename or ".." in filename or "/" in filename or "\\" in filename:
        return None
    safe_name = Path(filename).name
    root = (data_dir / subdir).resolve()
    target = (root / safe_name).resolve()
    if not str(target).startswith(str(root)):
        return None
    return target if target.is_file() else None
