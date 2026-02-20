from __future__ import annotations

from types import SimpleNamespace
import pytest
from fastapi import HTTPException


def test_prepare_items_for_client_supports_compact_mode(monkeypatch) -> None:
    monkeypatch.setenv("ALLOW_INSECURE_DEFAULTS", "1")
    from coordinator.routers.files import _prepare_items_for_client

    device = SimpleNamespace(id="device-1", base_url="http://192.168.1.55:7001", name="Device")
    share = SimpleNamespace(id="share-1", name="Share")
    items = [
        {"name": "movie.mp4", "path": "movie.mp4", "is_dir": False, "type": "video"},
        {"name": "photos", "path": "photos", "is_dir": True, "type": "directory"},
    ]

    compact_items = _prepare_items_for_client(
        items,
        device=device,
        share=share,
        permissions={"read", "download"},
        ticket="ticket-1",
        include_urls=False,
    )
    assert "stream_url" not in compact_items[0]
    assert "download_url" not in compact_items[0]

    expanded_items = _prepare_items_for_client(
        items,
        device=device,
        share=share,
        permissions={"read", "download"},
        ticket="ticket-1",
        include_urls=True,
    )
    assert expanded_items[0]["stream_url"].startswith("http://192.168.1.55:7001/agent/v1/shares/share-1/stream")
    assert expanded_items[0]["download_url"].startswith("http://192.168.1.55:7001/agent/v1/shares/share-1/download")
    assert "stream_url" not in expanded_items[1]


def test_build_access_descriptor_includes_ticket_and_permissions(monkeypatch) -> None:
    monkeypatch.setenv("ALLOW_INSECURE_DEFAULTS", "1")
    from coordinator.routers.files import _build_access_descriptor

    device = SimpleNamespace(id="device-1", base_url="http://192.168.1.55:7001")
    share = SimpleNamespace(id="share-1")
    access = _build_access_descriptor(
        device=device,
        share=share,
        permissions={"read", "download"},
        ticket="ticket-123",
        ticket_ttl_seconds=1800,
    )

    assert access["device_id"] == "device-1"
    assert access["share_id"] == "share-1"
    assert access["agent_base_url"] == "http://192.168.1.55:7001"
    assert access["ticket"] == "ticket-123"
    assert access["can_download"] is True
    assert access["expires_in"] == 1800


def test_require_browse_access_pin_validates_when_enabled(monkeypatch) -> None:
    monkeypatch.setenv("ALLOW_INSECURE_DEFAULTS", "1")
    from coordinator.routers.files import _require_browse_access_pin

    config = SimpleNamespace(browse_access_pin="123456")
    _require_browse_access_pin(config, "123456")

    with pytest.raises(HTTPException) as missing_pin:
        _require_browse_access_pin(config, None)
    assert missing_pin.value.status_code == 401
    assert "Access PIN required" in str(missing_pin.value.detail)

    with pytest.raises(HTTPException) as invalid_pin:
        _require_browse_access_pin(config, "000000")
    assert invalid_pin.value.status_code == 401
    assert "Invalid access PIN" in str(invalid_pin.value.detail)
