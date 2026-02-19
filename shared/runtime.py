from __future__ import annotations

import os
import platform
from typing import Any


def cpu_count() -> int:
    count = os.cpu_count()
    if not count or count < 1:
        return 1
    return count


def env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    value = raw.strip().lower()
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False
    return default


def env_int(name: str, default: int, *, minimum: int | None = None, maximum: int | None = None) -> int:
    raw = os.environ.get(name)
    if raw is None:
        value = default
    else:
        try:
            value = int(raw.strip())
        except (TypeError, ValueError):
            value = default

    if minimum is not None and value < minimum:
        value = minimum
    if maximum is not None and value > maximum:
        value = maximum
    return value


def default_worker_count(*, max_workers: int) -> int:
    return max(1, min(max_workers, cpu_count()))


def uvicorn_runtime_settings(prefix: str, default_port: int, *, default_workers: int) -> dict[str, Any]:
    reload_enabled = env_bool(f"{prefix}_RELOAD", False)
    max_workers = max(1, cpu_count() * 2)
    workers = env_int(
        f"{prefix}_WORKERS",
        default_workers,
        minimum=1,
        maximum=max_workers,
    )
    if reload_enabled:
        workers = 1

    host = os.environ.get(f"{prefix}_HOST", "0.0.0.0").strip() or "0.0.0.0"
    settings: dict[str, Any] = {
        "host": host,
        "port": env_int(f"{prefix}_PORT", default_port, minimum=1, maximum=65535),
        "reload": reload_enabled,
        "workers": workers,
        "backlog": env_int(f"{prefix}_BACKLOG", 2048, minimum=64, maximum=65535),
        "timeout_keep_alive": env_int(f"{prefix}_KEEPALIVE_SECONDS", 8, minimum=2, maximum=120),
        "limit_concurrency": env_int(f"{prefix}_LIMIT_CONCURRENCY", 2048, minimum=64, maximum=100000),
        "server_header": False,
        "date_header": True,
    }

    if platform.system() != "Windows":
        settings["loop"] = os.environ.get(f"{prefix}_LOOP", "uvloop")
        settings["http"] = os.environ.get(f"{prefix}_HTTP", "httptools")
    else:
        settings["loop"] = os.environ.get(f"{prefix}_LOOP", "asyncio")
        settings["http"] = os.environ.get(f"{prefix}_HTTP", "h11")

    return settings
