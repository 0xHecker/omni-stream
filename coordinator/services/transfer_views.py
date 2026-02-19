from __future__ import annotations

from ..models import TransferItem, TransferRequest


def transfer_to_dict(transfer: TransferRequest) -> dict:
    return {
        "id": transfer.id,
        "sender_principal_id": transfer.sender_principal_id,
        "receiver_device_id": transfer.receiver_device_id,
        "receiver_share_id": transfer.receiver_share_id,
        "state": transfer.state,
        "reason": transfer.reason,
        "created_at": transfer.created_at.isoformat(),
        "expires_at": transfer.expires_at.isoformat(),
        "updated_at": transfer.updated_at.isoformat(),
        "items": [item_to_dict(item) for item in transfer.items],
    }


def item_to_dict(item: TransferItem) -> dict:
    return {
        "id": item.id,
        "filename": item.filename,
        "size": item.size,
        "sha256": item.sha256,
        "mime_type": item.mime_type,
        "state": item.state,
    }

