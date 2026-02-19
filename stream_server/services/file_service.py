from __future__ import annotations

import io
import heapq
import mimetypes
import os
from functools import lru_cache
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any

from PIL import Image, ImageOps

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
    ".pyi",
    ".ipynb",
    ".js",
    ".mjs",
    ".cjs",
    ".ts",
    ".tsx",
    ".jsx",
    ".java",
    ".kt",
    ".kts",
    ".swift",
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
    ".r",
    ".scala",
    ".sql",
    ".sh",
    ".bash",
    ".zsh",
    ".fish",
    ".ps1",
    ".bat",
    ".cmd",
    ".yaml",
    ".yml",
    ".json",
    ".jsonc",
    ".json5",
    ".toml",
    ".ini",
    ".cfg",
    ".conf",
    ".xml",
    ".gradle",
    ".lock",
    ".dockerfile",
    ".makefile",
    ".mk",
    ".tex",
    ".proto",
    ".graphql",
    ".gql",
    ".env",
    ".gitignore",
    ".editorconfig",
    ".css",
    ".scss",
    ".sass",
    ".less",
    ".vue",
    ".svelte",
}
TEXT_EXTENSIONS = {
    ".txt",
    ".log",
    ".text",
    ".rst",
    ".asc",
    ".readme",
    ".license",
}
LIST_DEFAULT_MAX_ENTRIES = 400
LIST_MAX_ENTRIES_CAP = 6000


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


def _relative_parts(raw_path: str) -> list[str]:
    normalized = PurePosixPath(raw_path.replace("\\", "/"))
    parts: list[str] = []
    for part in normalized.parts:
        if part in ("", "."):
            continue
        if part == "..":
            raise ValueError("Parent directory traversal is not allowed")
        parts.append(part)

    return parts


def resolve_requested_path(root_dir: Path, raw_path: str | None) -> Path:
    root = root_dir.resolve()
    if not raw_path:
        return root

    user_input = raw_path.strip()
    if not user_input:
        return root

    windows_style = PureWindowsPath(user_input)
    platform_path = Path(user_input).expanduser()

    if windows_style.drive or windows_style.root or platform_path.is_absolute():
        if not platform_path.is_absolute():
            raise ValueError("Absolute path is not valid on this platform")
        resolved = platform_path.resolve()
    else:
        resolved = (root / Path(*_relative_parts(user_input))).resolve()

    if resolved != root and root not in resolved.parents:
        raise ValueError("Path is outside configured root directory")

    return resolved


def to_client_path(path: Path, root_dir: Path) -> str:
    resolved_path = path.resolve()
    resolved_root = root_dir.resolve()
    relative_path = resolved_path.relative_to(resolved_root)
    if str(relative_path) == ".":
        return ""
    return relative_path.as_posix()


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
                # Skip symlinks or mount points that resolve outside the configured root.
                continue
            sort_key = (0 if is_directory else 1, entry.name.casefold(), entry.name)
            yield sort_key, item


def _compute_directory_listing(root_dir: Path, directory: Path, limit: int) -> tuple[str, str | None, bool, tuple[dict[str, Any], ...]]:
    ranked_items = heapq.nsmallest(limit + 1, _iter_ranked_entries(root_dir, directory), key=lambda row: row[0])
    truncated = len(ranked_items) > limit
    if truncated:
        ranked_items = ranked_items[:limit]

    current_path = to_client_path(directory, root_dir)
    parent_path = None if directory == root_dir else to_client_path(directory.parent, root_dir)
    items = tuple(item for _, item in ranked_items)
    return current_path, parent_path, truncated, items


@lru_cache(maxsize=64)
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
    max_results: int = 200,
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
            # Keep search resilient when some directories are inaccessible.
            return

        for dirpath, dirnames, filenames in os.walk(
            start_directory,
            topdown=True,
            followlinks=False,
            onerror=_on_walk_error,
        ):
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


def get_adjacent_file(root_dir: Path, current_file: Path, direction: str) -> Path:
    siblings: list[Path] = []
    with os.scandir(current_file.parent) as entries:
        for entry in entries:
            if not entry.is_file(follow_symlinks=False):
                continue
            entry_path = Path(entry.path)
            try:
                to_client_path(entry_path, root_dir)
            except ValueError:
                continue
            siblings.append(entry_path)

    if not siblings:
        raise FileNotFoundError("No files found in this directory")

    siblings.sort(key=lambda item: item.name.casefold())
    current_name = current_file.name.casefold()
    current_index = next(
        (index for index, file_path in enumerate(siblings) if file_path.name.casefold() == current_name),
        -1,
    )
    if current_index == -1:
        raise FileNotFoundError("Current file is not available in directory listing")

    if direction == "next":
        return siblings[(current_index + 1) % len(siblings)]
    if direction == "prev":
        return siblings[(current_index - 1) % len(siblings)]

    raise ValueError("Direction must be 'next' or 'prev'")


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


@lru_cache(maxsize=256)
def _thumbnail_cache(path_key: str, mtime_ns: int, width: int, height: int) -> bytes:
    del mtime_ns
    with Image.open(path_key) as image:
        image = ImageOps.exif_transpose(image)
        image.thumbnail((width, height))
        if image.mode not in ("RGB", "L"):
            image = image.convert("RGB")
        output = io.BytesIO()
        image.save(output, format="JPEG", quality=82, optimize=True)
        return output.getvalue()


def generate_thumbnail_bytes(image_path: Path, size: tuple[int, int]) -> bytes:
    image_stats = image_path.stat()
    return _thumbnail_cache(
        str(image_path),
        image_stats.st_mtime_ns,
        int(size[0]),
        int(size[1]),
    )
