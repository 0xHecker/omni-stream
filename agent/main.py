from __future__ import annotations

import asyncio
import contextlib

from anyio import to_thread
from fastapi import FastAPI

from .config import load_config
from .db import SessionLocal, init_db
from .models import LocalShare
from .routers import inbox, shares
from .services.coordinator_sync import heartbeat, register_agent


def _seed_default_share() -> None:
    config = load_config()
    config.default_share_root.mkdir(parents=True, exist_ok=True)
    config.inbox_dir.mkdir(parents=True, exist_ok=True)
    with SessionLocal() as db:
        share = db.get(LocalShare, config.default_share_id)
        if not share:
            share = LocalShare(
                id=config.default_share_id,
                name=config.default_share_name,
                root_path=str(config.default_share_root),
                read_only=False,
            )
            db.add(share)
            db.commit()


def _load_share_payloads() -> list[dict]:
    with SessionLocal() as db:
        shares_payload = []
        for share in db.query(LocalShare).all():
            shares_payload.append(
                {
                    "share_id": share.id,
                    "name": share.name,
                    "root_path": share.root_path,
                    "read_only": share.read_only,
                }
            )
        return shares_payload


async def _heartbeat_loop(config) -> None:
    while True:
        heartbeat(config)
        await asyncio.sleep(max(5, config.heartbeat_interval_seconds))


def create_app() -> FastAPI:
    app = FastAPI(title="Stream Agent", version="1.0.0")

    @app.on_event("startup")
    async def _startup() -> None:
        init_db()
        config = load_config()
        limiter = to_thread.current_default_thread_limiter()
        limiter.total_tokens = config.sync_thread_tokens
        _seed_default_share()
        shares_payload = _load_share_payloads()
        if config.owner_principal_id:
            register_agent(config, shares_payload)
            app.state.heartbeat_task = asyncio.create_task(_heartbeat_loop(config))
        else:
            app.state.heartbeat_task = None

    @app.on_event("shutdown")
    async def _shutdown() -> None:
        task = getattr(app.state, "heartbeat_task", None)
        if task:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    app.include_router(shares.router)
    app.include_router(inbox.router)

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "service": "agent"}

    @app.get("/")
    def root() -> dict[str, str]:
        return {"service": "agent", "status": "ok"}

    return app


app = create_app()
