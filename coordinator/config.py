from __future__ import annotations

import os
from dataclasses import dataclass


def _allow_insecure_defaults() -> bool:
    return os.environ.get("ALLOW_INSECURE_DEFAULTS", "").strip() == "1"


def _secure_value(name: str, default: str, *, blocked: set[str]) -> str:
    value = os.environ.get(name, default).strip()
    if not value:
        raise RuntimeError(f"{name} must not be empty")
    if not _allow_insecure_defaults() and value in blocked:
        raise RuntimeError(f"{name} uses an insecure placeholder value; set a secure value")
    return value


def _as_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


@dataclass(frozen=True)
class CoordinatorConfig:
    database_url: str
    secret_key: str
    agent_shared_secret: str
    access_token_ttl_seconds: int
    events_ws_token_ttl_seconds: int
    read_ticket_ttl_seconds: int
    transfer_ticket_ttl_seconds: int
    passcode_window_seconds: int
    pairing_code_ttl_seconds: int


def load_config() -> CoordinatorConfig:
    return CoordinatorConfig(
        database_url=os.environ.get("COORDINATOR_DATABASE_URL", "sqlite:///./coordinator.db"),
        secret_key=_secure_value(
            "COORDINATOR_SECRET_KEY",
            "replace-with-secure-key",
            blocked={
                "replace-with-secure-key",
                "replace-with-strong-coordinator-key",
                "replace-this-secret-key",
                "changeme",
            },
        ),
        agent_shared_secret=_secure_value(
            "COORDINATOR_AGENT_SHARED_SECRET",
            "replace-agent-secret",
            blocked={"replace-agent-secret", "replace-with-strong-agent-secret", "changeme"},
        ),
        access_token_ttl_seconds=_as_int("COORDINATOR_ACCESS_TOKEN_TTL", 3600),
        events_ws_token_ttl_seconds=_as_int("COORDINATOR_EVENTS_WS_TOKEN_TTL", 90),
        read_ticket_ttl_seconds=_as_int("COORDINATOR_READ_TICKET_TTL", 120),
        transfer_ticket_ttl_seconds=_as_int("COORDINATOR_TRANSFER_TICKET_TTL", 300),
        passcode_window_seconds=_as_int("COORDINATOR_PASSCODE_WINDOW_SECONDS", 300),
        pairing_code_ttl_seconds=_as_int("COORDINATOR_PAIRING_CODE_TTL", 600),
    )
