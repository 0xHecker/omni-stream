from __future__ import annotations

from functools import wraps
from typing import Any, Callable, TypeVar, cast

from flask import jsonify, redirect, request, session, url_for

F = TypeVar("F", bound=Callable[..., Any])
API_PREFIXES = ("/list", "/search", "/stream", "/thumbnail", "/get_adjacent_file", "/download")


def require_pin(view: F) -> F:
    @wraps(view)
    def wrapped(*args: Any, **kwargs: Any):
        if session.get("authenticated"):
            return view(*args, **kwargs)

        if request.path.startswith(API_PREFIXES):
            return jsonify({"error": "Authentication required"}), 401

        return redirect(url_for("web.login", next=request.path))

    return cast(F, wrapped)
