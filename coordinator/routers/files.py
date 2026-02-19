from __future__ import annotations

from datetime import datetime, timedelta, timezone
import atexit
from concurrent.futures import TimeoutError, ThreadPoolExecutor, as_completed
import threading
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import load_config
from ..db import get_db
from ..models import AgentDevice, Share
from ..services.acl import get_permissions_for_shares, require_permission
from ..services.agent_client import list_share, search_share
from ..services.auth import AuthContext, issue_read_ticket, require_auth_context

router = APIRouter(prefix="/api/v1/files", tags=["files"])
_CONFIG = load_config()
_SEARCH_EXECUTOR = ThreadPoolExecutor(
    max_workers=max(4, _CONFIG.search_executor_workers),
    thread_name_prefix="coord-search",
)
_SEARCH_EXECUTOR_LOCK = threading.Lock()
_SEARCH_EXECUTOR_CLOSED = False


def shutdown_search_executor() -> None:
    global _SEARCH_EXECUTOR_CLOSED
    with _SEARCH_EXECUTOR_LOCK:
        if _SEARCH_EXECUTOR_CLOSED:
            return
        _SEARCH_EXECUTOR_CLOSED = True
    _SEARCH_EXECUTOR.shutdown(wait=False, cancel_futures=True)


atexit.register(shutdown_search_executor)


def _build_file_urls(agent_base_url: str, share_id: str, path: str, ticket: str) -> dict:
    encoded_path = quote(path, safe="")
    encoded_ticket = quote(ticket, safe="")
    return {
        "stream_url": (
            f"{agent_base_url.rstrip('/')}/agent/v1/shares/{share_id}/stream"
            f"?path={encoded_path}&ticket={encoded_ticket}"
        ),
        "download_url": (
            f"{agent_base_url.rstrip('/')}/agent/v1/shares/{share_id}/download"
            f"?path={encoded_path}&ticket={encoded_ticket}"
        ),
    }


def _utcnow() -> datetime:
    return datetime.now(tz=timezone.utc)


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _is_online(device: AgentDevice) -> bool:
    if not device.last_seen:
        return False
    return device.online_state and (_utcnow() - _as_utc(device.last_seen)) <= timedelta(seconds=90)


@router.get("/list")
def list_files(
    device_id: str,
    share_id: str,
    path: str = "",
    max_results: int = Query(default=300, ge=50, le=5000),
    auth: AuthContext = Depends(require_auth_context),
    db: Session = Depends(get_db),
) -> dict:
    config = _CONFIG
    share = db.get(Share, share_id)
    if not share:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Share not found")
    if share.agent_device_id != device_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Share does not belong to device")
    device = db.get(AgentDevice, device_id)
    if not device:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device not found")
    if not device.visibility and device.owner_principal_id != auth.principal_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device not found")
    if not _is_online(device):
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Device is offline")

    permissions = require_permission(db, auth.principal_id, share, "read")
    ticket = issue_read_ticket(config, auth.principal_id, share.id, permissions)
    payload = list_share(device.base_url, share.id, path, ticket, max_results=max_results)
    items = payload.get("items", [])
    for item in items:
        if item.get("is_dir"):
            continue
        urls = _build_file_urls(device.base_url, share.id, str(item.get("path") or ""), ticket)
        item["stream_url"] = urls["stream_url"]
        if "download" in permissions:
            item["download_url"] = urls["download_url"]
    payload["device_id"] = device.id
    payload["share_id"] = share.id
    payload["permissions"] = sorted(permissions)
    return payload


