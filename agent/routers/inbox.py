from __future__ import annotations

import hashlib
import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import load_config
from ..db import get_db
from ..models import InboxTransferItem, LocalShare
from ..security import verify_transfer_ticket
from ..services.coordinator_sync import fetch_transfer_item_manifest, notify_transfer_item_state
from ..services.file_service import resolve_share_path

router = APIRouter(prefix="/agent/v1/inbox/transfers", tags=["agent-inbox"])
UNKNOWN_SHA256 = "0" * 64


class FinalizeRequest(BaseModel):
    item_id: str
    destination_path: str = Field(default="", max_length=400)
    keep_original_name: bool = True


def _safe_filename(name: str) -> str:
    cleaned = Path(name).name.strip()
    if not cleaned:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid filename")
    return cleaned


def _part_dir(config, transfer_id: str) -> Path:
    path = config.inbox_dir / "transfers" / transfer_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def _committed_dir(config, transfer_id: str) -> Path:
    path = config.inbox_dir / "committed" / transfer_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def _next_available_path(path: Path) -> Path:
    if not path.exists():
        return path
    stem = path.stem
    suffix = path.suffix
    for index in range(1, 1000):
        candidate = path.with_name(f"{stem} ({index}){suffix}")
        if not candidate.exists():
            return candidate
    raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Failed to allocate destination filename")


def _get_share(db: Session, share_id: str) -> LocalShare:
    share = db.get(LocalShare, share_id)
    if not share:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Share not found")
    return share


def _load_items(db: Session, transfer_id: str, share_id: str) -> list[InboxTransferItem]:
    return db.execute(
        select(InboxTransferItem).where(
            InboxTransferItem.transfer_id == transfer_id,
            InboxTransferItem.share_id == share_id,
        )
    ).scalars().all()


@router.get("/{transfer_id}/status")
def transfer_status(
    transfer_id: str,
    share_id: str,
    ticket: str = Query(min_length=1),
    db: Session = Depends(get_db),
) -> dict:
    verify_transfer_ticket(ticket, transfer_id, share_id)
    items = _load_items(db, transfer_id, share_id)
    return {
        "transfer_id": transfer_id,
        "items": [
            {
                "item_id": item.item_id,
                "filename": item.filename,
                "expected_size": item.expected_size,
                "received_size": item.received_size,
                "state": item.state,
            }
            for item in items
        ],
    }


@router.post("/{transfer_id}/pause")
def pause_transfer(
    transfer_id: str,
    share_id: str,
    ticket: str = Query(min_length=1),
    db: Session = Depends(get_db),
) -> dict:
    config = load_config()
    verify_transfer_ticket(ticket, transfer_id, share_id)
    items = _load_items(db, transfer_id, share_id)
    for item in items:
        if item.state in {"pending", "receiving", "staged"}:
            item.state = "paused"
            notify_transfer_item_state(config, transfer_id, item.item_id, "paused")
    db.commit()
    return {"ok": True}


@router.post("/{transfer_id}/resume")
def resume_transfer(
    transfer_id: str,
    share_id: str,
    ticket: str = Query(min_length=1),
    db: Session = Depends(get_db),
) -> dict:
    config = load_config()
    verify_transfer_ticket(ticket, transfer_id, share_id)
    items = _load_items(db, transfer_id, share_id)
    for item in items:
        if item.state == "paused":
            item.state = "receiving"
            notify_transfer_item_state(config, transfer_id, item.item_id, "receiving")
    db.commit()
    return {"ok": True}


