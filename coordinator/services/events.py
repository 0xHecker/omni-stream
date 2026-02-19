from __future__ import annotations

import asyncio
from collections import defaultdict
from contextlib import suppress
from typing import Any

from fastapi import WebSocket


class EventBroker:
    def __init__(self) -> None:
        self._connections: dict[str, set[WebSocket]] = defaultdict(set)
        self._lock = asyncio.Lock()

    async def connect(self, principal_id: str, websocket: WebSocket, *, subprotocol: str | None = None) -> None:
        await websocket.accept(subprotocol=subprotocol)
        async with self._lock:
            self._connections[principal_id].add(websocket)

    async def disconnect(self, principal_id: str, websocket: WebSocket) -> None:
        async with self._lock:
            sockets = self._connections.get(principal_id)
            if not sockets:
                return
            sockets.discard(websocket)
            if not sockets:
                self._connections.pop(principal_id, None)

    async def publish(self, principal_id: str, event: dict[str, Any]) -> None:
        async with self._lock:
            sockets = list(self._connections.get(principal_id, set()))

        stale: list[WebSocket] = []
        for socket in sockets:
            try:
                await socket.send_json(event)
            except Exception:  # noqa: BLE001
                stale.append(socket)

        if stale:
            async with self._lock:
                current = self._connections.get(principal_id)
                if not current:
                    return
                for socket in stale:
                    current.discard(socket)
                if not current:
                    self._connections.pop(principal_id, None)

    async def close_all(self, *, code: int = 1001) -> None:
        async with self._lock:
            sockets = [socket for owned in self._connections.values() for socket in owned]
            self._connections.clear()

        for socket in sockets:
            with suppress(Exception):
                await socket.close(code=code)


broker = EventBroker()
