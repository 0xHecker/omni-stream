from __future__ import annotations

import os
import threading
import time
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlparse
from uuid import uuid4

import httpx
from flask import Response, abort, current_app, session

from shared.networking import discover_coordinators, local_ipv4_addresses, preferred_lan_ipv4
from shared.runtime import env_int

from stream_server.settings_store import load_settings

HUB_SESSION_BROWSER_ID_KEY = "hub_browser_id"
HUB_SESSION_ACTIVE_ID_KEY = "hub_active_id"
HUB_SESSION_UNLOCKED_IDS_KEY = "hub_unlocked_ids"
HUB_DISCOVERY_CACHE_TTL_SECONDS = 8.0
LOCAL_HUB_ID = "local"

_hub_clients_lock = threading.Lock()
_hub_clients: dict[tuple[str, str], httpx.Client] = {}
_hub_discovery_cache_lock = threading.Lock()
_hub_discovery_cache: tuple[float, list[dict[str, Any]]] | None = None


def _is_setup_complete() -> bool:
    pin = str(current_app.config.get("PIN", "")).strip()
    return pin.isdigit() and len(pin) >= 4


def _current_web_port() -> int:
    return env_int("WEB_PORT", int(current_app.config.get("PORT", 5000)), minimum=1, maximum=65535)


def _normalize_hub_url(raw_value: str, *, default_port: int) -> str:
    raw = str(raw_value or "").strip()
    if not raw:
        return ""
    with_protocol = raw if raw.lower().startswith(("http://", "https://")) else f"http://{raw}"
    try:
        parsed = urlparse(with_protocol)
    except ValueError:
        return ""
    scheme = parsed.scheme if parsed.scheme in {"http", "https"} else "http"
    host = str(parsed.hostname or "").strip()
    if not host:
        return ""
    try:
        port = parsed.port or int(default_port)
    except ValueError:
        return ""
    return f"{scheme}://{host}:{int(port)}".rstrip("/")


def _coordinator_host(url_value: str) -> str:
    try:
        parsed = urlparse(str(url_value or "").strip())
    except ValueError:
        return ""
    return str(parsed.hostname or "").strip()


def _hub_id_from_web_url(web_url: str) -> str:
    return str(web_url or "").strip().lower().rstrip("/")


def _local_hub_display_name() -> str:
    settings = load_settings()
    configured = str(settings.get("device_display_name") or "").strip()
    if configured:
        return configured[:80]
    root_dir = str(settings.get("root_dir") or "").strip()
    if root_dir:
        return Path(root_dir).name[:80] or "This Device"
    return "This Device"


def _browser_session_id() -> str:
    existing = str(session.get(HUB_SESSION_BROWSER_ID_KEY) or "").strip()
    if existing:
        return existing
    generated = uuid4().hex
    session[HUB_SESSION_BROWSER_ID_KEY] = generated
    return generated


def _session_unlocked_hub_ids() -> set[str]:
    raw_values = session.get(HUB_SESSION_UNLOCKED_IDS_KEY) or []
    if not isinstance(raw_values, list):
        return set()
    return {
        str(value).strip().lower()
        for value in raw_values
        if str(value).strip()
    }


def _save_unlocked_hub_ids(hub_ids: set[str]) -> None:
    session[HUB_SESSION_UNLOCKED_IDS_KEY] = sorted({
        str(value).strip().lower()
        for value in hub_ids
        if str(value).strip()
    })


def _mark_hub_unlocked(hub_id: str) -> None:
    normalized = str(hub_id or "").strip().lower()
    if not normalized:
        return
    unlocked = _session_unlocked_hub_ids()
    unlocked.add(normalized)
    _save_unlocked_hub_ids(unlocked)


def _active_hub_id() -> str:
    return str(session.get(HUB_SESSION_ACTIVE_ID_KEY) or "").strip().lower()


def _set_active_hub_id(hub_id: str) -> None:
    normalized = str(hub_id or "").strip().lower()
    if not normalized:
        session.pop(HUB_SESSION_ACTIVE_ID_KEY, None)
        return
    session[HUB_SESSION_ACTIVE_ID_KEY] = normalized