@router.get("/search")
def search_files(
    q: str = Query(min_length=1, max_length=120),
    device_id: str | None = None,
    share_id: str | None = None,
    path: str = "",
    recursive: bool = True,
    max_shares: int = Query(default=30, ge=1, le=200),
    max_results_per_share: int = Query(default=200, ge=10, le=1000),
    max_results_total: int = Query(default=800, ge=20, le=5000),
    timeout_budget_ms: int = Query(default=6000, ge=500, le=20000),
    auth: AuthContext = Depends(require_auth_context),
    db: Session = Depends(get_db),
) -> dict:
    config = _CONFIG
    if device_id and share_id:
        share = db.get(Share, share_id)
        if not share:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Share not found")
        if share.agent_device_id != device_id:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Share does not belong to device")

        device = db.get(AgentDevice, device_id)
        if not device:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device not found")
        if not device.visibility and device.owner_principal_id != auth.principal_id:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device not found")
        if not _is_online(device):
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Device is offline")

        permissions = require_permission(db, auth.principal_id, share, "read")
        ticket = issue_read_ticket(config, auth.principal_id, share.id, permissions)
        payload = search_share(
            device.base_url,
            share.id,
            path,
            q,
            recursive,
            ticket,
            max_results=min(max_results_per_share, max_results_total),
        )
        items = payload.get("items", [])
        for item in items:
            if item.get("is_dir"):
                continue
            urls = _build_file_urls(device.base_url, share.id, str(item.get("path") or ""), ticket)
            item["stream_url"] = urls["stream_url"]
            if "download" in permissions:
                item["download_url"] = urls["download_url"]
        payload["device_id"] = device.id
        payload["share_id"] = share.id
        payload["permissions"] = sorted(permissions)
        return payload

    rows = db.execute(
        select(Share, AgentDevice).join(AgentDevice, Share.agent_device_id == AgentDevice.id)
    ).all()
    owner_map: dict[str, str] = {}
    visible_shares: list[tuple[Share, AgentDevice]] = []
    for share, device in rows:
        if not device.visibility and device.owner_principal_id != auth.principal_id:
            continue
        if not _is_online(device):
            continue
        owner_map[share.id] = device.owner_principal_id
        visible_shares.append((share, device))

    permissions_by_share = get_permissions_for_shares(
        db,
        auth.principal_id,
        [share for share, _device in visible_shares],
        owner_map=owner_map,
    )

    candidate_shares: list[tuple[AgentDevice, Share, set[str]]] = []
    for share, device in visible_shares:
        permissions = permissions_by_share.get(share.id, set())
        if "read" not in permissions:
            continue
        candidate_shares.append((device, share, permissions))
        if len(candidate_shares) >= max_shares:
            break

    results: list[dict] = []
    errors: list[dict] = []
    truncated = False

    def _run_search(device: AgentDevice, share: Share, permissions: set[str]) -> dict:
        ticket = issue_read_ticket(config, auth.principal_id, share.id, permissions)
        payload = search_share(
            device.base_url,
            share.id,
            path,
            q,
            recursive,
            ticket,
            max_results=max_results_per_share,
        )
        items = payload.get("items", [])
        prepared_items = []
        for item in items[:max_results_per_share]:
            item = dict(item)
            item["device_id"] = device.id
            item["share_id"] = share.id
            item["share_name"] = share.name
            item["device_name"] = device.name
            if not item.get("is_dir"):
                urls = _build_file_urls(device.base_url, share.id, str(item.get("path") or ""), ticket)
                item["stream_url"] = urls["stream_url"]
                if "download" in permissions:
                    item["download_url"] = urls["download_url"]
            prepared_items.append(item)
        return {"items": prepared_items, "truncated": payload.get("truncated", False)}

    if not candidate_shares:
        return {
            "query": q,
            "base_path": path,
            "recursive": recursive,
            "federated": True,
            "items": [],
            "truncated": False,
            "errors": [],
        }

    timeout_seconds = timeout_budget_ms / 1000
    future_map = {}
    try:
        for device, share, permissions in candidate_shares:
            future = _SEARCH_EXECUTOR.submit(_run_search, device, share, permissions)
            future_map[future] = (device, share)
    except RuntimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Search worker is unavailable",
        ) from exc
    try:
        try:
            for future in as_completed(future_map, timeout=timeout_seconds):
                device, share = future_map[future]
                try:
                    payload = future.result()
                except Exception as exc:  # noqa: BLE001
                    errors.append(
                        {
                            "device_id": device.id,
                            "share_id": share.id,
                            "error": str(exc),
                        }
                    )
                    continue
                if payload.get("truncated"):
                    truncated = True
                for item in payload.get("items", []):
                    results.append(item)
                    if len(results) >= max_results_total:
                        truncated = True
                        break
                if truncated and len(results) >= max_results_total:
                    break
        except TimeoutError:
            truncated = True
    finally:
        pending = [future for future in future_map if not future.done()]
        for future in pending:
            future.cancel()

    results.sort(key=lambda item: (not item.get("is_dir", False), str(item.get("path", "")).casefold()))
    return {
        "query": q,
        "base_path": path,
        "recursive": recursive,
        "federated": True,
        "items": results[:max_results_total],
        "truncated": truncated,
        "errors": errors,
    }
