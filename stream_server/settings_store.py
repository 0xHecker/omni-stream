from __future__ import annotations

import json
import os
import secrets
import sys
from pathlib import Path
from typing import Any

APP_DIR_NAME = "StreamLocalFiles"
SETTINGS_FILE_NAME = "settings.json"
DEFAULT_PORT = 5000


def _settings_dir() -> Path:
    override = os.environ.get("STREAM_SETTINGS_DIR", "").strip()
    if override:
        return Path(override).expanduser()

    if os.name == "nt":
        appdata = os.environ.get("APPDATA")
        if appdata:
            return Path(appdata) / APP_DIR_NAME
        return Path.home() / "AppData" / "Roaming" / APP_DIR_NAME
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / APP_DIR_NAME
    return Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))) / APP_DIR_NAME


def settings_path() -> Path:
    return _settings_dir() / SETTINGS_FILE_NAME


def load_settings() -> dict[str, Any]:
    path = settings_path()
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(payload, dict):
        return {}
    return payload


def save_settings(settings: dict[str, Any]) -> None:
    path = settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(settings, indent=2, sort_keys=True), encoding="utf-8")


def _normalize_pin(value: Any) -> str:
    candidate = str(value or "").strip()
    if candidate.isdigit() and 4 <= len(candidate) <= 12:
        return candidate
    return ""


def _normalize_root_dir(value: Any) -> Path:
    candidate = str(value or "").strip()
    if candidate:
        try:
            resolved = Path(candidate).expanduser().resolve()
            if resolved.exists() and resolved.is_dir():
                return resolved
        except OSError:
            pass
    return Path.home().resolve()


def _normalize_port(value: Any) -> int:
    try:
        port = int(str(value or "").strip())
    except (ValueError, TypeError):
        return DEFAULT_PORT
    if 1 <= port <= 65535:
        return port
    return DEFAULT_PORT


def _normalize_auto_open_browser(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    raw = str(value or "").strip().lower()
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    return True


def resolve_runtime_settings() -> dict[str, Any]:
    settings = load_settings()

    secret_key = str(os.environ.get("STREAM_SECRET_KEY", "")).strip() or str(settings.get("secret_key") or "").strip()
    if not secret_key:
        secret_key = secrets.token_urlsafe(32)
        settings["secret_key"] = secret_key
        save_settings(settings)

    pin = _normalize_pin(os.environ.get("STREAM_PIN", "") or settings.get("pin", ""))
    root_dir = _normalize_root_dir(os.environ.get("STREAM_ROOT_DIR", "") or settings.get("root_dir", ""))
    port = _normalize_port(
        os.environ.get("WEB_PORT", "") or os.environ.get("PORT", "") or settings.get("port", DEFAULT_PORT)
    )
    auto_open_browser = _normalize_auto_open_browser(
        os.environ.get("STREAM_AUTO_OPEN_BROWSER", "") or settings.get("auto_open_browser", True)
    )
    configured = bool(pin)

    return {
        "secret_key": secret_key,
        "pin": pin,
        "root_dir": root_dir,
        "port": port,
        "auto_open_browser": auto_open_browser,
        "configured": configured,
        "settings_path": settings_path(),
    }
