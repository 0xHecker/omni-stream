from __future__ import annotations

import io
import ipaddress
import os
from pathlib import Path

from flask import (
    Blueprint,
    Response,
    abort,
    current_app,
    jsonify,
    redirect,
    render_template,
    request,
    send_file,
    session,
    stream_with_context,
    url_for,
)
from werkzeug.exceptions import HTTPException

from shared.networking import discover_coordinators, local_ipv4_addresses, preferred_lan_ipv4
from shared.runtime import env_int

from .auth import require_pin
from .settings_store import load_settings, save_settings, settings_path
from .services import (
    generate_cached_thumbnail_bytes,
    generate_thumbnail_bytes,
    resolve_requested_path,
)
from stream_server.services.file_service import (
    get_adjacent_file,
    get_file_type,
    guess_mimetype,
    iter_transcoded_video_chunks,
    list_directory,
    search_entries,
    get_video_info,
    to_client_path,
)

web = Blueprint("web", __name__)
API_PREFIXES = (
    "/list",
    "/search",
    "/stream",
    "/stream_transcode",
    "/thumbnail",
    "/get_adjacent_file",
    "/download",
    "/video_info",
    "/api/discovery",
)


def _is_setup_complete() -> bool:
    pin = str(current_app.config.get("PIN", "")).strip()
    return pin.isdigit() and len(pin) >= 4


def _root_dir() -> Path:
    return Path(current_app.config["ROOT_DIR"]).resolve()


def _is_lan_bind_host(host_value: str) -> bool:
    host = str(host_value or "").strip().lower()
    if not host:
        return True
    if host in {"0.0.0.0", "::"}:
        return True
    if host in {"localhost", "127.0.0.1", "::1"}:
        return False
    return not host.startswith("127.")


def _network_bootstrap_context() -> dict[str, object]:
    settings = load_settings()
    web_port = env_int("WEB_PORT", int(current_app.config.get("PORT", 5000)), minimum=1, maximum=65535)
    coordinator_port = env_int("COORDINATOR_PORT", 7000, minimum=1, maximum=65535)
    agent_port = env_int("AGENT_PORT", 7001, minimum=1, maximum=65535)
    web_bind_host = os.environ.get("WEB_HOST", os.environ.get("HOST", "0.0.0.0")).strip() or "0.0.0.0"
    coordinator_bind_host = os.environ.get("COORDINATOR_HOST", "0.0.0.0").strip() or "0.0.0.0"

    lan_ip = preferred_lan_ipv4()
    addresses = local_ipv4_addresses(include_loopback=False)
    if lan_ip not in addresses and lan_ip != "127.0.0.1":
        addresses = [lan_ip, *addresses]
    if not addresses:
        addresses = ["127.0.0.1"]

    web_urls = [f"http://{ip}:{web_port}/" for ip in addresses]
    coordinator_urls = [f"http://{ip}:{coordinator_port}" for ip in addresses]
    agent_urls = [f"http://{ip}:{agent_port}" for ip in addresses]

    default_coordinator_url = str(os.environ.get("STREAM_DEFAULT_COORDINATOR_URL", "")).strip().rstrip("/")
    if not default_coordinator_url:
        default_coordinator_url = coordinator_urls[0]

    local_agent_device_id = str(os.environ.get("AGENT_DEVICE_ID", "")).strip()
    if not local_agent_device_id:
        local_agent_device_id = str(settings.get("agent_device_id") or "").strip()

    return {
        "primary_ip": addresses[0],
        "primary_web_url": web_urls[0],
        "default_coordinator_url": default_coordinator_url,
        "web_urls": web_urls,
        "coordinator_urls": coordinator_urls,
        "agent_urls": agent_urls,
        "local_agent_device_id": local_agent_device_id,
        "web_bind_host": web_bind_host,
        "coordinator_bind_host": coordinator_bind_host,
        "web_lan_accessible": _is_lan_bind_host(web_bind_host),
        "coordinator_lan_accessible": _is_lan_bind_host(coordinator_bind_host),
    }


def _is_local_request_address(remote_addr: str | None) -> bool:
    raw = str(remote_addr or "").strip().split(",", 1)[0].strip()
    if not raw:
        return False
    try:
        parsed = ipaddress.ip_address(raw)
    except ValueError:
        return False

    if parsed.version == 6 and getattr(parsed, "ipv4_mapped", None):
        parsed = parsed.ipv4_mapped

    if parsed.is_loopback:
        return True

    local_addrs = {addr.strip() for addr in local_ipv4_addresses(include_loopback=True)}
    return str(parsed) in local_addrs


