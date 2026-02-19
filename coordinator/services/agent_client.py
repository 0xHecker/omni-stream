from __future__ import annotations

import atexit
import threading
from typing import Any

import httpx
from fastapi import HTTPException, status


HTTP_TIMEOUT_SECONDS = 12
HTTP_LIMITS = httpx.Limits(max_connections=120, max_keepalive_connections=60, keepalive_expiry=25)
_HTTP_CLIENT_LOCK = threading.Lock()
_HTTP_CLIENT: httpx.Client | None = None


def _get_http_client() -> httpx.Client:
    global _HTTP_CLIENT
    with _HTTP_CLIENT_LOCK:
        if _HTTP_CLIENT is None:
            _HTTP_CLIENT = httpx.Client(timeout=HTTP_TIMEOUT_SECONDS, limits=HTTP_LIMITS)
        return _HTTP_CLIENT


def close_http_client() -> None:
    global _HTTP_CLIENT
    client: httpx.Client | None = None
    with _HTTP_CLIENT_LOCK:
        if _HTTP_CLIENT is not None:
            client = _HTTP_CLIENT
            _HTTP_CLIENT = None
    if client is not None:
        client.close()


atexit.register(close_http_client)


def _raise_agent_error(base_url: str, response: httpx.Response) -> None:
    detail = f"Agent {base_url} request failed ({response.status_code})"
    try:
        payload = response.json()
    except ValueError:
        payload = None
    if isinstance(payload, dict) and payload.get("detail"):
        detail = str(payload["detail"])
    raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=detail)


def list_share(base_url: str, share_id: str, path: str, ticket: str, *, max_results: int = 300) -> dict[str, Any]:
    response = _get_http_client().get(
        f"{base_url.rstrip('/')}/agent/v1/shares/{share_id}/list",
        params={"path": path, "ticket": ticket, "max_results": str(max_results)},
    )
    if response.status_code != 200:
        _raise_agent_error(base_url, response)
    return response.json()


def search_share(
    base_url: str,
    share_id: str,
    path: str,
    query: str,
    recursive: bool,
    ticket: str,
    *,
    max_results: int = 300,
) -> dict[str, Any]:
    response = _get_http_client().get(
        f"{base_url.rstrip('/')}/agent/v1/shares/{share_id}/search",
        params={
            "path": path,
            "q": query,
            "recursive": "1" if recursive else "0",
            "max_results": str(max_results),
            "ticket": ticket,
        },
    )
    if response.status_code != 200:
        _raise_agent_error(base_url, response)
    return response.json()
