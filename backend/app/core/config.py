import os
from pathlib import Path
from dotenv import load_dotenv

# Load .env from backend/
env_path = Path(__file__).resolve().parent.parent.parent / ".env"
if env_path.exists():
    load_dotenv(env_path)

# Project paths
BASE_DIR = Path(__file__).resolve().parent.parent.parent
DATA_DIR = BASE_DIR / "data"

# Ensure dirs exist
for sub in ("videos", "audios", "ppts", "uploads", "remotion"):
    (DATA_DIR / sub).mkdir(parents=True, exist_ok=True)

# Database
DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite+aiosqlite:///{DATA_DIR}/tasks.db")

# DeepSeek
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
DEEPSEEK_API_URL = os.getenv("DEEPSEEK_API_URL", "https://api.deepseek.com/v1")
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")

# ASR
WHISPER_MODEL_SIZE = os.getenv("WHISPER_MODEL_SIZE", "medium")

# Server
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8000"))


def require_deepseek_key() -> None:
    """Raise if DeepSeek API key is missing."""
    if not DEEPSEEK_API_KEY.strip():
        raise RuntimeError(
            "未配置 DEEPSEEK_API_KEY。请在 backend/.env 中设置，参考 .env.example"
        )