def _network_session_defaults(*, include_identity: bool) -> dict[str, str]:
    settings = load_settings()
    default_coord = str(os.environ.get("STREAM_DEFAULT_COORDINATOR_URL", "")).strip().rstrip("/")
    if not default_coord:
        default_coord = str(settings.get("network_coordinator_url") or "").strip().rstrip("/")

    principal_id = ""
    client_device_id = ""
    device_secret = ""
    local_agent_device_id = ""
    if include_identity:
        principal_id = str(os.environ.get("STREAM_COORD_PRINCIPAL_ID", "")).strip()
        if not principal_id:
            principal_id = str(settings.get("network_principal_id") or "").strip()

        client_device_id = str(os.environ.get("STREAM_COORD_CLIENT_DEVICE_ID", "")).strip()
        if not client_device_id:
            client_device_id = str(settings.get("network_client_device_id") or "").strip()

        device_secret = str(os.environ.get("STREAM_COORD_DEVICE_SECRET", "")).strip()
        if not device_secret:
            device_secret = str(settings.get("network_device_secret") or "").strip()

        local_agent_device_id = str(os.environ.get("AGENT_DEVICE_ID", "")).strip()
        if not local_agent_device_id:
            local_agent_device_id = str(settings.get("agent_device_id") or "").strip()

    return {
        "coordinator_url": default_coord,
        "principal_id": principal_id,
        "client_device_id": client_device_id,
        "device_secret": device_secret,
        "local_agent_device_id": local_agent_device_id,
    }


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


@web.route("/setup", methods=["GET", "POST"])
def setup():
    setup_complete = _is_setup_complete()
    require_current_pin = setup_complete and not session.get("authenticated")

    error: str | None = None
    message: str | None = None
    existing = load_settings()
    root_value = str(existing.get("root_dir") or current_app.config.get("ROOT_DIR") or Path.home())
    auto_open_browser = bool(existing.get("auto_open_browser", current_app.config.get("AUTO_OPEN_BROWSER", True)))

    if request.method == "POST":
        root_input = (request.form.get("root_dir") or "").strip()
        pin = (request.form.get("pin") or "").strip()
        pin_confirm = (request.form.get("pin_confirm") or "").strip()
        current_pin = (request.form.get("current_pin") or "").strip()
        auto_open_browser = request.form.get("auto_open_browser") == "on"

        try:
            resolved_root = Path(root_input).expanduser().resolve()
        except OSError:
            resolved_root = None

        if require_current_pin and current_pin != str(current_app.config.get("PIN", "")):
            error = "Enter your current PIN to update settings."
        elif not resolved_root or not resolved_root.exists() or not resolved_root.is_dir():
            error = "Choose a valid folder path that exists on this device."
        elif not pin.isdigit() or len(pin) < 4 or len(pin) > 12:
            error = "PIN must be 4 to 12 digits."
        elif pin != pin_confirm:
            error = "PIN confirmation does not match."
        else:
            updated = dict(existing)
            updated["root_dir"] = str(resolved_root)
            updated["pin"] = pin
            updated["auto_open_browser"] = auto_open_browser
            updated.setdefault("secret_key", str(current_app.config.get("SECRET_KEY") or ""))
            updated.setdefault("port", int(current_app.config.get("PORT", 5000)))
            save_settings(updated)
            current_app.config["ROOT_DIR"] = resolved_root
            current_app.config["PIN"] = pin
            current_app.config["AUTO_OPEN_BROWSER"] = auto_open_browser
            current_app.config["SETUP_COMPLETE"] = True
            session.clear()
            message = "Setup saved."
            return redirect(url_for("web.login", setup="done"))

        root_value = root_input

    return render_template(
        "setup.html",
        error=error,
        message=message,
        root_dir_value=root_value,
        auto_open_browser=auto_open_browser,
        settings_file=str(settings_path()),
        setup_complete=setup_complete,
        require_current_pin=require_current_pin,
    )


@web.get("/api/choose_folder")
@require_pin
def choose_folder():
    try:
        import tkinter as tk
        from tkinter import filedialog
        
        root = tk.Tk()
        root.withdraw()
        root.attributes('-topmost', True)
        folder_path = filedialog.askdirectory(parent=root, title="Select Shared Folder")
        root.destroy()
        
        return jsonify({"path": folder_path})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@web.get("/")
@require_pin
def index():
    session_defaults = _network_session_defaults(include_identity=_is_local_request_address(request.remote_addr))
    return render_template(
        "index.html",
        root_dir=str(_root_dir()),
        network_info=_network_bootstrap_context(),
        network_session_defaults=session_defaults,
    )