@router.post("/{transfer_id}/chunk")
async def upload_chunk(
    transfer_id: str,
    request: Request,
    share_id: str,
    item_id: str,
    filename: str,
    size: int = Query(ge=0),
    sha256: str = Query(min_length=64, max_length=64),
    ticket: str = Query(min_length=1),
    db: Session = Depends(get_db),
) -> dict:
    config = load_config()
    verify_transfer_ticket(ticket, transfer_id, share_id)
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            content_length_value = int(content_length)
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid content-length header") from exc
        if content_length_value < 0:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid content-length header")
        if content_length_value > config.upload_chunk_max_bytes:
            raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="Chunk too large")

    offset_header = request.headers.get("x-chunk-offset", "0")
    try:
        offset = int(offset_header)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid x-chunk-offset header") from exc
    if offset < 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid x-chunk-offset header")

    is_last_chunk = request.headers.get("x-chunk-last", "0").strip() == "1"
    safe_name = _safe_filename(filename)
    sha256_lower = sha256.lower()
    if len(sha256_lower) != 64:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid sha256")

    record = db.get(InboxTransferItem, f"{transfer_id}:{item_id}")
    if not record:
        manifest = fetch_transfer_item_manifest(config, transfer_id, item_id)
        if not manifest:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transfer item not approved")
        if str(manifest.get("receiver_share_id") or "") != share_id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Share mismatch for transfer item")

        expected_filename = _safe_filename(str(manifest.get("filename") or ""))
        expected_size = int(manifest.get("size") or 0)
        expected_sha256 = str(manifest.get("sha256") or "").lower()
        if len(expected_sha256) != 64:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Transfer item manifest is invalid")
        if safe_name != expected_filename or size != expected_size or sha256_lower != expected_sha256:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Chunk metadata mismatch")

        part_path = _part_dir(config, transfer_id) / f"{item_id}.part"
        record = InboxTransferItem(
            id=f"{transfer_id}:{item_id}",
            transfer_id=transfer_id,
            item_id=item_id,
            share_id=share_id,
            filename=expected_filename,
            expected_size=expected_size,
            expected_sha256=expected_sha256,
            received_size=0,
            part_path=str(part_path),
            state="pending",
        )
        db.add(record)
        db.flush()

    if record.share_id != share_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Share mismatch for item")
    if record.state in {"committed", "finalized"}:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Item already committed")
    if record.state == "paused":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Transfer is paused")
    if record.expected_sha256 != sha256_lower or record.expected_size != size:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Chunk metadata mismatch")

    part_path = Path(record.part_path)
    part_path.parent.mkdir(parents=True, exist_ok=True)
    current_size = part_path.stat().st_size if part_path.exists() else 0
    if current_size != record.received_size:
        record.received_size = current_size
    if offset != record.received_size:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Unexpected chunk offset, expected {record.received_size}",
        )

    mode = "r+b" if part_path.exists() else "wb"
    remaining_expected = record.expected_size - offset
    if remaining_expected < 0:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Chunk offset exceeds expected size")
    with part_path.open(mode) as file_obj:
        file_obj.seek(offset)
        written = 0
        try:
            async for payload_chunk in request.stream():
                if not payload_chunk:
                    continue
                written += len(payload_chunk)
                if written > config.upload_chunk_max_bytes:
                    raise HTTPException(
                        status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                        detail="Chunk too large",
                    )
                if written > remaining_expected:
                    raise HTTPException(
                        status_code=status.HTTP_409_CONFLICT,
                        detail="Chunk exceeds expected item size",
                    )
                file_obj.write(payload_chunk)
        except HTTPException:
            file_obj.truncate(offset)
            raise
        except Exception as exc:  # noqa: BLE001
            file_obj.truncate(offset)
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Failed to read chunk payload") from exc

    record.received_size = offset + written
    if is_last_chunk and record.received_size != record.expected_size:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Final chunk does not match expected size")
    new_state = "staged" if is_last_chunk else "receiving"
    state_changed = record.state != new_state
    record.state = new_state
    db.commit()
    if state_changed:
        notify_transfer_item_state(config, transfer_id, record.item_id, record.state)
    return {
        "item_id": record.item_id,
        "received_size": record.received_size,
        "expected_size": record.expected_size,
        "state": record.state,
    }


@router.post("/{transfer_id}/commit")
def commit_transfer_item(
    transfer_id: str,
    share_id: str,
    item_id: str,
    ticket: str = Query(min_length=1),
    db: Session = Depends(get_db),
) -> dict:
    config = load_config()
    verify_transfer_ticket(ticket, transfer_id, share_id)
    record = db.get(InboxTransferItem, f"{transfer_id}:{item_id}")
    if not record or record.transfer_id != transfer_id or record.share_id != share_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transfer item not found")

    part_path = Path(record.part_path)
    if not part_path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transfer chunk file missing")
    if part_path.stat().st_size != record.expected_size:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Received size does not match expected size")

    if record.expected_sha256 != UNKNOWN_SHA256:
        digest = hashlib.sha256()
        with part_path.open("rb") as file_obj:
            for chunk in iter(lambda: file_obj.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest().lower() != record.expected_sha256:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Checksum mismatch")

    committed_path = _next_available_path(_committed_dir(config, transfer_id) / _safe_filename(record.filename))
    committed_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(part_path), str(committed_path))
    record.inbox_path = str(committed_path)
    record.state = "committed"
    db.commit()
    notify_transfer_item_state(config, transfer_id, record.item_id, "committed")
    return {
        "item_id": record.item_id,
        "state": record.state,
        "inbox_path": record.inbox_path,
    }


@router.post("/{transfer_id}/finalize")
def finalize_transfer_item(
    transfer_id: str,
    body: FinalizeRequest,
    share_id: str,
    ticket: str = Query(min_length=1),
    db: Session = Depends(get_db),
) -> dict:
    config = load_config()
    verify_transfer_ticket(ticket, transfer_id, share_id)
    record = db.get(InboxTransferItem, f"{transfer_id}:{body.item_id}")
    if not record or record.transfer_id != transfer_id or record.share_id != share_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transfer item not found")
    if record.state not in {"committed", "finalized"}:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Transfer item is not committed")

    share = _get_share(db, share_id)
    if share.read_only:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Share is read-only")

    source_path = Path(record.inbox_path or "")
    if not source_path.exists() or not source_path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Committed file not found")

    share_root = Path(share.root_path).expanduser().resolve()
    try:
        destination_dir = resolve_share_path(share_root, body.destination_path)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    destination_dir.mkdir(parents=True, exist_ok=True)

    target_name = _safe_filename(record.filename) if body.keep_original_name else _safe_filename(source_path.name)
    destination_path = _next_available_path(destination_dir / target_name)
    shutil.move(str(source_path), str(destination_path))
    record.state = "finalized"
    record.inbox_path = str(destination_path)
    db.commit()
    notify_transfer_item_state(config, transfer_id, record.item_id, "finalized")
    return {
        "item_id": record.item_id,
        "state": record.state,
        "final_path": record.inbox_path,
    }
