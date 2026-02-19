from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import LocalShare
from ..security import verify_read_ticket
from ..services.file_service import (
    get_file_type,
    guess_mimetype,
    list_directory,
    resolve_share_path,
    search_entries,
)

router = APIRouter(prefix="/agent/v1/shares", tags=["agent-shares"])


def _get_share(db: Session, share_id: str) -> LocalShare:
    share = db.get(LocalShare, share_id)
    if not share:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Share not found")
    return share


def _share_root(share: LocalShare) -> Path:
    root = Path(share.root_path).expanduser().resolve()
    if not root.exists() or not root.is_dir():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Share root unavailable")
    return root


@router.get("/{share_id}/list")
def list_share_files(
    share_id: str,
    path: str = "",
    max_results: int = Query(default=300, ge=50, le=5000),
    ticket: str = Query(min_length=1),
    db: Session = Depends(get_db),
) -> dict:
    verify_read_ticket(ticket, share_id, "read")
    share = _get_share(db, share_id)
    root = _share_root(share)
    try:
        target = resolve_share_path(root, path)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    if not target.exists() or not target.is_dir():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Directory not found")
    try:
        return list_directory(root, target, max_entries=max_results)
    except PermissionError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Permission denied") from exc


@router.get("/{share_id}/search")
def search_share_files(
    share_id: str,
    q: str = Query(min_length=1, max_length=120),
    path: str = "",
    recursive: bool = True,
    max_results: int = Query(default=300, ge=1, le=1000),
    ticket: str = Query(min_length=1),
    db: Session = Depends(get_db),
) -> dict:
    verify_read_ticket(ticket, share_id, "read")
    share = _get_share(db, share_id)
    root = _share_root(share)
    try:
        target = resolve_share_path(root, path)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    if not target.exists() or not target.is_dir():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Directory not found")
    try:
        return search_entries(root, target, q, recursive=recursive, max_results=max_results)
    except PermissionError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Permission denied") from exc


@router.get("/{share_id}/stream")
def stream_share_file(
    share_id: str,
    path: str = Query(default=""),
    ticket: str = Query(min_length=1),
    db: Session = Depends(get_db),
) -> FileResponse:
    verify_read_ticket(ticket, share_id, "read")
    share = _get_share(db, share_id)
    root = _share_root(share)
    try:
        target = resolve_share_path(root, path)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    file_type = get_file_type(target.name)
    media_type = guess_mimetype(target, file_type)
    return FileResponse(path=target, media_type=media_type)


@router.get("/{share_id}/download")
def download_share_file(
    share_id: str,
    path: str = Query(default=""),
    ticket: str = Query(min_length=1),
    db: Session = Depends(get_db),
) -> FileResponse:
    verify_read_ticket(ticket, share_id, "download")
    share = _get_share(db, share_id)
    root = _share_root(share)
    try:
        target = resolve_share_path(root, path)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    file_type = get_file_type(target.name)
    media_type = guess_mimetype(target, file_type)
    return FileResponse(
        path=target,
        media_type=media_type,
        filename=target.name,
        content_disposition_type="attachment",
    )