def _close_hub_client(browser_id: str, hub_id: str) -> None:
    key = (str(browser_id or "").strip(), str(hub_id or "").strip().lower())
    if not key[0] or not key[1]:
        return
    client: httpx.Client | None = None
    with _hub_clients_lock:
        client = _hub_clients.pop(key, None)
    if client is not None:
        try:
            client.close()
        except Exception:  # noqa: BLE001
            pass


def clear_browser_hub_clients() -> None:
    browser_id = str(session.get(HUB_SESSION_BROWSER_ID_KEY) or "").strip()
    if not browser_id:
        return
    keys_to_remove: list[tuple[str, str]] = []
    with _hub_clients_lock:
        for key in list(_hub_clients):
            if key[0] == browser_id:
                keys_to_remove.append(key)
        for key in keys_to_remove:
            client = _hub_clients.pop(key, None)
            if client is not None:
                try:
                    client.close()
                except Exception:  # noqa: BLE001
                    pass


def mark_hub_locked(hub_id: str) -> None:
    normalized = str(hub_id or "").strip().lower()
    if not normalized:
        return
    unlocked = _session_unlocked_hub_ids()
    if normalized in unlocked:
        unlocked.remove(normalized)
        _save_unlocked_hub_ids(unlocked)
    if _active_hub_id() == normalized:
        _set_active_hub_id("")
    _close_hub_client(str(session.get(HUB_SESSION_BROWSER_ID_KEY) or "").strip(), normalized)


def _is_hub_unlocked(hub_id: str, *, is_local: bool) -> bool:
    if is_local:
        return True
    normalized = str(hub_id or "").strip().lower()
    if not normalized:
        return False
    return normalized in _session_unlocked_hub_ids()


def _get_or_create_hub_client(browser_id: str, hub_id: str, web_url: str) -> httpx.Client:
    key = (str(browser_id or "").strip(), str(hub_id or "").strip().lower())
    normalized_url = str(web_url or "").strip().rstrip("/")
    if not key[0] or not key[1] or not normalized_url:
        raise ValueError("Hub client key/url is invalid")
    with _hub_clients_lock:
        existing = _hub_clients.get(key)
        if existing is not None:
            if str(existing.base_url).rstrip("/") == normalized_url:
                return existing
            try:
                existing.close()
            except Exception:  # noqa: BLE001
                pass
            _hub_clients.pop(key, None)
        created = httpx.Client(
            base_url=normalized_url,
            timeout=httpx.Timeout(15.0, connect=2.5),
            follow_redirects=False,
            headers={"User-Agent": "stream-local-hub-proxy"},
        )
        _hub_clients[key] = created
        return created


def _local_hub_payload() -> dict[str, Any]:
    primary_url = _normalize_hub_url(
        f"http://{preferred_lan_ipv4()}:{_current_web_port()}",
        default_port=_current_web_port(),
    )
    return {
        "id": LOCAL_HUB_ID,
        "name": _local_hub_display_name(),
        "web_url": primary_url,
        "is_local": True,
        "setup_complete": _is_setup_complete(),
    }


def _fetch_remote_hub_meta(web_url: str) -> dict[str, Any] | None:
    normalized_url = _normalize_hub_url(web_url, default_port=_current_web_port())
    if not normalized_url:
        return None
    try:
        response = httpx.get(
            f"{normalized_url}/api/hub/meta",
            timeout=httpx.Timeout(1.2, connect=0.45),
            follow_redirects=False,
            headers={"Accept": "application/json", "User-Agent": "stream-local-hub-discovery"},
        )
    except httpx.HTTPError:
        return None
    if response.status_code != 200:
        return None
    try:
        payload = response.json()
    except ValueError:
        return None
    if not isinstance(payload, dict):
        return None
    if str(payload.get("service") or "").strip().lower() != "stream-web-hub":
        return None
    name = str(payload.get("name") or payload.get("display_name") or "").strip()
    host = _coordinator_host(normalized_url)
    if not name:
        name = host or "LAN Device"
    return {
        "id": _hub_id_from_web_url(normalized_url),
        "name": name[:80],
        "web_url": normalized_url,
        "is_local": False,
        "setup_complete": bool(payload.get("setup_complete", True)),
    }


