from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .db import init_db
from .routers import auth, catalog, events, files, health, pairing, transfers


def create_app() -> FastAPI:
    app = FastAPI(title="Stream Coordinator", version="1.0.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.on_event("startup")
    def _startup() -> None:
        init_db()

    app.include_router(health.router)
    app.include_router(pairing.router)
    app.include_router(auth.router)
    app.include_router(catalog.router)
    app.include_router(catalog.internal_router)
    app.include_router(files.router)
    app.include_router(transfers.router)
    app.include_router(transfers.internal_router)
    app.include_router(events.router)

    @app.get("/")
    def index() -> dict[str, str]:
        return {"service": "coordinator", "status": "ok"}

    return app


app = create_app()

