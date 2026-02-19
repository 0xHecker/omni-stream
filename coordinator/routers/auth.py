from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from shared.schemas import AuthTokenRequest, AuthTokenResponse

from ..config import load_config
from ..db import get_db
from ..models import ClientDevice, Principal
from ..services.auth import AuthContext, issue_access_token, require_auth_context, verify_secret

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


def _utcnow() -> datetime:
    return datetime.now(tz=timezone.utc)


@router.post("/token", response_model=AuthTokenResponse)
def issue_token_endpoint(body: AuthTokenRequest, db: Session = Depends(get_db)) -> AuthTokenResponse:
    config = load_config()
    principal = db.get(Principal, body.principal_id)
    device = db.get(ClientDevice, body.client_device_id)
    if not principal or principal.status != "active" or not device or device.status != "active":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid principal or device")
    if device.principal_id != principal.id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Device does not belong to principal")
    if not verify_secret(device.device_secret_hash, body.device_secret):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid device credentials")

    device.last_seen = _utcnow()
    db.commit()

    token = issue_access_token(config, principal.id, device.id)
    return AuthTokenResponse(
        access_token=token,
        expires_in=config.access_token_ttl_seconds,
        principal_id=principal.id,
        client_device_id=device.id,
    )


@router.get("/me")
def me(auth: AuthContext = Depends(require_auth_context), db: Session = Depends(get_db)) -> dict:
    principal = db.get(Principal, auth.principal_id)
    device = db.get(ClientDevice, auth.client_device_id)
    if not principal or not device:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unknown caller")
    return {
        "principal": {
            "id": principal.id,
            "display_name": principal.display_name,
            "status": principal.status,
        },
        "client_device": {
            "id": device.id,
            "name": device.name,
            "platform": device.platform,
            "status": device.status,
            "last_seen": device.last_seen.isoformat() if device.last_seen else None,
        },
    }

