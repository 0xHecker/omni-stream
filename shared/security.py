from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from typing import Any


class TokenError(ValueError):
    pass


def _b64encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64decode(text: str) -> bytes:
    padding = "=" * ((4 - (len(text) % 4)) % 4)
    return base64.urlsafe_b64decode((text + padding).encode("ascii"))


def issue_token(secret: str, payload: dict[str, Any], *, expires_in: int = 900) -> str:
    token_payload = dict(payload)
    token_payload["exp"] = int(time.time()) + max(1, int(expires_in))
    body = json.dumps(token_payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    signature = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).digest()
    return f"{_b64encode(body)}.{_b64encode(signature)}"


def decode_token(secret: str, token: str) -> dict[str, Any]:
    try:
        body_part, signature_part = token.split(".", 1)
        body = _b64decode(body_part)
        signature = _b64decode(signature_part)
    except Exception as exc:  # noqa: BLE001
        raise TokenError("Malformed token") from exc

    expected_signature = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).digest()
    if not hmac.compare_digest(signature, expected_signature):
        raise TokenError("Invalid token signature")

    try:
        payload = json.loads(body.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise TokenError("Invalid token body") from exc

    if not isinstance(payload, dict):
        raise TokenError("Invalid token payload")

    exp = payload.get("exp")
    if not isinstance(exp, int):
        raise TokenError("Invalid token expiry")
    if exp < int(time.time()):
        raise TokenError("Token expired")
    return payload

