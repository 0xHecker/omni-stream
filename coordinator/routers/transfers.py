from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from shared.schemas import (
    PasscodeOpenRequest,
    TransferApproveRequest,
    TransferCreateRequest,
    TransferRejectRequest,
)

from ..config import load_config
from ..db import get_db
from ..models import AgentDevice, Share, TransferItem, TransferRequest
from ..services.acl import get_permissions_for_share, require_permission
from ..services.audit import write_audit
from ..services.auth import AuthContext, issue_transfer_ticket, require_auth_context
from ..services.events import broker
from ..services.passcode import set_transfer_passcode, verify_passcode_for_transfer
from ..services.transfer_views import transfer_to_dict

router = APIRouter(prefix="/api/v1/transfers", tags=["transfers"])
internal_router = APIRouter(prefix="/api/v1/internal/transfers", tags=["internal"])


def _utcnow() -> datetime:
    return datetime.now(tz=timezone.utc)


def _get_receiver_owner(transfer: TransferRequest, db: Session) -> str:
    device = db.get(AgentDevice, transfer.receiver_device_id)
    if not device:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Receiver device not found")
    return device.owner_principal_id


def _load_visible_transfer(transfer_id: str, auth: AuthContext, db: Session) -> TransferRequest:
    transfer = db.get(TransferRequest, transfer_id)
    if not transfer:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transfer not found")
    receiver_owner = _get_receiver_owner(transfer, db)
    if auth.principal_id not in {transfer.sender_principal_id, receiver_owner}:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Transfer not accessible")
    return transfer


class TransferItemStateRequest(BaseModel):
    state: str = Field(min_length=1, max_length=30)


@router.post("")
async def create_transfer(
    body: TransferCreateRequest,
    request: Request,
    auth: AuthContext = Depends(require_auth_context),
    db: Session = Depends(get_db),
) -> dict:
    receiver_device = db.get(AgentDevice, body.receiver_device_id)
    if not receiver_device:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Receiver device not found")
    if not receiver_device.visibility and receiver_device.owner_principal_id != auth.principal_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Receiver device not found")

    receiver_share = db.get(Share, body.receiver_share_id)
    if not receiver_share or receiver_share.agent_device_id != receiver_device.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Receiver share not found")

    require_permission(db, auth.principal_id, receiver_share, "request_send")
    transfer = TransferRequest(
        sender_principal_id=auth.principal_id,
        receiver_device_id=receiver_device.id,
        receiver_share_id=receiver_share.id,
        state="pending_receiver_approval",
        expires_at=_utcnow() + timedelta(hours=24),
    )
    db.add(transfer)
    db.flush()

    for item in body.items:
        db.add(
            TransferItem(
                transfer_request_id=transfer.id,
                filename=item.filename,
                size=item.size,
                sha256=item.sha256.lower(),
                mime_type=item.mime_type,
                state="pending",
            )
        )

    write_audit(
        db,
        action="transfer_created",
        resource_type="transfer",
        resource_id=transfer.id,
        actor_principal_id=auth.principal_id,
        request=request,
        metadata={"item_count": len(body.items), "receiver_device_id": receiver_device.id},
    )

    db.commit()
    db.refresh(transfer)
    receiver_owner = receiver_device.owner_principal_id
    await broker.publish(
        receiver_owner,
        {
            "type": "transfer_requested",
            "transfer": transfer_to_dict(transfer),
        },
    )
    return transfer_to_dict(transfer)


@router.get("")
def list_transfers(
    role: str = Query(default="all", pattern="^(all|incoming|outgoing)$"),
    auth: AuthContext = Depends(require_auth_context),
    db: Session = Depends(get_db),
) -> dict:
    incoming_device_ids = db.execute(
        select(AgentDevice.id).where(AgentDevice.owner_principal_id == auth.principal_id)
    ).scalars().all()

    query = select(TransferRequest).order_by(TransferRequest.created_at.desc())
    if role == "incoming":
        query = query.where(TransferRequest.receiver_device_id.in_(incoming_device_ids))
    elif role == "outgoing":
        query = query.where(TransferRequest.sender_principal_id == auth.principal_id)
    else:
        query = query.where(
            or_(
                TransferRequest.sender_principal_id == auth.principal_id,
                TransferRequest.receiver_device_id.in_(incoming_device_ids),
            )
        )
    transfers = db.execute(query.limit(200)).scalars().all()
    return {"transfers": [transfer_to_dict(item) for item in transfers]}


@router.get("/{transfer_id}")
def get_transfer(
    transfer_id: str,
    auth: AuthContext = Depends(require_auth_context),
    db: Session = Depends(get_db),
) -> dict:
    transfer = _load_visible_transfer(transfer_id, auth, db)
    return transfer_to_dict(transfer)


@router.post("/{transfer_id}/approve")
async def approve_transfer(
    transfer_id: str,
    body: TransferApproveRequest,
    request: Request,
    auth: AuthContext = Depends(require_auth_context),
    db: Session = Depends(get_db),
) -> dict:
    transfer = db.get(TransferRequest, transfer_id)
    if not transfer:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transfer not found")
    receiver_share = db.get(Share, transfer.receiver_share_id)
    if not receiver_share:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Receiver share not found")

    receiver_owner = _get_receiver_owner(transfer, db)
    if auth.principal_id != receiver_owner:
        permissions = get_permissions_for_share(db, auth.principal_id, receiver_share)
        if "accept_incoming" not in permissions:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Permission denied")

    if transfer.state != "pending_receiver_approval":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Transfer is not pending approval")

    config = load_config()
    set_transfer_passcode(db, config=config, transfer=transfer, passcode=body.passcode)
    transfer.state = "approved_pending_sender_passcode"

    write_audit(
        db,
        action="transfer_approved",
        resource_type="transfer",
        resource_id=transfer.id,
        actor_principal_id=auth.principal_id,
        request=request,
    )
    db.commit()
    db.refresh(transfer)
    await broker.publish(
        transfer.sender_principal_id,
        {
            "type": "transfer_approved",
            "transfer": transfer_to_dict(transfer),
        },
    )
    return transfer_to_dict(transfer)


