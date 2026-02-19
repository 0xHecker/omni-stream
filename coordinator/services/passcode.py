from __future__ import annotations

from datetime import datetime, timedelta, timezone

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from ..config import CoordinatorConfig
from ..models import PasscodeWindow, TransferRequest

_hasher = PasswordHasher()


def _utcnow() -> datetime:
    return datetime.now(tz=timezone.utc)


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def set_transfer_passcode(
    db: Session,
    *,
    config: CoordinatorConfig,
    transfer: TransferRequest,
    passcode: str,
) -> PasscodeWindow:
    if len(passcode) != 4 or not passcode.isdigit():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Passcode must be 4 digits")

    now = _utcnow()
    expires_at = now + timedelta(seconds=config.passcode_window_seconds)
    hashed = _hasher.hash(passcode)
    window = transfer.passcode_window
    if window:
        window.passcode_hash = hashed
        window.attempts_left = 5
        window.failure_count = 0
        window.locked_until = None
        window.expires_at = expires_at
        window.opened_at = None
        window.opened_by_principal_id = None
        return window

    window = PasscodeWindow(
        transfer_request_id=transfer.id,
        passcode_hash=hashed,
        attempts_left=5,
        failure_count=0,
        expires_at=expires_at,
    )
    db.add(window)
    return window


def verify_passcode_for_transfer(
    db: Session,
    *,
    transfer: TransferRequest,
    principal_id: str,
    passcode: str,
) -> PasscodeWindow:
    window = transfer.passcode_window
    if not window:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Passcode is not configured")

    now = _utcnow()
    if _as_utc(window.expires_at) < now:
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="Passcode window expired")
    if window.locked_until and _as_utc(window.locked_until) > now:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Passcode temporarily locked")

    try:
        ok = _hasher.verify(window.passcode_hash, passcode)
    except VerifyMismatchError:
        ok = False

    if not ok:
        window.failure_count += 1
        window.attempts_left -= 1
        if window.attempts_left <= 0:
            lock_seconds = min(300, 2 ** min(window.failure_count, 8))
            window.locked_until = now + timedelta(seconds=lock_seconds)
            window.attempts_left = 5
        db.flush()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid passcode")

    window.attempts_left = 5
    window.locked_until = None
    window.opened_by_principal_id = principal_id
    window.opened_at = now
    db.flush()
    return window
