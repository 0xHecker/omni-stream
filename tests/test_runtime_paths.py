from __future__ import annotations

from pathlib import Path

import app as launcher
from stream_server import settings_store


def test_launcher_settings_dir_supports_override(monkeypatch, tmp_path: Path) -> None:
    override = tmp_path / "custom-settings"
    monkeypatch.setenv("STREAM_SETTINGS_DIR", str(override))
    assert launcher._settings_dir() == override


def test_stream_settings_path_supports_override(monkeypatch, tmp_path: Path) -> None:
    override = tmp_path / "config-root"
    monkeypatch.setenv("STREAM_SETTINGS_DIR", str(override))
    assert settings_store.settings_path() == override / settings_store.SETTINGS_FILE_NAME
