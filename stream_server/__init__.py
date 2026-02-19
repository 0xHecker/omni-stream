from __future__ import annotations

import sys
from flask import Flask
from pathlib import Path

from .config import AppConfig, BASE_DIR
from .routes import web


def _resource_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", str(BASE_DIR)))
    return BASE_DIR


def create_app() -> Flask:
    resource_root = _resource_root()
    app = Flask(
        __name__,
        template_folder=str(resource_root / "templates"),
        static_folder=str(resource_root / "static"),
    )
    app.config.from_object(AppConfig)
    app.register_blueprint(web)
    return app
