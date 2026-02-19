from __future__ import annotations

import secrets
from dataclasses import dataclass

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from shared.security import TokenError, decode_token, issue_token

from ..config import CoordinatorConfig, load_config
from ..db import get_db
from ..models import ClientDevice, Principal

_password_hasher = PasswordHasher()


@dataclass(frozen=True)
class AuthContext:
    principal_id: str
    client_device_id: str


def hash_secret(secret: str) -> str:
    return _password_hasher.hash(secret)


def verify_secret(secret_hash: str, candidate: str) -> bool:
    try:
        return _password_hasher.verify(secret_hash, candidate)
    except VerifyMismatchError:
        return False


def issue_access_token(
    config: CoordinatorConfig,
    principal_id: str,
    client_device_id: str,
) -> str:
    payload = {
        "kind": "client_access",
        "principal_id": principal_id,
        "client_device_id": client_device_id,
    }
    return issue_token(config.secret_key, payload, expires_in=config.access_token_ttl_seconds)


def issue_events_ws_token(
    config: CoordinatorConfig,
    principal_id: str,
    client_device_id: str,
) -> str:
    payload = {
        "kind": "events_ws",
        "principal_id": principal_id,
        "client_device_id": client_device_id,
    }
    return issue_token(config.secret_key, payload, expires_in=config.events_ws_token_ttl_seconds)


def issue_read_ticket(
    config: CoordinatorConfig,
    principal_id: str,
    share_id: str,
    permissions: set[str],
) -> str:
    payload = {
        "kind": "read_ticket",
        "principal_id": principal_id,
        "share_id": share_id,
        "permissions": sorted(permissions),
    }
    return issue_token(config.secret_key, payload, expires_in=config.read_ticket_ttl_seconds)


def issue_transfer_ticket(
    config: CoordinatorConfig,
    principal_id: str,
    transfer_id: str,
    receiver_device_id: str,
    receiver_share_id: str,
) -> str:
    payload = {
        "kind": "transfer_upload_ticket",
        "principal_id": principal_id,
        "transfer_id": transfer_id,
        "receiver_device_id": receiver_device_id,
        "receiver_share_id": receiver_share_id,
    }
    return issue_token(config.secret_key, payload, expires_in=config.transfer_ticket_ttl_seconds)


def issue_internal_agent_ticket(config: CoordinatorConfig, share_id: str) -> str:
    payload = {"kind": "internal_agent", "share_id": share_id}
    return issue_token(config.secret_key, payload, expires_in=60)


def generate_device_secret() -> str:
    return secrets.token_urlsafe(32)


def _extract_bearer_token(request: Request) -> str:
    auth_header = request.headers.get("authorization", "")
    parts = auth_header.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token")
    return parts[1].strip()


def _decode_access_claims(config: CoordinatorConfig, token: str) -> dict:
    try:
        claims = decode_token(config.secret_key, token)
    except TokenError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc

    if claims.get("kind") != "client_access":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid access token")
    return claims


def require_auth_context(
    request: Request,
    db: Session = Depends(get_db),
) -> AuthContext:
    config = load_config()
    token = _extract_bearer_token(request)
    claims = _decode_access_claims(config, token)

    principal_id = str(claims.get("principal_id") or "")
    client_device_id = str(claims.get("client_device_id") or "")
    principal = db.get(Principal, principal_id)
    device = db.get(ClientDevice, client_device_id)
    if not principal or principal.status != "active" or not device or device.status != "active":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unknown principal or device")
    if device.principal_id != principal.id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token principal mismatch")
    return AuthContext(principal_id=principal.id, client_device_id=device.id)
