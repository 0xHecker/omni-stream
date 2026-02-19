from __future__ import annotations

import uvicorn

from shared.runtime import default_worker_count, uvicorn_runtime_settings


if __name__ == "__main__":
    uvicorn.run(
        "coordinator.main:app",
        **uvicorn_runtime_settings("COORDINATOR", 7000, default_workers=default_worker_count(max_workers=4)),
    )
