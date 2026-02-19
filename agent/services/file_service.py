from __future__ import annotations

import mimetypes
import os
from functools import lru_cache
import heapq
from pathlib import Path
from typing import Any

from shared.path_utils import resolve_requested_path, to_client_path

VIDEO_EXTENSIONS = {".mp4", ".avi", ".mov", ".mkv", ".webm", ".flv", ".m4v"}
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tiff", ".avif", ".heic", ".heif"}
SVG_EXTENSIONS = {".svg"}
PDF_EXTENSIONS = {".pdf"}
WORD_EXTENSIONS = {".docx", ".doc", ".docm", ".dotx", ".dotm", ".odt", ".rtf"}
EXCEL_EXTENSIONS = {".xlsx", ".xls", ".xlsm", ".xlsb", ".ods", ".csv", ".tsv"}
MARKDOWN_EXTENSIONS = {".md", ".markdown", ".mdown", ".mkd", ".mkdn", ".mdx"}
HTML_EXTENSIONS = {".html", ".htm"}
CODE_EXTENSIONS = {
    ".py",
    ".js",
    ".mjs",
    ".cjs",
    ".ts",
    ".tsx",
    ".jsx",
    ".java",
    ".go",
    ".rs",
    ".rb",
    ".php",
    ".cs",
    ".cpp",
    ".cxx",
    ".cc",
    ".c",
    ".h",
    ".hpp",
    ".lua",
    ".sql",
    ".sh",
    ".bash",
    ".zsh",
    ".ps1",
    ".bat",
    ".cmd",
    ".yaml",
    ".yml",
    ".json",
    ".toml",
    ".ini",
    ".cfg",
    ".conf",
    ".xml",
    ".css",
    ".scss",
    ".sass",
    ".less",
    ".vue",
    ".svelte",
}
TEXT_EXTENSIONS = {".txt", ".log", ".text", ".rst", ".asc", ".readme", ".license"}
LIST_DEFAULT_MAX_ENTRIES = 300
LIST_MAX_ENTRIES_CAP = 5000


def get_file_type(filename: str | Path) -> str:
    extension = Path(str(filename)).suffix.lower()
    base_name = Path(str(filename)).name.lower()
    if extension in VIDEO_EXTENSIONS:
        return "video"
    if extension in SVG_EXTENSIONS:
        return "svg"
    if extension in IMAGE_EXTENSIONS:
        return "image"
    if extension in PDF_EXTENSIONS:
        return "pdf"
    if extension in WORD_EXTENSIONS:
        return "word"
    if extension in EXCEL_EXTENSIONS:
        return "excel"
    if extension in MARKDOWN_EXTENSIONS:
        return "markdown"
    if extension in HTML_EXTENSIONS:
        return "html"
    if extension in CODE_EXTENSIONS or base_name in {"dockerfile", "makefile", ".env", ".gitignore"}:
        return "code"
    if extension in TEXT_EXTENSIONS:
        return "text"
    return "other"


def guess_mimetype(path: Path, file_type: str | None = None) -> str:
    resolved_type = file_type or get_file_type(path.name)
    if resolved_type in {"code", "text", "markdown"}:
        return "text/plain; charset=utf-8"
    if resolved_type == "html":
        return "text/html; charset=utf-8"
    if resolved_type == "svg":
        return "image/svg+xml"

    guessed, _ = mimetypes.guess_type(path.name)
    if guessed:
        return guessed
    return "application/octet-stream"


def resolve_share_path(share_root: Path, raw_path: str | None) -> Path:
    return resolve_requested_path(share_root, raw_path)


def _entry_to_item(root_dir: Path, entry_path: Path, is_directory: bool) -> dict[str, Any]:
    return {
        "name": entry_path.name,
        "is_dir": is_directory,
        "path": to_client_path(entry_path, root_dir),
        "parent_path": to_client_path(entry_path.parent, root_dir),
        "type": "directory" if is_directory else get_file_type(entry_path.name),
    }


def _normalize_list_limit(max_entries: int) -> int:
    return max(1, min(int(max_entries), LIST_MAX_ENTRIES_CAP))


