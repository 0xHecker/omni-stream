from __future__ import annotations

import io
from pathlib import Path

from flask import (
    Blueprint,
    abort,
    current_app,
    jsonify,
    redirect,
    render_template,
    request,
    send_file,
    session,
    url_for,
)
from werkzeug.exceptions import HTTPException

from .auth import require_pin
from .services import (
    generate_thumbnail_bytes,
    get_adjacent_file,
    get_file_type,
    guess_mimetype,
    list_directory,
    resolve_requested_path,
    search_entries,
    to_client_path,
)

web = Blueprint("web", __name__)
API_PREFIXES = ("/list", "/search", "/stream", "/thumbnail", "/get_adjacent_file", "/download")


def _root_dir() -> Path:
    return Path(current_app.config["ROOT_DIR"]).resolve()


def _resolve_or_400(raw_path: str | None) -> Path:
    try:
        return resolve_requested_path(_root_dir(), raw_path)
    except ValueError as exc:
        abort(400, description=str(exc))


@web.app_errorhandler(HTTPException)
def handle_http_error(error: HTTPException):
    if request.path.startswith(API_PREFIXES):
        return jsonify({"error": error.description}), error.code
    return error


@web.get("/")
@require_pin
def index():
    return render_template("index.html", root_dir=str(_root_dir()))


@web.get("/list")
@require_pin
def list_files():
    target = _resolve_or_400(request.args.get("path"))
    if not target.exists():
        abort(404, description="Directory not found")
    if not target.is_dir():
        abort(400, description="Path must point to a directory")

    try:
        payload = list_directory(_root_dir(), target)
    except PermissionError:
        abort(403, description="Permission denied")
    return jsonify(payload)


@web.get("/search")
@require_pin
def search_files():
    query = (request.args.get("q") or "").strip()
    target = _resolve_or_400(request.args.get("path"))
    if not target.exists():
        abort(404, description="Directory not found")
    if not target.is_dir():
        abort(400, description="Path must point to a directory")

    recursive = (request.args.get("recursive") or "1").strip().lower() in {"1", "true", "yes", "on"}
    if not query:
        return jsonify(
            {
                "query": "",
                "base_path": to_client_path(target, _root_dir()),
                "recursive": recursive,
                "items": [],
                "truncated": False,
            }
        )

    try:
        max_results = int((request.args.get("max") or "200").strip())
    except ValueError:
        abort(400, description="max must be an integer")

    try:
        payload = search_entries(
            _root_dir(),
            target,
            query,
            recursive=recursive,
            max_results=max_results,
        )
    except PermissionError:
        abort(403, description="Permission denied")
    return jsonify(payload)


@web.get("/stream")
@require_pin
def stream_file():
    target = _resolve_or_400(request.args.get("path"))
    if not target.exists() or not target.is_file():
        abort(404, description="File not found")

    file_type = get_file_type(target.name)
    mimetype = guess_mimetype(target, file_type)
    return send_file(target, mimetype=mimetype, conditional=True, etag=True)


@web.get("/download")
@require_pin
def download_file():
    target = _resolve_or_400(request.args.get("path"))
    if not target.exists() or not target.is_file():
        abort(404, description="File not found")
    return send_file(
        target,
        as_attachment=True,
        download_name=target.name,
        conditional=True,
        etag=True,
    )


@web.get("/get_adjacent_file")
@require_pin
def adjacent_file():
    direction = (request.args.get("direction") or "next").lower()
    if direction not in {"next", "prev"}:
        abort(400, description="Direction must be 'next' or 'prev'")

    current_file = _resolve_or_400(request.args.get("path"))
    if not current_file.exists() or not current_file.is_file():
        abort(404, description="Current file not found")

    try:
        sibling = get_adjacent_file(_root_dir(), current_file, direction)
    except FileNotFoundError as exc:
        abort(404, description=str(exc))
    except PermissionError:
        abort(403, description="Permission denied")

    return jsonify({"path": to_client_path(sibling, _root_dir()), "type": get_file_type(sibling.name)})


@web.get("/thumbnail")
@require_pin
def thumbnail():
    fallback_thumbnail = Path(current_app.static_folder or "static") / "img" / "default-thumbnail.svg"
    target = _resolve_or_400(request.args.get("path"))
    if not target.exists() or not target.is_file():
        return send_file(fallback_thumbnail, mimetype="image/svg+xml")

    if get_file_type(target.name) != "image":
        return send_file(fallback_thumbnail, mimetype="image/svg+xml")

    try:
        size = current_app.config.get("THUMBNAIL_SIZE", (220, 220))
        thumbnail_bytes = generate_thumbnail_bytes(target, size)
    except (FileNotFoundError, PermissionError, OSError):
        return send_file(fallback_thumbnail, mimetype="image/svg+xml")

    return send_file(io.BytesIO(thumbnail_bytes), mimetype="image/jpeg", max_age=900)


@web.route("/login", methods=["GET", "POST"])
def login():
    if session.get("authenticated"):
        return redirect(url_for("web.index"))

    if request.method == "POST":
        submitted_pin = request.form.get("pin", "")
        if submitted_pin == current_app.config["PIN"]:
            session["authenticated"] = True
            next_path = request.args.get("next")
            if next_path and next_path.startswith("/"):
                return redirect(next_path)
            return redirect(url_for("web.index"))
        return render_template("login.html", error="Invalid PIN"), 401

    return render_template("login.html", error=None)


@web.get("/logout")
def logout():
    session.clear()
    return redirect(url_for("web.login"))