@router.post("/{transfer_id}/reject")
async def reject_transfer(
    transfer_id: str,
    body: TransferRejectRequest,
    request: Request,
    auth: AuthContext = Depends(require_auth_context),
    db: Session = Depends(get_db),
) -> dict:
    transfer = db.get(TransferRequest, transfer_id)
    if not transfer:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transfer not found")
    receiver_owner = _get_receiver_owner(transfer, db)
    if auth.principal_id != receiver_owner:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only receiver owner can reject")
    if transfer.state != "pending_receiver_approval":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Transfer is not pending approval")

    transfer.state = "rejected"
    transfer.reason = body.reason
    for item in transfer.items:
        item.state = "rejected"
    write_audit(
        db,
        action="transfer_rejected",
        resource_type="transfer",
        resource_id=transfer.id,
        actor_principal_id=auth.principal_id,
        request=request,
        metadata={"reason": body.reason or ""},
    )
    db.commit()
    db.refresh(transfer)
    await broker.publish(
        transfer.sender_principal_id,
        {
            "type": "transfer_rejected",
            "transfer": transfer_to_dict(transfer),
        },
    )
    return transfer_to_dict(transfer)


@router.post("/{transfer_id}/passcode/open")
async def open_passcode_window(
    transfer_id: str,
    body: PasscodeOpenRequest,
    request: Request,
    auth: AuthContext = Depends(require_auth_context),
    db: Session = Depends(get_db),
) -> dict:
    config = load_config()
    transfer = db.get(TransferRequest, transfer_id)
    if not transfer:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transfer not found")
    if transfer.sender_principal_id != auth.principal_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only sender can open passcode window")
    if transfer.state not in {"approved_pending_sender_passcode", "passcode_open"}:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Transfer is not ready for passcode entry")

    verify_passcode_for_transfer(
        db,
        transfer=transfer,
        principal_id=auth.principal_id,
        passcode=body.passcode,
    )
    transfer.state = "passcode_open"
    receiver = db.get(AgentDevice, transfer.receiver_device_id)
    if not receiver:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Receiver device not found")

    ticket = issue_transfer_ticket(
        config,
        principal_id=auth.principal_id,
        transfer_id=transfer.id,
        receiver_device_id=receiver.id,
        receiver_share_id=transfer.receiver_share_id,
    )
    write_audit(
        db,
        action="transfer_passcode_opened",
        resource_type="transfer",
        resource_id=transfer.id,
        actor_principal_id=auth.principal_id,
        request=request,
    )
    db.commit()
    db.refresh(transfer)

    await broker.publish(
        receiver.owner_principal_id,
        {
            "type": "transfer_passcode_opened",
            "transfer": transfer_to_dict(transfer),
        },
    )

    return {
        "transfer": transfer_to_dict(transfer),
        "upload_ticket": ticket,
        "upload_base_url": f"{receiver.base_url.rstrip('/')}/agent/v1/inbox/transfers/{transfer.id}",
        "expires_at": transfer.passcode_window.expires_at.isoformat() if transfer.passcode_window else None,
    }


@internal_router.post("/{transfer_id}/items/{item_id}/state")
async def update_transfer_item_state(
    transfer_id: str,
    item_id: str,
    body: TransferItemStateRequest,
    x_agent_secret: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> dict:
    config = load_config()
    if x_agent_secret != config.agent_shared_secret:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid agent secret")

    transfer = db.get(TransferRequest, transfer_id)
    if not transfer:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transfer not found")
    item = next((it for it in transfer.items if it.id == item_id), None)
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transfer item not found")
    item.state = body.state

    item_states = {it.state for it in transfer.items}
    if item_states and item_states.issubset({"finalized", "completed"}):
        transfer.state = "completed"
    elif "receiving" in item_states or "committed" in item_states:
        transfer.state = "in_progress"

    db.commit()
    db.refresh(transfer)
    await broker.publish(
        transfer.sender_principal_id,
        {
            "type": "transfer_item_state",
            "transfer": transfer_to_dict(transfer),
        },
    )
    receiver_owner = _get_receiver_owner(transfer, db)
    await broker.publish(
        receiver_owner,
        {
            "type": "transfer_item_state",
            "transfer": transfer_to_dict(transfer),
        },
    )
    return {"ok": True}


@internal_router.get("/{transfer_id}/items/{item_id}")
def get_transfer_item_manifest(
    transfer_id: str,
    item_id: str,
    x_agent_secret: str | None = Header(default=None),
    x_agent_device_id: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> dict:
    config = load_config()
    if x_agent_secret != config.agent_shared_secret:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid agent secret")
    if not x_agent_device_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Missing agent device id")

    transfer = db.get(TransferRequest, transfer_id)
    if not transfer:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transfer not found")
    if transfer.receiver_device_id != x_agent_device_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Transfer does not target this agent")

    item = next((it for it in transfer.items if it.id == item_id), None)
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transfer item not found")

    return {
        "transfer_id": transfer.id,
        "receiver_share_id": transfer.receiver_share_id,
        "item_id": item.id,
        "filename": item.filename,
        "size": item.size,
        "sha256": item.sha256,
        "mime_type": item.mime_type,
        "state": item.state,
    }
