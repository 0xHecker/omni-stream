from __future__ import annotations

import json
from typing import Any

from fastapi import Request
from sqlalchemy.orm import Session

from ..models import AuditEvent


def write_audit(
    db: Session,
    *,
    action: str,
    resource_type: str,
    resource_id: str,
    actor_principal_id: str | None,
    request: Request | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    ip = None
    user_agent = None
    if request is not None:
        ip = request.client.host if request.client else None
        user_agent = request.headers.get("user-agent")

    db.add(
        AuditEvent(
            actor_principal_id=actor_principal_id,
            action=action,
            resource_type=resource_type,
            resource_id=resource_id,
            ip=ip,
            user_agent=user_agent,
            metadata_json=json.dumps(metadata or {}, separators=(",", ":"), sort_keys=True),
        )
    )

