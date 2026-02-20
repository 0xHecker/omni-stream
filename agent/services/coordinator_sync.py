from __future__ import annotations

import atexit
import logging
import threading
from typing import Any

import httpx

from ..config import AgentConfig

LOGGER = logging.getLogger(__name__)
HTTP_LIMITS = httpx.Limits(max_connections=80, max_keepalive_connections=40, keepalive_expiry=20)
_CLIENT_LOCK = threading.Lock()
_CLIENT: httpx.Client | None = None


def _get_http_client() -> httpx.Client:
    global _CLIENT
    with _CLIENT_LOCK:
        if _CLIENT is None:
            _CLIENT = httpx.Client(timeout=8, limits=HTTP_LIMITS)
        return _CLIENT


def close_http_client() -> None:
    global _CLIENT
    client: httpx.Client | None = None
    with _CLIENT_LOCK:
        if _CLIENT is not None:
            client = _CLIENT
            _CLIENT = None
    if client is not None:
        client.close()


atexit.register(close_http_client)


def register_agent(config: AgentConfig, shares: list[dict[str, Any]]) -> dict | None:
    payload = {
        "agent_device_id": config.agent_device_id,
        "owner_principal_id": config.owner_principal_id,
        "name": config.agent_name,
        "base_url": config.public_base_url,
        "visible": True,
        "shares": shares,
    }
    try:
        response = _get_http_client().post(
            f"{config.coordinator_url.rstrip('/')}/api/v1/internal/agents/register",
            json=payload,
            headers={"x-agent-secret": config.coordinator_agent_secret},
            timeout=10,
        )
        response.raise_for_status()
        return response.json()
    except Exception as exc:  # noqa: BLE001
        LOGGER.warning("Failed to register agent with coordinator: %s", exc)
        return None


def heartbeat(config: AgentConfig) -> None:
    try:
        response = _get_http_client().post(
            f"{config.coordinator_url.rstrip('/')}/api/v1/internal/agents/{config.agent_device_id}/heartbeat",
            json={"online": True},
            headers={"x-agent-secret": config.coordinator_agent_secret},
            timeout=6,
        )
        response.raise_for_status()
    except Exception as exc:  # noqa: BLE001
        LOGGER.debug("Coordinator heartbeat failed: %s", exc)


def notify_transfer_item_state(config: AgentConfig, transfer_id: str, item_id: str, state: str) -> None:
    try:
        response = _get_http_client().post(
            f"{config.coordinator_url.rstrip('/')}/api/v1/internal/transfers/{transfer_id}/items/{item_id}/state",
            json={"state": state},
            headers={"x-agent-secret": config.coordinator_agent_secret},
            timeout=8,
        )
        response.raise_for_status()
    except Exception as exc:  # noqa: BLE001
        LOGGER.debug("Failed to push transfer item state to coordinator: %s", exc)


def fetch_transfer_item_manifest(config: AgentConfig, transfer_id: str, item_id: str) -> dict[str, Any]:
    try:
        response = _get_http_client().get(
            f"{config.coordinator_url.rstrip('/')}/api/v1/internal/transfers/{transfer_id}/items/{item_id}",
            headers={
                "x-agent-secret": config.coordinator_agent_secret,
                "x-agent-device-id": config.agent_device_id,
            },
            timeout=8,
        )
        if response.status_code == 404:
            return {}
        response.raise_for_status()
        payload = response.json()
        return payload if isinstance(payload, dict) else {}
    except Exception as exc:  # noqa: BLE001
        LOGGER.warning("Failed to fetch transfer item manifest from coordinator: %s", exc)
        return {}
