from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
import platform
import multiprocessing as mp
import secrets
import socket
import sys
import threading
import time
import tempfile
import traceback
from urllib import error as urllib_error
from urllib import parse as urllib_parse
from urllib import request as urllib_request
import webbrowser
from pathlib import Path
from uuid import uuid4

from shared.networking import discover_coordinators, local_ipv4_addresses, preferred_lan_ipv4
from shared.runtime import env_int, uvicorn_runtime_settings


APP_DIR_NAME = "StreamLocalFiles"


def _first_writable_dir(candidates: list[Path]) -> Path:
    for candidate in candidates:
        try:
            path = candidate.expanduser()
            path.mkdir(parents=True, exist_ok=True)
            probe = path / ".write_probe"
            probe.write_text("ok", encoding="utf-8")
            probe.unlink(missing_ok=True)
            return path
        except OSError:
            continue
    fallback = Path.cwd() / APP_DIR_NAME
    try:
        fallback.mkdir(parents=True, exist_ok=True)
        probe = fallback / ".write_probe"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink(missing_ok=True)
        return fallback
    except OSError:
        return fallback


def _settings_dir() -> Path:
    override = os.environ.get("STREAM_SETTINGS_DIR", "").strip()
    if override:
        return _first_writable_dir(
            [
                Path(override),
                Path.home() / ".config" / APP_DIR_NAME,
                Path(tempfile.gettempdir()) / APP_DIR_NAME,
            ]
        )

    system = platform.system()
    if system == "Windows":
        appdata = os.environ.get("APPDATA")
        candidates = []
        if appdata:
            candidates.append(Path(appdata) / APP_DIR_NAME)
        candidates.extend(
            [
                Path.home() / "AppData" / "Roaming" / APP_DIR_NAME,
                Path.home() / ".config" / APP_DIR_NAME,
                Path(tempfile.gettempdir()) / APP_DIR_NAME,
            ]
        )
        return _first_writable_dir(candidates)
    if system == "Darwin":
        return _first_writable_dir(
            [
                Path.home() / "Library" / "Application Support" / APP_DIR_NAME,
                Path.home() / ".config" / APP_DIR_NAME,
                Path(tempfile.gettempdir()) / APP_DIR_NAME,
            ]
        )
    return _first_writable_dir(
        [
            Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))) / APP_DIR_NAME,
            Path.home() / ".config" / APP_DIR_NAME,
            Path(tempfile.gettempdir()) / APP_DIR_NAME,
        ]
    )


def _set_env_default(name: str, value: str) -> None:
    if not os.environ.get(name, "").strip():
        os.environ[name] = value


def _sqlite_url(path: Path) -> str:
    return f"sqlite:///{path.expanduser().resolve().as_posix()}"


def _coordinator_port() -> int:
    return env_int("COORDINATOR_PORT", 7000, minimum=1, maximum=65535)


def _url_host(url: str) -> str:
    parsed = urllib_parse.urlparse(url.strip())
    return str(parsed.hostname or "").strip().lower()


def _http_json(
    method: str,
    url: str,
    *,
    payload: dict | None = None,
    timeout_seconds: float = 2.5,
) -> dict | None:
    headers = {"Accept": "application/json", "User-Agent": "stream-local-launcher"}
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib_request.Request(url=url, data=data, headers=headers, method=method.upper())
    try:
        with urllib_request.urlopen(request, timeout=timeout_seconds) as response:
            body = response.read()
    except (urllib_error.URLError, TimeoutError, OSError):
        return None
    try:
        parsed = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _is_local_coordinator_url(url: str) -> bool:
    host = _url_host(url)
    if not host:
        return False
    if host in {"127.0.0.1", "localhost", "::1"}:
        return True
    local_hosts = {addr.lower() for addr in local_ipv4_addresses(include_loopback=True)}
    return host in local_hosts


def _wait_for_coordinator(url: str, timeout_seconds: float = 10.0) -> bool:
    deadline = time.monotonic() + max(0.5, timeout_seconds)
    probe_url = f"{url.rstrip('/')}/"
    while time.monotonic() < deadline:
        payload = _http_json("GET", probe_url, timeout_seconds=0.6)
        if payload and str(payload.get("service") or "").lower() == "coordinator":
            return True
        time.sleep(0.2)
    return False


