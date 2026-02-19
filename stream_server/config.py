from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent


def _resolve_root_dir() -> Path:
    configured_root = os.environ.get("STREAM_ROOT_DIR")
    if configured_root:
        try:
            root = Path(configured_root).expanduser().resolve()
            if root.exists() and root.is_dir():
                return root
        except OSError:
            pass

    return Path.home().resolve()


class AppConfig:
    SECRET_KEY = os.environ.get("STREAM_SECRET_KEY", "replace-this-secret-key")
    PIN = os.environ.get("STREAM_PIN", "123456")
    ROOT_DIR = _resolve_root_dir()
    THUMBNAIL_SIZE = (220, 220)
