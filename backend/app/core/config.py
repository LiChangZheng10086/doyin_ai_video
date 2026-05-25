import os
from pathlib import Path
from dotenv import load_dotenv

# Load .env file from project root
env_path = Path(__file__).resolve().parent.parent.parent / ".env"
if env_path.exists():
    load_dotenv(env_path)

# Project paths
BASE_DIR = Path(__file__).resolve().parent.parent.parent
DATA_DIR = BASE_DIR / "data"
TEMPLATES_DIR = BASE_DIR / "app" / "templates"

# Ensure dirs exist
DATA_DIR.mkdir(exist_ok=True)
(DATA_DIR / "videos").mkdir(exist_ok=True)
(DATA_DIR / "audios").mkdir(exist_ok=True)
(DATA_DIR / "ppts").mkdir(exist_ok=True)
(DATA_DIR / "videos").mkdir(exist_ok=True)
(DATA_DIR / "uploads").mkdir(exist_ok=True)

# Database
DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite+aiosqlite:///{DATA_DIR}/tasks.db")

# DeepSeek
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
DEEPSEEK_API_URL = "https://api.deepseek.com/v1"
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")

# Celery
CELERY_BROKER_URL = os.getenv("CELERY_BROKER_URL", "redis://localhost:6379/0")

# ASR
WHISPER_MODEL_SIZE = os.getenv("WHISPER_MODEL_SIZE", "medium")

# Server
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8000"))
