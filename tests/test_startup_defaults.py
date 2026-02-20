from __future__ import annotations

import json
import os
from pathlib import Path

from flask import Flask

import app as launcher
from shared import networking
from stream_server import routes as web_routes


def test_local_ipv4_addresses_filters_invalid_and_loopback(monkeypatch) -> None:
    monkeypatch.setattr(
        networking,
        "_collect_candidate_ipv4",
        lambda: ["127.0.0.1", "192.168.1.20", "0.0.0.0", "not-an-ip", "10.0.0.8"],
    )
    addresses = networking.local_ipv4_addresses()
    assert addresses == ["192.168.1.20", "10.0.0.8"]


def test_coordinator_seed_urls_include_local_and_env_hints(monkeypatch) -> None:
    monkeypatch.setenv("STREAM_DEFAULT_COORDINATOR_URL", "http://192.168.1.40:7000")
    monkeypatch.setenv("STREAM_COORDINATOR_HINTS", "localhost:7000,10.0.0.8:7000")
    monkeypatch.setattr(networking, "local_ipv4_addresses", lambda **kwargs: ["192.168.1.40", "10.0.0.8"])

    urls = networking.coordinator_seed_urls(port=7000)

    assert "http://192.168.1.40:7000" in urls
    assert "http://10.0.0.8:7000" in urls
    assert "http://127.0.0.1:7000" in urls
    assert "http://localhost:7000" in urls


def test_discover_coordinators_probes_seed_then_scan(monkeypatch) -> None:
    monkeypatch.setattr(networking, "coordinator_seed_urls", lambda **kwargs: ["http://192.168.1.40:7000"])
    monkeypatch.setattr(networking, "coordinator_discovery_hosts", lambda **kwargs: ["192.168.1.50"])

    calls: list[list[str]] = []

    def fake_probe(urls, **kwargs):
        calls.append(list(urls))
        if len(calls) == 1:
            return []
        return ["http://192.168.1.50:7000"]

    monkeypatch.setattr(networking, "_probe_coordinator_urls", fake_probe)

    result = networking.discover_coordinators(
        port=7000,
        timeout_seconds=0.12,
        max_workers=16,
        max_results=4,
        cache_ttl_seconds=0,
    )

    assert result == ["http://192.168.1.50:7000"]
    assert calls[0] == ["http://192.168.1.40:7000/"]
    assert calls[1] == ["http://192.168.1.50:7000/"]


def test_coordinator_discovery_hosts_respects_include_exclude_cidrs(monkeypatch) -> None:
    monkeypatch.setattr(networking, "local_ipv4_addresses", lambda **kwargs: ["192.168.1.40", "10.0.0.8"])
    monkeypatch.setenv("STREAM_DISCOVERY_INCLUDE_CIDRS", "192.168.1.0/24")
    monkeypatch.setenv("STREAM_DISCOVERY_EXCLUDE_CIDRS", "10.0.0.0/24")

    hosts = networking.coordinator_discovery_hosts(limit_per_subnet=1)

    assert hosts == ["192.168.1.1"]


