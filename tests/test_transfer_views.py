from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace

def test_transfer_to_dict_includes_sender_client_device_id(monkeypatch) -> None:
    monkeypatch.setenv("ALLOW_INSECURE_DEFAULTS", "1")
    from coordinator.services.transfer_views import transfer_to_dict

    now = datetime.now(timezone.utc)
    transfer = SimpleNamespace(
        id="transfer-1",
        sender_principal_id="principal-1",
        sender_client_device_id="client-1",
        receiver_device_id="device-1",
        receiver_share_id="share-1",
        state="pending_receiver_approval",
        reason=None,
        created_at=now,
        expires_at=now,
        updated_at=now,
        items=[
            SimpleNamespace(
                id="item-1",
                filename="photo.jpg",
                size=123,
                sha256="0" * 64,
                mime_type="image/jpeg",
                state="pending",
            )
        ],
    )

    payload = transfer_to_dict(transfer)
    assert payload["sender_client_device_id"] == "client-1"
    assert payload["items"][0]["filename"] == "photo.jpg"