def discover_hubs(*, force: bool = False) -> list[dict[str, Any]]:
    global _hub_discovery_cache

    now = time.monotonic()
    if not force:
        with _hub_discovery_cache_lock:
            if _hub_discovery_cache and (now - _hub_discovery_cache[0]) < HUB_DISCOVERY_CACHE_TTL_SECONDS:
                return [dict(item) for item in _hub_discovery_cache[1]]

    local_hub = _local_hub_payload()
    web_port = _current_web_port()
    local_hosts = set(local_ipv4_addresses(include_loopback=True)) | {"localhost", "127.0.0.1", "::1"}

    coordinator_port = env_int("COORDINATOR_PORT", 7000, minimum=1, maximum=65535)
    coordinator_candidates = discover_coordinators(
        port=coordinator_port,
        timeout_seconds=0.16,
        max_workers=48,
        max_results=16,
    )

    candidate_urls: list[str] = []
    hints = str(os.environ.get("STREAM_HUB_HINTS", "")).strip()
    if hints:
        candidate_urls.extend([item.strip() for item in hints.split(",") if item.strip()])
    candidate_urls.append(local_hub["web_url"])
    for coordinator_url in coordinator_candidates:
        host = _coordinator_host(coordinator_url)
        if not host:
            continue
        candidate_urls.append(f"http://{host}:{web_port}")

    normalized_candidates: list[str] = []
    seen_urls: set[str] = set()
    for value in candidate_urls:
        normalized = _normalize_hub_url(value, default_port=web_port)
        if not normalized or normalized in seen_urls:
            continue
        seen_urls.add(normalized)
        normalized_candidates.append(normalized)

    hubs: list[dict[str, Any]] = [local_hub]
    seen_hub_ids = {str(local_hub["id"]).lower()}
    for candidate in normalized_candidates:
        host = _coordinator_host(candidate)
        if host in local_hosts:
            continue
        meta = _fetch_remote_hub_meta(candidate)
        if not meta:
            continue
        hub_id = str(meta.get("id") or "").strip().lower()
        if not hub_id or hub_id in seen_hub_ids:
            continue
        seen_hub_ids.add(hub_id)
        hubs.append(meta)

    with _hub_discovery_cache_lock:
        _hub_discovery_cache = (time.monotonic(), [dict(item) for item in hubs])
    return hubs


def _find_hub_by_id(hub_id: str, *, force_discovery: bool = False) -> dict[str, Any] | None:
    normalized = str(hub_id or "").strip().lower()
    if not normalized:
        return None
    for hub in discover_hubs(force=force_discovery):
        if str(hub.get("id") or "").strip().lower() == normalized:
            return hub
    return None


def _is_remote_auth_failure(response: httpx.Response) -> bool:
    if response.status_code == 401:
        return True
    if response.status_code in {301, 302, 303, 307, 308}:
        location = str(response.headers.get("location") or "").strip().lower()
        if location.startswith("/login") or "/login?" in location:
            return True
    return False


def _abort_remote_error(response: httpx.Response, default_detail: str) -> None:
    detail = default_detail
    try:
        payload = response.json()
    except ValueError:
        payload = None
    if isinstance(payload, dict):
        candidate = str(payload.get("error") or payload.get("detail") or "").strip()
        if candidate:
            detail = candidate
    abort(response.status_code if response.status_code >= 400 else 502, description=detail)


def public_hub_meta(url_root: str) -> dict[str, Any]:
    normalized_root = _normalize_hub_url(str(url_root or "").rstrip("/"), default_port=_current_web_port())
    local_hub = _local_hub_payload()
    return {
        "service": "stream-web-hub",
        "id": LOCAL_HUB_ID,
        "name": local_hub["name"],
        "web_url": normalized_root or local_hub["web_url"],
        "setup_complete": _is_setup_complete(),
    }


