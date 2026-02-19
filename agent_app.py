from __future__ import annotations

import os

import uvicorn


if __name__ == "__main__":
    uvicorn.run(
        "agent.main:app",
        host=os.environ.get("AGENT_HOST", "0.0.0.0"),
        port=int(os.environ.get("AGENT_PORT", "7001")),
        reload=os.environ.get("AGENT_RELOAD") == "1",
    )