def _auto_identity_payload() -> dict[str, str | None]:
    host_label = socket.gethostname().strip() or platform.node().strip() or "Local Device"
    display_name = os.environ.get("STREAM_DISPLAY_NAME", "").strip() or host_label
    device_name = os.environ.get("STREAM_DEVICE_NAME", "").strip() or host_label
    return {
        "display_name": display_name[:80],
        "device_name": device_name[:120],
        "platform": platform.system()[:60] or "unknown",
        "public_key": None,
    }


def _ensure_local_agent_identity() -> None:
    from stream_server.settings_store import load_settings, save_settings

    coordinator_url = str(os.environ.get("AGENT_COORDINATOR_URL", "")).strip().rstrip("/")
    if not coordinator_url:
        return

    settings = load_settings()
    saved_coord_url = str(settings.get("network_coordinator_url") or "").strip().rstrip("/")
    principal_id = str(settings.get("network_principal_id") or "").strip()
    client_device_id = str(settings.get("network_client_device_id") or "").strip()
    device_secret = str(settings.get("network_device_secret") or "").strip()

    needs_bootstrap = not (principal_id and client_device_id and device_secret) or saved_coord_url != coordinator_url
    if needs_bootstrap:
        payload = _http_json(
            "POST",
            f"{coordinator_url}/api/v1/pairing/start?auto_join=1",
            payload=_auto_identity_payload(),
            timeout_seconds=5.0,
        )
        if not payload:
            raise RuntimeError(f"Unable to reach coordinator at {coordinator_url}")
        principal_id = str(payload.get("principal_id") or "").strip()
        client_device_id = str(payload.get("client_device_id") or "").strip()
        device_secret = str(payload.get("device_secret") or "").strip()
        if not (principal_id and client_device_id and device_secret):
            raise RuntimeError("Coordinator did not return auto-join credentials")
        settings["network_coordinator_url"] = coordinator_url
        settings["network_principal_id"] = principal_id
        settings["network_client_device_id"] = client_device_id
        settings["network_device_secret"] = device_secret
        save_settings(settings)

    _set_env_default("AGENT_OWNER_PRINCIPAL_ID", principal_id)
    _set_env_default("STREAM_COORD_PRINCIPAL_ID", principal_id)
    _set_env_default("STREAM_COORD_CLIENT_DEVICE_ID", client_device_id)
    _set_env_default("STREAM_COORD_DEVICE_SECRET", device_secret)