def test_ensure_distributed_runtime_defaults_sets_required_env(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(launcher, "discover_coordinators", lambda **kwargs: [])
    monkeypatch.setenv("STREAM_SETTINGS_DIR", str(tmp_path))
    monkeypatch.setenv("STREAM_ROOT_DIR", str(tmp_path))
    monkeypatch.delenv("COORDINATOR_SECRET_KEY", raising=False)
    monkeypatch.delenv("COORDINATOR_AGENT_SHARED_SECRET", raising=False)
    monkeypatch.delenv("COORDINATOR_DATABASE_URL", raising=False)
    monkeypatch.delenv("AGENT_STATE_DB_URL", raising=False)
    monkeypatch.delenv("AGENT_COORDINATOR_URL", raising=False)
    monkeypatch.delenv("AGENT_PUBLIC_BASE_URL", raising=False)
    monkeypatch.delenv("AGENT_DEFAULT_SHARE_ROOT", raising=False)
    monkeypatch.delenv("AGENT_INBOX_DIR", raising=False)

    launcher._ensure_distributed_runtime_defaults()

    assert (tmp_path / "settings.json").exists()
    assert "sqlite:///" in str(os.environ.get("COORDINATOR_DATABASE_URL", ""))
    assert "sqlite:///" in str(os.environ.get("AGENT_STATE_DB_URL", ""))
    assert str(os.environ.get("AGENT_DEFAULT_SHARE_ROOT", "")).endswith(str(tmp_path))
    assert str(os.environ.get("AGENT_INBOX_DIR", "")).endswith(str(tmp_path / ".inbox"))
    assert str(os.environ.get("AGENT_COORDINATOR_URL", "")).startswith("http://")
    assert str(os.environ.get("AGENT_PUBLIC_BASE_URL", "")).startswith("http://")
    assert str(os.environ.get("STREAM_DEFAULT_COORDINATOR_URL", "")).startswith("http://")


def test_settings_dir_falls_back_when_override_is_unwritable(monkeypatch, tmp_path: Path) -> None:
    blocked = tmp_path / "blocked-file"
    blocked.write_text("x", encoding="utf-8")
    monkeypatch.setenv("STREAM_SETTINGS_DIR", str(blocked))
    resolved = launcher._settings_dir()
    assert resolved != blocked
    assert resolved.name == launcher.APP_DIR_NAME


def test_frozen_default_service_is_all(monkeypatch) -> None:
    calls: list[str] = []
    monkeypatch.setattr(launcher.sys, "frozen", True, raising=False)
    monkeypatch.setattr(launcher.sys, "argv", ["app.py"])
    monkeypatch.delenv("STREAM_SERVICE", raising=False)
    monkeypatch.setattr(launcher, "_ensure_distributed_runtime_defaults", lambda: calls.append("defaults"))
    monkeypatch.setattr(launcher, "_run_all_services", lambda: calls.append("all"))
    monkeypatch.setattr(launcher, "_run_web_service", lambda: calls.append("web"))
    monkeypatch.setattr(launcher, "_run_coordinator_service", lambda: calls.append("coordinator"))
    monkeypatch.setattr(launcher, "_run_agent_service", lambda: calls.append("agent"))

    launcher._run()

    assert calls == ["defaults", "all"]


def test_ensure_local_agent_identity_uses_saved_credentials(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("STREAM_SETTINGS_DIR", str(tmp_path))
    monkeypatch.setenv("AGENT_COORDINATOR_URL", "http://192.168.1.40:7000")
    settings_path = tmp_path / "settings.json"
    settings_path.write_text(
        json.dumps(
            {
                "network_coordinator_url": "http://192.168.1.40:7000",
                "network_principal_id": "p-1",
                "network_client_device_id": "c-1",
                "network_device_secret": "secret-1",
            }
        ),
        encoding="utf-8",
    )

    monkeypatch.setattr(launcher, "_http_json", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not call coordinator")))
    launcher._ensure_local_agent_identity()

    assert os.environ.get("AGENT_OWNER_PRINCIPAL_ID") == "p-1"
    assert os.environ.get("STREAM_COORD_CLIENT_DEVICE_ID") == "c-1"
    assert os.environ.get("STREAM_COORD_DEVICE_SECRET") == "secret-1"


def test_ensure_local_agent_identity_bootstraps_and_persists(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("STREAM_SETTINGS_DIR", str(tmp_path))
    monkeypatch.setenv("AGENT_COORDINATOR_URL", "http://192.168.1.40:7000")
    monkeypatch.delenv("AGENT_OWNER_PRINCIPAL_ID", raising=False)
    monkeypatch.setattr(
        launcher,
        "_http_json",
        lambda *args, **kwargs: {
            "bootstrap": True,
            "principal_id": "p-2",
            "client_device_id": "c-2",
            "device_secret": "secret-2",
            "access_token": "token-2",
        },
    )

    launcher._ensure_local_agent_identity()

    assert os.environ.get("AGENT_OWNER_PRINCIPAL_ID") == "p-2"
    payload = json.loads((tmp_path / "settings.json").read_text(encoding="utf-8"))
    assert payload["network_principal_id"] == "p-2"
    assert payload["network_client_device_id"] == "c-2"
    assert payload["network_device_secret"] == "secret-2"


def test_network_session_defaults_redacts_identity_when_not_local(monkeypatch) -> None:
    monkeypatch.setenv("STREAM_DEFAULT_COORDINATOR_URL", "http://192.168.1.4:7000")
    monkeypatch.setenv("STREAM_COORD_PRINCIPAL_ID", "p-local")
    monkeypatch.setenv("STREAM_COORD_CLIENT_DEVICE_ID", "c-local")
    monkeypatch.setenv("STREAM_COORD_DEVICE_SECRET", "secret-local")
    monkeypatch.setenv("AGENT_DEVICE_ID", "agent-local")
    monkeypatch.setattr(web_routes, "load_settings", lambda: {})

    redacted = web_routes._network_session_defaults(include_identity=False)
    assert redacted["coordinator_url"] == "http://192.168.1.4:7000"
    assert redacted["principal_id"] == ""
    assert redacted["client_device_id"] == ""
    assert redacted["device_secret"] == ""
    assert redacted["local_agent_device_id"] == ""

    full = web_routes._network_session_defaults(include_identity=True)
    assert full["principal_id"] == "p-local"
    assert full["client_device_id"] == "c-local"
    assert full["device_secret"] == "secret-local"
    assert full["local_agent_device_id"] == "agent-local"


def test_is_local_request_address_detects_loopback_and_local_ipv4(monkeypatch) -> None:
    monkeypatch.setattr(web_routes, "local_ipv4_addresses", lambda **kwargs: ["192.168.1.4"])
    assert web_routes._is_local_request_address("127.0.0.1")
    assert web_routes._is_local_request_address("192.168.1.4")
    assert not web_routes._is_local_request_address("192.168.1.99")


def test_network_bootstrap_context_falls_back_to_saved_agent_device_id(monkeypatch) -> None:
    app = Flask(__name__)
    app.config["PORT"] = 5000

    monkeypatch.delenv("AGENT_DEVICE_ID", raising=False)
    monkeypatch.delenv("STREAM_DEFAULT_COORDINATOR_URL", raising=False)
    monkeypatch.setattr(web_routes, "preferred_lan_ipv4", lambda: "192.168.1.4")
    monkeypatch.setattr(web_routes, "local_ipv4_addresses", lambda **kwargs: ["192.168.1.4"])
    monkeypatch.setattr(web_routes, "load_settings", lambda: {"agent_device_id": "agent-from-settings"})

    with app.app_context():
        context = web_routes._network_bootstrap_context()

    assert context["local_agent_device_id"] == "agent-from-settings"


def test_transfer_create_request_allows_up_to_200_items() -> None:
    from shared.schemas import TransferCreateRequest

    items = [
        {
            "filename": f"f-{index}.txt",
            "size": 1,
            "sha256": "0" * 64,
            "mime_type": None,
        }
        for index in range(200)
    ]
    payload = TransferCreateRequest(
        receiver_device_id="device-1",
        receiver_share_id="share-1",
        items=items,
    )
    assert len(payload.items) == 200


def test_coordinator_default_transfer_ticket_ttl_is_extended(monkeypatch) -> None:
    monkeypatch.setenv("ALLOW_INSECURE_DEFAULTS", "1")
    monkeypatch.delenv("COORDINATOR_TRANSFER_TICKET_TTL", raising=False)
    from coordinator.config import load_config

    config = load_config()
    assert config.transfer_ticket_ttl_seconds == 1800


def test_coordinator_default_read_ticket_ttl_is_extended(monkeypatch) -> None:
    monkeypatch.setenv("ALLOW_INSECURE_DEFAULTS", "1")
    monkeypatch.delenv("COORDINATOR_READ_TICKET_TTL", raising=False)
    from coordinator.config import load_config

    config = load_config()
    assert config.read_ticket_ttl_seconds == 1800


def test_coordinator_browse_pin_defaults_to_stream_pin(monkeypatch) -> None:
    monkeypatch.setenv("ALLOW_INSECURE_DEFAULTS", "1")
    monkeypatch.setenv("STREAM_PIN", "246810")
    monkeypatch.delenv("COORDINATOR_BROWSE_PIN", raising=False)
    from coordinator.config import load_config

    config = load_config()
    assert config.browse_access_pin == "246810"
