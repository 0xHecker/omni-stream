from __future__ import annotations

import os

import uvicorn


if __name__ == "__main__":
    uvicorn.run(
        "coordinator.main:app",
        host=os.environ.get("COORDINATOR_HOST", "0.0.0.0"),
        port=int(os.environ.get("COORDINATOR_PORT", "7000")),
        reload=os.environ.get("COORDINATOR_RELOAD") == "1",
    )

