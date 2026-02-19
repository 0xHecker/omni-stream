from __future__ import annotations

from fastapi import HTTPException, status

from shared.security import TokenError, decode_token

from .config import load_config


def decode_ticket(ticket: str) -> dict:
    config = load_config()
    try:
        return decode_token(config.coordinator_secret_key, ticket)
    except TokenError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc


def verify_read_ticket(ticket: str, share_id: str, required_permission: str) -> dict:
    claims = decode_ticket(ticket)
    if claims.get("kind") not in {"read_ticket", "internal_agent"}:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid read ticket")
    if claims.get("share_id") != share_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Ticket share mismatch")

    if claims.get("kind") == "read_ticket":
        permissions = set(claims.get("permissions") or [])
        if required_permission not in permissions:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Permission denied")
    return claims


def verify_transfer_ticket(ticket: str, transfer_id: str, share_id: str) -> dict:
    claims = decode_ticket(ticket)
    if claims.get("kind") != "transfer_upload_ticket":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid transfer ticket")
    if claims.get("transfer_id") != transfer_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Transfer ticket mismatch")
    if claims.get("receiver_share_id") != share_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Share mismatch")
    return claims

