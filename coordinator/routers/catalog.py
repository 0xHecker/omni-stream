from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from shared.schemas import VisibilityRequest

from ..config import load_config
from ..db import get_db
from ..models import AgentDevice, Principal, Share
from ..services.acl import ensure_default_grants_for_share, get_permissions_for_shares
from ..services.audit import write_audit
from ..services.auth import AuthContext, require_auth_context

router = APIRouter(prefix="/api/v1/catalog", tags=["catalog"])
internal_router = APIRouter(prefix="/api/v1/internal", tags=["internal"])


class AgentShareRegistration(BaseModel):
    share_id: str | None = None
    name: str = Field(min_length=1, max_length=120)
    root_path: str = Field(min_length=1, max_length=500)
    read_only: bool = False


class AgentRegisterRequest(BaseModel):
    agent_device_id: str | None = None
    owner_principal_id: str
    name: str = Field(min_length=1, max_length=120)
    base_url: str = Field(min_length=1, max_length=300)
    visible: bool = True
    shares: list[AgentShareRegistration] = Field(default_factory=list)


class AgentHeartbeatRequest(BaseModel):
    online: bool = True


def _utcnow() -> datetime:
    return datetime.now(tz=timezone.utc)


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _is_online(device: AgentDevice) -> bool:
    if not device.last_seen:
        return False
    return device.online_state and (_utcnow() - _as_utc(device.last_seen)) <= timedelta(seconds=90)


def _require_agent_secret(header_value: str | None) -> None:
    config = load_config()
    if header_value != config.agent_shared_secret:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid agent secret")


@internal_router.post("/agents/register")
def register_agent(
    body: AgentRegisterRequest,
    request: Request,
    db: Session = Depends(get_db),
    x_agent_secret: str | None = Header(default=None),
) -> dict:
    _require_agent_secret(x_agent_secret)
    owner = db.get(Principal, body.owner_principal_id)
    if not owner or owner.status != "active":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Owner principal not found")

    device = db.get(AgentDevice, body.agent_device_id) if body.agent_device_id else None
    if not device:
        device_kwargs = {
            "owner_principal_id": body.owner_principal_id,
            "name": body.name,
            "base_url": body.base_url.rstrip("/"),
            "visibility": body.visible,
            "online_state": True,
            "last_seen": _utcnow(),
        }
        if body.agent_device_id:
            device_kwargs["id"] = body.agent_device_id
        device = AgentDevice(**device_kwargs)
        db.add(device)
        db.flush()
    else:
        device.owner_principal_id = body.owner_principal_id
        device.name = body.name
        device.base_url = body.base_url.rstrip("/")
        device.visibility = body.visible
        device.online_state = True
        device.last_seen = _utcnow()

    existing_shares = {share.id: share for share in device.shares}
    response_shares: list[dict] = []
    for share_input in body.shares:
        share = existing_shares.get(share_input.share_id or "")
        if not share:
            share_kwargs = {
                "agent_device_id": device.id,
                "name": share_input.name,
                "root_path": share_input.root_path,
                "read_only": share_input.read_only,
            }
            if share_input.share_id:
                share_kwargs["id"] = share_input.share_id
            share = Share(**share_kwargs)
            db.add(share)
            db.flush()
            ensure_default_grants_for_share(db, share, owner_principal_id=device.owner_principal_id)
        else:
            share.name = share_input.name
            share.root_path = share_input.root_path
            share.read_only = share_input.read_only
        response_shares.append(
            {
                "id": share.id,
                "name": share.name,
                "root_path": share.root_path,
                "read_only": share.read_only,
            }
        )

    write_audit(
        db,
        action="agent_registered",
        resource_type="agent_device",
        resource_id=device.id,
        actor_principal_id=device.owner_principal_id,
        request=request,
        metadata={"share_count": len(response_shares)},
    )
    db.commit()
    return {"device_id": device.id, "shares": response_shares}


@internal_router.post("/agents/{device_id}/heartbeat")
def heartbeat_agent(
    device_id: str,
    body: AgentHeartbeatRequest,
    db: Session = Depends(get_db),
    x_agent_secret: str | None = Header(default=None),
) -> dict:
    _require_agent_secret(x_agent_secret)
    device = db.get(AgentDevice, device_id)
    if not device:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent device not found")
    device.last_seen = _utcnow()
    device.online_state = bool(body.online)
    db.commit()
    return {"ok": True}


@router.get("/devices")
def list_devices(auth: AuthContext = Depends(require_auth_context), db: Session = Depends(get_db)) -> dict:
    devices = db.execute(select(AgentDevice).order_by(AgentDevice.name.asc())).scalars().all()
    payload = []
    for device in devices:
        if not device.visibility and device.owner_principal_id != auth.principal_id:
            continue
        payload.append(
            {
                "id": device.id,
                "name": device.name,
                "owner_principal_id": device.owner_principal_id,
                "visible": device.visibility,
                "online": _is_online(device),
                "last_seen": device.last_seen.isoformat() if device.last_seen else None,
            }
        )
    return {"devices": payload}


@router.post("/devices/{device_id}/visibility")
def set_visibility(
    device_id: str,
    body: VisibilityRequest,
    auth: AuthContext = Depends(require_auth_context),
    db: Session = Depends(get_db),
) -> dict:
    device = db.get(AgentDevice, device_id)
    if not device:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device not found")
    if device.owner_principal_id != auth.principal_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only owner can change visibility")
    device.visibility = body.visible
    db.commit()
    return {"id": device.id, "visible": device.visibility}


@router.get("/shares")
def list_shares(
    device_id: str | None = None,
    auth: AuthContext = Depends(require_auth_context),
    db: Session = Depends(get_db),
) -> dict:
    query = (
        select(Share, AgentDevice)
        .join(AgentDevice, Share.agent_device_id == AgentDevice.id)
        .order_by(Share.name.asc())
    )
    if device_id:
        query = query.where(Share.agent_device_id == device_id)

    rows = db.execute(query).all()
    owner_map: dict[str, str] = {}
    visible_rows: list[tuple[Share, AgentDevice]] = []
    for share, device in rows:
        if not device.visibility and device.owner_principal_id != auth.principal_id:
            continue
        owner_map[share.id] = device.owner_principal_id
        visible_rows.append((share, device))

    permissions_by_share = get_permissions_for_shares(
        db,
        auth.principal_id,
        [share for share, _device in visible_rows],
        owner_map=owner_map,
    )

    payload = []
    for share, device in visible_rows:
        permissions = permissions_by_share.get(share.id, set())
        if not permissions:
            continue
        payload.append(
            {
                "id": share.id,
                "name": share.name,
                "device_id": share.agent_device_id,
                "read_only": share.read_only,
                "permissions": sorted(permissions),
                "device_online": _is_online(device),
            }
        )
    return {"shares": payload}