def _ensure_distributed_runtime_defaults() -> None:
    # Import lazily to avoid loading Flask config paths until startup mode is known.
    from stream_server.settings_store import load_settings, resolve_runtime_settings, save_settings

    settings = load_settings()
    has_changes = False

    coordinator_secret = str(settings.get("coordinator_secret_key") or "").strip()
    if not coordinator_secret:
        coordinator_secret = secrets.token_urlsafe(48)
        settings["coordinator_secret_key"] = coordinator_secret
        has_changes = True

    agent_shared_secret = str(settings.get("coordinator_agent_shared_secret") or "").strip()
    if not agent_shared_secret:
        agent_shared_secret = secrets.token_urlsafe(48)
        settings["coordinator_agent_shared_secret"] = agent_shared_secret
        has_changes = True

    agent_device_id = str(settings.get("agent_device_id") or "").strip()
    if not agent_device_id:
        agent_device_id = str(uuid4())
        settings["agent_device_id"] = agent_device_id
        has_changes = True

    agent_share_id = str(settings.get("agent_default_share_id") or "").strip()
    if not agent_share_id:
        agent_share_id = str(uuid4())
        settings["agent_default_share_id"] = agent_share_id
        has_changes = True

    if has_changes:
        save_settings(settings)

    runtime = resolve_runtime_settings()
    share_root = Path(runtime["root_dir"]).resolve()
    app_data_dir = _settings_dir()
    app_data_dir.mkdir(parents=True, exist_ok=True)

    _set_env_default("COORDINATOR_SECRET_KEY", coordinator_secret)
    _set_env_default("COORDINATOR_AGENT_SHARED_SECRET", agent_shared_secret)
    _set_env_default("COORDINATOR_DATABASE_URL", _sqlite_url(app_data_dir / "coordinator.db"))
    _set_env_default("AGENT_STATE_DB_URL", _sqlite_url(app_data_dir / "agent_state.db"))
    _set_env_default("AGENT_DEVICE_ID", agent_device_id)
    _set_env_default("AGENT_DEFAULT_SHARE_ID", agent_share_id)
    _set_env_default("AGENT_DEFAULT_SHARE_NAME", "Home Share")
    _set_env_default("AGENT_DEFAULT_SHARE_ROOT", str(share_root))
    _set_env_default("AGENT_INBOX_DIR", str(share_root / ".inbox"))

    coordinator_port = _coordinator_port()
    agent_port = env_int("AGENT_PORT", 7001, minimum=1, maximum=65535)
    lan_ip = preferred_lan_ipv4()
    local_coordinator_url = f"http://{lan_ip}:{coordinator_port}"
    discovered = discover_coordinators(port=coordinator_port, timeout_seconds=0.16, max_workers=48, max_results=6)
    chosen_coordinator_url = discovered[0] if discovered else local_coordinator_url

    # Auto-join keeps UX zero-config on trusted LANs.
    _set_env_default("COORDINATOR_AUTO_JOIN", "1")
    _set_env_default("STREAM_LOCAL_COORDINATOR_URL", local_coordinator_url)
    _set_env_default("STREAM_DEFAULT_COORDINATOR_URL", chosen_coordinator_url)
    _set_env_default("AGENT_COORDINATOR_URL", chosen_coordinator_url)
    _set_env_default("AGENT_PUBLIC_BASE_URL", f"http://{lan_ip}:{agent_port}")
    _set_env_default("AGENT_NAME", socket.gethostname().strip() or "Local Device")


def _write_startup_error_log(error: BaseException) -> Path:
    logs_dir = _settings_dir() / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%SZ")
    log_path = logs_dir / f"startup-error-{ts}.log"
    content = (
        f"timestamp_utc={ts}\n"
        f"error_type={type(error).__name__}\n"
        f"error_message={error}\n\n"
        f"{traceback.format_exc()}"
    )
    log_path.write_text(content, encoding="utf-8")
    return log_path


def _show_startup_error(error: BaseException, log_path: Path) -> None:
    message = f"Stream Local failed to start.\n\n{error}\n\nDetails: {log_path}"
    try:
        if os.name == "nt":
            import ctypes

            ctypes.windll.user32.MessageBoxW(0, message, "Stream Local Startup Error", 0x10)
    except Exception:
        pass
    print(message)


def _run_web_service() -> None:
    from stream_server import create_app

    app = create_app()
    host = os.environ.get("WEB_HOST", os.environ.get("HOST", "0.0.0.0")).strip() or "0.0.0.0"
    configured_port = env_int("PORT", int(app.config.get("PORT", 5000)), minimum=1, maximum=65535)
    port = env_int("WEB_PORT", configured_port, minimum=1, maximum=65535)
    auto_open_browser = os.environ.get("STREAM_NO_BROWSER", "").strip() != "1" and bool(
        app.config.get("AUTO_OPEN_BROWSER", True)
    )
    if auto_open_browser:
        browser_timer = threading.Timer(1.0, lambda: webbrowser.open(f"http://127.0.0.1:{port}/", new=2))
        browser_timer.daemon = True
        browser_timer.start()

    debug = os.environ.get("FLASK_DEBUG") == "1"
    if debug:
        app.run(host=host, port=port, debug=True, threaded=True)
        return

    try:
        from waitress import serve
    except Exception:  # noqa: BLE001
        app.run(host=host, port=port, debug=False, threaded=True)
        return

    threads = env_int(
        "WEB_THREADS",
        max(4, min(64, (os.cpu_count() or 1) * 4)),
        minimum=4,
        maximum=256,
    )
    connection_limit = env_int("WEB_CONNECTION_LIMIT", 2000, minimum=128, maximum=50000)
    channel_timeout = env_int("WEB_CHANNEL_TIMEOUT_SECONDS", 30, minimum=5, maximum=300)
    serve(
        app,
        host=host,
        port=port,
        threads=threads,
        connection_limit=connection_limit,
        channel_timeout=channel_timeout,
        ident="stream-local",
    )


