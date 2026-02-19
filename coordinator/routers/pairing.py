from __future__ import annotations

from datetime import datetime, timedelta, timezone
import secrets
from threading import Lock

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from shared.schemas import PairingConfirmRequest, PairingStartRequest, PairingStartResponse

from ..config import load_config
from ..db import get_db
from ..models import ClientDevice, PairingSession, Principal
from ..services.acl import ensure_default_grants_for_principal
from ..services.audit import write_audit
from ..services.auth import (
    AuthContext,
    generate_device_secret,
    hash_secret,
    issue_access_token,
    require_auth_context,
)

router = APIRouter(prefix="/api/v1/pairing", tags=["pairing"])

_PAIRING_ATTEMPTS: dict[str, dict[str, int | datetime | None]] = {}
_PAIRING_ATTEMPTS_LOCK = Lock()
_MAX_PAIRING_ATTEMPTS = 5


def _utcnow() -> datetime:
    return datetime.now(tz=timezone.utc)


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _check_pairing_lock(session_id: str, now: datetime) -> None:
    with _PAIRING_ATTEMPTS_LOCK:
        state = _PAIRING_ATTEMPTS.get(session_id)
        if not state:
            return
        locked_until = state.get("locked_until")
        if isinstance(locked_until, datetime) and _as_utc(locked_until) > now:
            raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Pairing temporarily locked")
        if isinstance(locked_until, datetime) and _as_utc(locked_until) <= now:
            state["locked_until"] = None
            state["failure_count"] = 0


def _record_pairing_failure(session_id: str, now: datetime) -> None:
    with _PAIRING_ATTEMPTS_LOCK:
        state = _PAIRING_ATTEMPTS.setdefault(
            session_id,
            {"failure_count": 0, "locked_until": None},
        )
        failure_count = int(state.get("failure_count") or 0) + 1
        state["failure_count"] = failure_count
        if failure_count >= _MAX_PAIRING_ATTEMPTS:
            lock_seconds = min(300, 2 ** min(failure_count, 8))
            state["locked_until"] = now + timedelta(seconds=lock_seconds)


def _clear_pairing_attempt_state(session_id: str) -> None:
    with _PAIRING_ATTEMPTS_LOCK:
        _PAIRING_ATTEMPTS.pop(session_id, None)


@router.post("/start", response_model=PairingStartResponse)
def start_pairing(
    body: PairingStartRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> PairingStartResponse:
    config = load_config()
    has_principal = db.execute(select(Principal.id).limit(1)).first() is not None
    if not has_principal:
        principal = Principal(display_name=body.display_name, public_key=body.public_key)
        db.add(principal)
        db.flush()

        device_secret = generate_device_secret()
        client_device = ClientDevice(
            principal_id=principal.id,
            name=body.device_name,
            platform=body.platform,
            public_key=body.public_key,
            device_secret_hash=hash_secret(device_secret),
            last_seen=_utcnow(),
        )
        db.add(client_device)
        db.flush()
        ensure_default_grants_for_principal(db, principal.id)
        write_audit(
            db,
            action="principal_bootstrap",
            resource_type="principal",
            resource_id=principal.id,
            actor_principal_id=principal.id,
            request=request,
            metadata={"client_device_id": client_device.id},
        )
        db.commit()
        access_token = issue_access_token(config, principal.id, client_device.id)
        return PairingStartResponse(
            bootstrap=True,
            principal_id=principal.id,
            client_device_id=client_device.id,
            access_token=access_token,
            device_secret=device_secret,
        )

    pairing_code = f"{secrets.randbelow(1_000_000):06d}"
    expires_at = _utcnow() + timedelta(seconds=config.pairing_code_ttl_seconds)
    session = PairingSession(
        display_name=body.display_name,
        device_name=body.device_name,
        platform=body.platform,
        public_key=body.public_key,
        pairing_code=pairing_code,
        expires_at=expires_at,
    )
    db.add(session)
    db.commit()
    return PairingStartResponse(
        bootstrap=False,
        pending_pairing_id=session.id,
        pairing_code=pairing_code,
        expires_at=expires_at,
    )


@router.post("/confirm", response_model=PairingStartResponse)
def confirm_pairing(
    body: PairingConfirmRequest,
    request: Request,
    auth: AuthContext = Depends(require_auth_context),
    db: Session = Depends(get_db),
) -> PairingStartResponse:
    config = load_config()
    now = _utcnow()
    session = db.get(PairingSession, body.pending_pairing_id)
    if not session or session.status != "pending":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pairing session not found")
    _check_pairing_lock(session.id, now)
    if session.pairing_code != body.pairing_code:
        _record_pairing_failure(session.id, now)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid pairing code")
    if _as_utc(session.expires_at) < now:
        session.status = "expired"
        _clear_pairing_attempt_state(session.id)
        db.commit()
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="Pairing session expired")

    device_secret = generate_device_secret()
    client_device = ClientDevice(
        principal_id=auth.principal_id,
        name=session.device_name,
        platform=session.platform,
        public_key=session.public_key,
        device_secret_hash=hash_secret(device_secret),
        last_seen=_utcnow(),
    )
    db.add(client_device)
    session.status = "confirmed"
    session.approved_by_principal_id = auth.principal_id
    _clear_pairing_attempt_state(session.id)

    write_audit(
        db,
        action="pairing_confirmed",
        resource_type="pairing_session",
        resource_id=session.id,
        actor_principal_id=auth.principal_id,
        request=request,
        metadata={"client_device_id": client_device.id},
    )

    db.commit()
    access_token = issue_access_token(config, auth.principal_id, client_device.id)
    return PairingStartResponse(
        bootstrap=False,
        principal_id=auth.principal_id,
        client_device_id=client_device.id,
        access_token=access_token,
        device_secret=device_secret,
    )
