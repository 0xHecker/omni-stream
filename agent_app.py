from __future__ import annotations

import uvicorn

from shared.runtime import default_worker_count, uvicorn_runtime_settings


if __name__ == "__main__":
    uvicorn.run(
        "agent.main:app",
        **uvicorn_runtime_settings("AGENT", 7001, default_workers=default_worker_count(max_workers=2)),
    )