@web.get("/api/discovery/coordinators")
@require_pin
def discover_coordinator_hosts():
    port = env_int("COORDINATOR_PORT", 7000, minimum=1, maximum=65535)
    discovered = discover_coordinators(port=port, timeout_seconds=0.16, max_workers=48, max_results=12)
    bootstrap = _network_bootstrap_context()
    coordinator_urls = [str(value).strip().rstrip("/") for value in bootstrap.get("coordinator_urls", []) if str(value).strip()]
    default_url = str(os.environ.get("STREAM_DEFAULT_COORDINATOR_URL", "")).strip().rstrip("/")
    all_candidates: list[str] = []
    for candidate in [default_url, *coordinator_urls, *discovered]:
        normalized = candidate.strip().rstrip("/")
        if not normalized or normalized in all_candidates:
            continue
        all_candidates.append(normalized)
    return jsonify({"coordinators": all_candidates, "default": default_url})


@web.get("/list")
@require_pin
def list_files():
    target = _resolve_or_400(request.args.get("path"))
    if not target.exists():
        abort(404, description="Directory not found")
    if not target.is_dir():
        abort(400, description="Path must point to a directory")
    try:
        max_results = int((request.args.get("max") or "400").strip())
        page = int((request.args.get("page") or "1").strip())
    except ValueError:
        abort(400, description="max and page must be integers")

    try:
        payload = list_directory(_root_dir(), target, max_entries=max_results, page=page)
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


@web.get("/stream_transcode")
@require_pin
def stream_transcoded_video():
    target = _resolve_or_400(request.args.get("path"))
    if not target.exists() or not target.is_file():
        abort(404, description="File not found")

    if get_file_type(target.name) != "video":
        abort(400, description="Transcode endpoint supports video files only")

    try:
        start_time = float(request.args.get("start", "0"))
        stream_iter = iter_transcoded_video_chunks(target, start_time=start_time)
    except FileNotFoundError:
        abort(503, description="Video transcoding is unavailable (ffmpeg not installed)")
    except OSError:
        abort(422, description="Unable to transcode this video file")

    headers = {
        "Cache-Control": "no-store",
        "Accept-Ranges": "none",
    }
    return Response(stream_with_context(stream_iter), mimetype="video/mp4", headers=headers)


@web.get("/video_info")
@require_pin
def video_info():
    target = _resolve_or_400(request.args.get("path"))
    if not target.exists() or not target.is_file():
        abort(404, description="File not found")

    if get_file_type(target.name) != "video":
        abort(400, description="Endpoint supports video files only")

    return jsonify(get_video_info(target))

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

    try:
        stat = sibling.stat()
        size = stat.st_size
        mtime = stat.st_mtime
        ctime = stat.st_ctime
    except OSError:
        size = 0
        mtime = 0
        ctime = 0

    return jsonify({
        "name": sibling.name,
        "is_dir": False,
        "path": to_client_path(sibling, _root_dir()),
        "parent_path": to_client_path(sibling.parent, _root_dir()),
        "type": get_file_type(sibling.name),
        "size": size,
        "modified_at": mtime,
        "created_at": ctime,
    })


@web.get("/thumbnail")
@require_pin
def thumbnail():
    target = _resolve_or_400(request.args.get("path"))
    if not target.exists():
        abort(404)

    size = current_app.config.get("THUMBNAIL_SIZE", (220, 220))
    if target.is_dir():
        try:
            thumbnail_bytes = generate_cached_thumbnail_bytes(target, "directory", size)
        except (FileNotFoundError, PermissionError, OSError):
            abort(404)
        return send_file(io.BytesIO(thumbnail_bytes), mimetype="image/jpeg", max_age=900)

    if not target.is_file():
        abort(404)

    file_type = get_file_type(target.name)
    if file_type == "svg":
        return send_file(target, mimetype="image/svg+xml", conditional=True, etag=True, max_age=900)

    try:
        if file_type == "image":
            thumbnail_bytes = generate_thumbnail_bytes(target, size)
        else:
            thumbnail_bytes = generate_cached_thumbnail_bytes(target, file_type, size)
    except (FileNotFoundError, PermissionError, OSError):
        abort(404)

    return send_file(io.BytesIO(thumbnail_bytes), mimetype="image/jpeg", max_age=900)


@web.route("/login", methods=["GET", "POST"])
def login():
    if not _is_setup_complete():
        return redirect(url_for("web.setup"))

    if session.get("authenticated"):
        return redirect(url_for("web.index"))

    setup_done = request.args.get("setup") == "done"
    if request.method == "POST":
        submitted_pin = request.form.get("pin", "")
        if submitted_pin == current_app.config["PIN"]:
            session["authenticated"] = True
            next_path = request.args.get("next")
            if next_path and next_path.startswith("/"):
                return redirect(next_path)
            return redirect(url_for("web.index"))
        return render_template("login.html", error="Invalid PIN", setup_done=setup_done), 401

    return render_template("login.html", error=None, setup_done=setup_done)


@web.get("/logout")
def logout():
    session.clear()
    return redirect(url_for("web.login"))