def list_hubs(refresh: bool) -> dict[str, Any]:
    hubs = discover_hubs(force=bool(refresh))
    unlocked = _session_unlocked_hub_ids()
    active_id = _active_hub_id()

    hub_ids = {str(hub.get("id") or "").strip().lower() for hub in hubs}
    if active_id and active_id not in hub_ids:
        _set_active_hub_id("")
        active_id = ""

    payload_hubs: list[dict[str, Any]] = []
    for hub in hubs:
        hub_id = str(hub.get("id") or "").strip().lower()
        is_local = bool(hub.get("is_local"))
        locked = False if is_local else hub_id not in unlocked
        payload_hubs.append(
            {
                "id": hub_id,
                "name": str(hub.get("name") or "LAN Device"),
                "web_url": str(hub.get("web_url") or ""),
                "is_local": is_local,
                "locked": locked,
                "setup_complete": bool(hub.get("setup_complete", True)),
                "can_setup": is_local,
            }
        )
        if active_id == hub_id and locked:
            _set_active_hub_id("")
            active_id = ""

    return {"hubs": payload_hubs, "active_hub_id": active_id}


def select_hub(payload: dict[str, Any]) -> dict[str, Any]:
    raw_hub_id = str(payload.get("hub_id") or "").strip().lower()
    if not raw_hub_id:
        _set_active_hub_id("")
        return {"active_hub_id": ""}

    if raw_hub_id == LOCAL_HUB_ID:
        _set_active_hub_id(LOCAL_HUB_ID)
        return {"active_hub_id": LOCAL_HUB_ID}

    hub = _find_hub_by_id(raw_hub_id)
    if not hub:
        abort(404, description="Device not found")
    if bool(hub.get("is_local")):
        _set_active_hub_id(LOCAL_HUB_ID)
        return {"active_hub_id": LOCAL_HUB_ID}
    if not _is_hub_unlocked(raw_hub_id, is_local=False):
        abort(409, description="Selected device is locked. Enter PIN to continue.")

    _set_active_hub_id(raw_hub_id)
    return {"active_hub_id": raw_hub_id}


