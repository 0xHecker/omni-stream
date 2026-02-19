from __future__ import annotations

from pathlib import Path

from .settings_store import resolve_runtime_settings

BASE_DIR = Path(__file__).resolve().parent.parent
_runtime = resolve_runtime_settings()


class AppConfig:
    SECRET_KEY = _runtime["secret_key"]
    PIN = _runtime["pin"]
    ROOT_DIR = _runtime["root_dir"]
    PORT = _runtime["port"]
    AUTO_OPEN_BROWSER = _runtime["auto_open_browser"]
    SETUP_COMPLETE = _runtime["configured"]
    SETTINGS_PATH = str(_runtime["settings_path"])
    THUMBNAIL_SIZE = (220, 220)