def _run_coordinator_service() -> None:
    import uvicorn

    uvicorn.run(
        "coordinator.main:app",
        **uvicorn_runtime_settings("COORDINATOR", 7000, default_workers=max(1, min(4, os.cpu_count() or 1))),
    )


def _run_agent_service() -> None:
    import uvicorn

    uvicorn.run(
        "agent.main:app",
        **uvicorn_runtime_settings("AGENT", 7001, default_workers=max(1, min(2, os.cpu_count() or 1))),
    )


def _run_all_services() -> None:
    # Split control and data planes into dedicated processes for better CPU utilization.
    ctx = mp.get_context("spawn")
    processes: list[mp.Process] = []

    try:
        coordinator = ctx.Process(target=_run_coordinator_service, name="stream-coordinator", daemon=False)
        coordinator.start()
        processes.append(coordinator)

        target_coordinator = str(os.environ.get("AGENT_COORDINATOR_URL", "")).strip()
        local_coordinator = str(os.environ.get("STREAM_LOCAL_COORDINATOR_URL", "")).strip()
        if not target_coordinator:
            target_coordinator = local_coordinator
            if target_coordinator:
                os.environ["AGENT_COORDINATOR_URL"] = target_coordinator

        if _is_local_coordinator_url(target_coordinator):
            probe_target = target_coordinator or local_coordinator
            if probe_target and not _wait_for_coordinator(probe_target, timeout_seconds=12.0):
                raise RuntimeError(f"Coordinator failed to start at {probe_target}")

        try:
            _ensure_local_agent_identity()
        except RuntimeError:
            # If remote coordinator selection failed, fallback to local coordinator.
            if local_coordinator and target_coordinator.rstrip("/") != local_coordinator.rstrip("/"):
                os.environ["AGENT_COORDINATOR_URL"] = local_coordinator
                os.environ["STREAM_DEFAULT_COORDINATOR_URL"] = local_coordinator
                if not _wait_for_coordinator(local_coordinator, timeout_seconds=12.0):
                    raise RuntimeError(f"Coordinator failed to start at {local_coordinator}")
                _ensure_local_agent_identity()
            else:
                raise

        for name, target in (("agent", _run_agent_service), ("web", _run_web_service)):
            process = ctx.Process(target=target, name=f"stream-{name}", daemon=False)
            process.start()
            processes.append(process)

        while True:
            for process in processes:
                if not process.is_alive():
                    raise RuntimeError(f"{process.name} exited with code {process.exitcode}")
            time.sleep(0.4)
    except KeyboardInterrupt:
        return
    finally:
        for process in processes:
            if process.is_alive():
                process.terminate()

        deadline = time.monotonic() + 5
        for process in processes:
            remaining = max(0.0, deadline - time.monotonic())
            process.join(timeout=remaining)

        for process in processes:
            if process.is_alive():
                process.kill()

        for process in processes:
            process.join(timeout=2)


def _run() -> None:
    default_service = "all" if getattr(sys, "frozen", False) else "web"
    parser = argparse.ArgumentParser(description="Run Stream Local services")
    parser.add_argument(
        "--service",
        choices=("web", "coordinator", "agent", "all"),
        default=os.environ.get("STREAM_SERVICE", default_service),
        help="Service mode to run",
    )
    args = parser.parse_args()

    service = str(args.service).strip().lower()
    if service in {"coordinator", "agent", "all"}:
        _ensure_distributed_runtime_defaults()

    if service == "web":
        _run_web_service()
        return
    if service == "coordinator":
        _run_coordinator_service()
        return
    if service == "agent":
        _run_agent_service()
        return
    if service == "all":
        _run_all_services()
        return

    raise RuntimeError(f"Unknown service mode: {service}")


if __name__ == "__main__":
    mp.freeze_support()
    try:
        _run()
    except Exception as exc:  # noqa: BLE001
        path = _write_startup_error_log(exc)
        _show_startup_error(exc, path)
        raise SystemExit(1)