def unlock_hub(payload: dict[str, Any]) -> dict[str, Any]:
    raw_hub_id = str(payload.get("hub_id") or "").strip().lower()
    pin = str(payload.get("pin") or "").strip()
    if not raw_hub_id:
        abort(400, description="hub_id is required")
    if raw_hub_id == LOCAL_HUB_ID:
        _set_active_hub_id(LOCAL_HUB_ID)
        return {"hub_id": LOCAL_HUB_ID, "unlocked": True, "active_hub_id": LOCAL_HUB_ID}
    if not pin:
        abort(400, description="PIN is required")

    hub = _find_hub_by_id(raw_hub_id, force_discovery=True)
    if not hub:
        abort(404, description="Device not found")
    if bool(hub.get("is_local")):
        _set_active_hub_id(LOCAL_HUB_ID)
        return {"hub_id": LOCAL_HUB_ID, "unlocked": True, "active_hub_id": LOCAL_HUB_ID}

    browser_id = _browser_session_id()
    client = _get_or_create_hub_client(browser_id, raw_hub_id, str(hub.get("web_url") or ""))

    form_payload = urlencode({"pin": pin})
    try:
        _ = client.post(
            "/login",
            content=form_payload,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        probe = client.get(
            "/list",
            params={"path": "", "max": "1", "page": "1"},
            headers={"Accept": "application/json"},
        )
    except httpx.HTTPError:
        mark_hub_locked(raw_hub_id)
        abort(502, description="Remote device is unreachable")

    if _is_remote_auth_failure(probe):
        mark_hub_locked(raw_hub_id)
        abort(400, description="Invalid PIN")
    if not probe.is_success:
        _abort_remote_error(probe, "Remote device rejected unlock request")

    _mark_hub_unlocked(raw_hub_id)
    _set_active_hub_id(raw_hub_id)
    return {"hub_id": raw_hub_id, "unlocked": True, "active_hub_id": raw_hub_id}


def lock_hub(payload: dict[str, Any]) -> dict[str, Any]:
    raw_hub_id = str(payload.get("hub_id") or "").strip().lower()
    if not raw_hub_id or raw_hub_id == LOCAL_HUB_ID:
        _set_active_hub_id("")
        return {"locked": True, "active_hub_id": ""}
    mark_hub_locked(raw_hub_id)
    return {"locked": True, "active_hub_id": _active_hub_id()}


def active_remote_hub() -> dict[str, Any] | None:
    active_id = _active_hub_id()
    if not active_id or active_id == LOCAL_HUB_ID:
        return None
    hub = _find_hub_by_id(active_id)
    if not hub:
        mark_hub_locked(active_id)
        return None
    if bool(hub.get("is_local")):
        return None
    if not _is_hub_unlocked(active_id, is_local=False):
        abort(409, description="Selected device is locked. Enter PIN to continue.")
    return hub


def proxy_remote_json(hub: dict[str, Any], endpoint: str, *, params: dict[str, str]) -> Response:
    hub_id = str(hub.get("id") or "").strip().lower()
    browser_id = _browser_session_id()
    client = _get_or_create_hub_client(browser_id, hub_id, str(hub.get("web_url") or ""))
    try:
        response = client.get(endpoint, params=params, headers={"Accept": "application/json"})
    except httpx.HTTPError:
        abort(502, description="Remote device is unreachable")

    if _is_remote_auth_failure(response):
        mark_hub_locked(hub_id)
        abort(409, description="PIN expired for selected device. Unlock again.")
    if not response.is_success:
        _abort_remote_error(response, "Remote device request failed")

    try:
        payload = response.json()
    except ValueError:
        abort(502, description="Remote device returned an invalid JSON response")
    from flask import jsonify
    return jsonify(payload)


def _forward_range_header(request_headers: Any | None) -> dict[str, str]:
    if request_headers is None:
        return {}
    range_header = str(request_headers.get("Range") or "").strip()
    if not range_header:
        return {}
    return {"Range": range_header}


def proxy_remote_binary(
    hub: dict[str, Any],
    endpoint: str,
    *,
    params: dict[str, str],
    request_headers: Any | None = None,
) -> Response:
    hub_id = str(hub.get("id") or "").strip().lower()
    browser_id = _browser_session_id()
    client = _get_or_create_hub_client(browser_id, hub_id, str(hub.get("web_url") or ""))
    outbound_headers = {"Accept": "*/*"}
    outbound_headers.update(_forward_range_header(request_headers))
    try:
        response = client.get(endpoint, params=params, headers=outbound_headers)
    except httpx.HTTPError:
        abort(502, description="Remote device is unreachable")

    if _is_remote_auth_failure(response):
        mark_hub_locked(hub_id)
        abort(409, description="PIN expired for selected device. Unlock again.")
    if not response.is_success:
        _abort_remote_error(response, "Remote device request failed")

    passthrough_headers: dict[str, str] = {}
    for header_name in (
        "content-disposition",
        "cache-control",
        "etag",
        "last-modified",
        "accept-ranges",
        "content-range",
        "content-length",
    ):
        value = response.headers.get(header_name)
        if value:
            passthrough_headers[header_name] = value
    content_type = response.headers.get("content-type", "application/octet-stream")
    return Response(response.content, status=response.status_code, headers=passthrough_headers, content_type=content_type)


def request_query_params(query_string: bytes) -> dict[str, str]:
    raw_query = query_string.decode("utf-8", errors="ignore")
    params: dict[str, str] = {}
    for key, value in parse_qsl(raw_query, keep_blank_values=True):
        params[str(key)] = str(value)
    return params


def reset_active_hub() -> None:
    _set_active_hub_id("")
