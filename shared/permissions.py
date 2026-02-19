from __future__ import annotations

from typing import Iterable

PERMISSIONS = {
    "read",
    "download",
    "request_send",
    "accept_incoming",
    "manage_share",
}

OWNER_PERMISSIONS = {"read", "download", "request_send", "accept_incoming", "manage_share"}
DEFAULT_EXTERNAL_PERMISSIONS = {"read", "download", "request_send"}


def normalize_permissions(values: Iterable[str]) -> set[str]:
    normalized = {value.strip() for value in values if value and value.strip()}
    return {value for value in normalized if value in PERMISSIONS}


def encode_permissions(values: Iterable[str]) -> str:
    normalized = normalize_permissions(values)
    return ",".join(sorted(normalized))


def decode_permissions(raw: str | None) -> set[str]:
    if not raw:
        return set()
    return normalize_permissions(raw.split(","))