def _iter_ranked_entries(root_dir: Path, directory: Path):
    with os.scandir(directory) as entries:
        for entry in entries:
            try:
                is_directory = entry.is_dir(follow_symlinks=False)
            except OSError:
                continue
            entry_path = Path(entry.path)
            try:
                item = _entry_to_item(root_dir, entry_path, is_directory)
            except ValueError:
                continue
            sort_key = (0 if is_directory else 1, entry.name.casefold(), entry.name)
            yield sort_key, item


def _compute_directory_listing(root_dir: Path, directory: Path, limit: int) -> tuple[str, str | None, bool, tuple[dict[str, Any], ...]]:
    ranked_items = heapq.nsmallest(limit + 1, _iter_ranked_entries(root_dir, directory), key=lambda row: row[0])
    truncated = len(ranked_items) > limit
    if truncated:
        ranked_items = ranked_items[:limit]
    items = tuple(item for _, item in ranked_items)
    current_path = to_client_path(directory, root_dir)
    parent_path = None if directory == root_dir else to_client_path(directory.parent, root_dir)
    return current_path, parent_path, truncated, items


@lru_cache(maxsize=48)
def _cached_directory_listing(
    root_dir_str: str,
    directory_str: str,
    directory_mtime_ns: int,
    limit: int,
) -> tuple[str, str | None, bool, tuple[dict[str, Any], ...]]:
    del directory_mtime_ns
    root_dir = Path(root_dir_str)
    directory = Path(directory_str)
    return _compute_directory_listing(root_dir, directory, limit)


def list_directory(root_dir: Path, directory: Path, *, max_entries: int = LIST_DEFAULT_MAX_ENTRIES) -> dict[str, Any]:
    limit = _normalize_list_limit(max_entries)
    root_resolved = root_dir.resolve()
    directory_resolved = directory.resolve()
    directory_mtime_ns = directory_resolved.stat().st_mtime_ns

    current_path, parent_path, truncated, cached_items = _cached_directory_listing(
        str(root_resolved),
        str(directory_resolved),
        directory_mtime_ns,
        limit,
    )
    items = [dict(item) for item in cached_items]
    return {
        "current_path": current_path,
        "parent_path": parent_path,
        "items": items,
        "truncated": truncated,
        "limit": limit,
    }


def search_entries(
    root_dir: Path,
    start_directory: Path,
    query: str,
    *,
    recursive: bool = True,
    max_results: int = 300,
) -> dict[str, Any]:
    normalized_query = query.strip().casefold()
    if not normalized_query:
        return {
            "query": query,
            "base_path": to_client_path(start_directory, root_dir),
            "recursive": recursive,
            "items": [],
            "truncated": False,
        }

    capped_limit = max(1, min(max_results, 1000))
    items: list[dict[str, Any]] = []
    truncated = False

    def match_and_add(path_obj: Path, is_directory: bool) -> bool:
        nonlocal truncated
        try:
            client_path = to_client_path(path_obj, root_dir)
        except ValueError:
            return False
        haystacks = (path_obj.name.casefold(), client_path.casefold())
        if not any(normalized_query in hay for hay in haystacks):
            return False
        items.append(_entry_to_item(root_dir, path_obj, is_directory))
        if len(items) >= capped_limit:
            truncated = True
            return True
        return False

    if recursive:
        def _on_walk_error(_: OSError) -> None:
            return

        for dirpath, dirnames, filenames in os.walk(start_directory, topdown=True, followlinks=False, onerror=_on_walk_error):
            dirnames.sort(key=str.casefold)
            filenames.sort(key=str.casefold)
            current_dir = Path(dirpath)
            for directory_name in dirnames:
                if match_and_add(current_dir / directory_name, True):
                    break
            if truncated:
                break
            for filename in filenames:
                if match_and_add(current_dir / filename, False):
                    break
            if truncated:
                break
    else:
        with os.scandir(start_directory) as entries:
            for entry in entries:
                try:
                    path_obj = Path(entry.path)
                    is_directory = entry.is_dir(follow_symlinks=False)
                except OSError:
                    continue
                if match_and_add(path_obj, is_directory):
                    break

    items.sort(key=lambda item: (not item["is_dir"], item["path"].casefold()))
    return {
        "query": query,
        "base_path": to_client_path(start_directory, root_dir),
        "recursive": recursive,
        "items": items,
        "truncated": truncated,
    }
