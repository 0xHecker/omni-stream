from __future__ import annotations

from pathlib import Path, PurePosixPath, PureWindowsPath


def relative_parts(raw_path: str) -> list[str]:
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
        resolved = (root / Path(*relative_parts(user_input))).resolve()

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

