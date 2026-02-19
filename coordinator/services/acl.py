from __future__ import annotations

from collections.abc import Sequence

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from shared.permissions import DEFAULT_EXTERNAL_PERMISSIONS, OWNER_PERMISSIONS, decode_permissions, encode_permissions

from ..models import AclGrant, AgentDevice, Principal, Share


def get_permissions_for_share(
    db: Session,
    principal_id: str,
    share: Share,
    *,
    owner_principal_id: str | None = None,
) -> set[str]:
    owner = owner_principal_id
    if owner is None:
        agent = db.get(AgentDevice, share.agent_device_id)
        owner = agent.owner_principal_id if agent else None

    if owner == principal_id:
        return set(OWNER_PERMISSIONS)

    grant = db.execute(
        select(AclGrant).where(
            AclGrant.principal_id == principal_id,
            AclGrant.share_id == share.id,
        )
    ).scalar_one_or_none()
    return decode_permissions(grant.permissions_raw if grant else None)


def get_permissions_for_shares(
    db: Session,
    principal_id: str,
    shares: Sequence[Share],
    *,
    owner_map: dict[str, str] | None = None,
) -> dict[str, set[str]]:
    if not shares:
        return {}

    share_ids = [share.id for share in shares]
    grants = db.execute(
        select(AclGrant).where(
            AclGrant.principal_id == principal_id,
            AclGrant.share_id.in_(share_ids),
        )
    ).scalars().all()
    grant_map = {grant.share_id: decode_permissions(grant.permissions_raw) for grant in grants}

    resolved_owner_map = owner_map or {}
    result: dict[str, set[str]] = {}
    for share in shares:
        if resolved_owner_map.get(share.id) == principal_id:
            result[share.id] = set(OWNER_PERMISSIONS)
        else:
            result[share.id] = set(grant_map.get(share.id, set()))
    return result


def require_permission(db: Session, principal_id: str, share: Share, permission: str) -> set[str]:
    permissions = get_permissions_for_share(db, principal_id, share)
    if permission not in permissions:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Permission denied")
    return permissions


def grant_permissions(db: Session, principal_id: str, share_id: str, permissions: set[str]) -> None:
    grant = db.execute(
        select(AclGrant).where(
            AclGrant.principal_id == principal_id,
            AclGrant.share_id == share_id,
        )
    ).scalar_one_or_none()
    if grant:
        grant.permissions_raw = encode_permissions(permissions)
    else:
        db.add(
            AclGrant(
                principal_id=principal_id,
                share_id=share_id,
                permissions_raw=encode_permissions(permissions),
            )
        )


def ensure_default_grants_for_share(db: Session, share: Share, owner_principal_id: str) -> None:
    active_principals = db.execute(
        select(Principal.id).where(Principal.status == "active")
    ).scalars().all()
    existing_principals = set(
        db.execute(select(AclGrant.principal_id).where(AclGrant.share_id == share.id)).scalars().all()
    )
    for principal_id in active_principals:
        if principal_id == owner_principal_id or principal_id in existing_principals:
            continue
        db.add(
            AclGrant(
                principal_id=principal_id,
                share_id=share.id,
                permissions_raw=encode_permissions(DEFAULT_EXTERNAL_PERMISSIONS),
            )
        )


def ensure_default_grants_for_principal(db: Session, principal_id: str) -> None:
    rows = db.execute(
        select(Share, AgentDevice.owner_principal_id).join(
            AgentDevice, Share.agent_device_id == AgentDevice.id
        )
    ).all()
    existing_share_ids = set(
        db.execute(select(AclGrant.share_id).where(AclGrant.principal_id == principal_id)).scalars().all()
    )
    for share, owner_principal_id in rows:
        if owner_principal_id == principal_id or share.id in existing_share_ids:
            continue
        db.add(
            AclGrant(
                principal_id=principal_id,
                share_id=share.id,
                permissions_raw=encode_permissions(DEFAULT_EXTERNAL_PERMISSIONS),
            )
        )
