from __future__ import annotations

from anyio import to_thread
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import load_config
from .db import init_db
from .routers import auth, catalog, events, files, health, pairing, transfers
from .services.agent_client import close_http_client
from .services.events import broker
from .routers.files import shutdown_search_executor


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
        config = load_config()
        limiter = to_thread.current_default_thread_limiter()
        limiter.total_tokens = config.sync_thread_tokens

    @app.on_event("shutdown")
    async def _shutdown() -> None:
        shutdown_search_executor()
        close_http_client()
        await broker.close_all()

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
