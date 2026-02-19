from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4


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
class AgentConfig:
    agent_device_id: str
    agent_name: str
    owner_principal_id: str
    public_base_url: str
    coordinator_url: str
    coordinator_agent_secret: str
    coordinator_secret_key: str
    state_db_url: str
    default_share_id: str
    default_share_name: str
    default_share_root: Path
    inbox_dir: Path
    heartbeat_interval_seconds: int
    upload_chunk_max_bytes: int


def load_config() -> AgentConfig:
    root = Path(os.environ.get("AGENT_DEFAULT_SHARE_ROOT", str(Path.home()))).expanduser().resolve()
    inbox_dir = Path(os.environ.get("AGENT_INBOX_DIR", str(root / ".inbox"))).expanduser().resolve()
    return AgentConfig(
        agent_device_id=os.environ.get("AGENT_DEVICE_ID", str(uuid4())),
        agent_name=os.environ.get("AGENT_NAME", "Local Agent"),
        owner_principal_id=os.environ.get("AGENT_OWNER_PRINCIPAL_ID", ""),
        public_base_url=os.environ.get("AGENT_PUBLIC_BASE_URL", "http://127.0.0.1:7001"),
        coordinator_url=os.environ.get("AGENT_COORDINATOR_URL", "http://127.0.0.1:7000"),
        coordinator_agent_secret=_secure_value(
            "COORDINATOR_AGENT_SHARED_SECRET",
            "replace-agent-secret",
            blocked={"replace-agent-secret", "replace-with-strong-agent-secret", "changeme"},
        ),
        coordinator_secret_key=_secure_value(
            "COORDINATOR_SECRET_KEY",
            "replace-with-secure-key",
            blocked={
                "replace-with-secure-key",
                "replace-with-strong-coordinator-key",
                "replace-this-secret-key",
                "changeme",
            },
        ),
        state_db_url=os.environ.get("AGENT_STATE_DB_URL", "sqlite:///./agent_state.db"),
        default_share_id=os.environ.get("AGENT_DEFAULT_SHARE_ID", str(uuid4())),
        default_share_name=os.environ.get("AGENT_DEFAULT_SHARE_NAME", "Home"),
        default_share_root=root,
        inbox_dir=inbox_dir,
        heartbeat_interval_seconds=_as_int("AGENT_HEARTBEAT_SECONDS", 20),
        upload_chunk_max_bytes=_as_int("AGENT_UPLOAD_CHUNK_MAX_BYTES", 8 * 1024 * 1024),
    )
