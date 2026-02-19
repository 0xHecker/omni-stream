from __future__ import annotations

from functools import wraps
from typing import Any, Callable, TypeVar, cast

from flask import current_app, jsonify, redirect, request, session, url_for

F = TypeVar("F", bound=Callable[..., Any])
API_PREFIXES = ("/list", "/search", "/stream", "/stream_transcode", "/thumbnail", "/get_adjacent_file", "/download")


def _is_setup_complete() -> bool:
    pin = str(current_app.config.get("PIN", "")).strip()
    return pin.isdigit() and len(pin) >= 4


def require_pin(view: F) -> F:
    @wraps(view)
    def wrapped(*args: Any, **kwargs: Any):
        if not _is_setup_complete():
            if request.path.startswith(API_PREFIXES):
                return jsonify({"error": "Setup required"}), 503
            return redirect(url_for("web.setup"))

        if session.get("authenticated"):
            return view(*args, **kwargs)

        if request.path.startswith(API_PREFIXES):
            return jsonify({"error": "Authentication required"}), 401

        return redirect(url_for("web.login", next=request.path))

    return cast(F, wrapped)
