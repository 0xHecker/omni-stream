from __future__ import annotations

from flask import Flask

from .config import AppConfig, BASE_DIR
from .routes import web


def create_app() -> Flask:
    app = Flask(
        __name__,
        template_folder=str(BASE_DIR / "templates"),
        static_folder=str(BASE_DIR / "static"),
    )
    app.config.from_object(AppConfig)
    app.register_blueprint(web)
    return app
