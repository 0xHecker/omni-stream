from __future__ import annotations

import argparse
from datetime import datetime, timezone
import os
import platform
import multiprocessing as mp
import threading
import time
import traceback
import webbrowser
from pathlib import Path

from shared.runtime import env_int, uvicorn_runtime_settings


APP_DIR_NAME = "StreamLocalFiles"


def _settings_dir() -> Path:
    system = platform.system()
    if system == "Windows":
        appdata = os.environ.get("APPDATA")
        if appdata:
            return Path(appdata) / APP_DIR_NAME
        return Path.home() / "AppData" / "Roaming" / APP_DIR_NAME
    if system == "Darwin":
        return Path.home() / "Library" / "Application Support" / APP_DIR_NAME
    return Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))) / APP_DIR_NAME


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
    process_targets = {
        "coordinator": _run_coordinator_service,
        "agent": _run_agent_service,
        "web": _run_web_service,
    }
    ctx = mp.get_context("spawn")
    processes: list[mp.Process] = []

    try:
        for name, target in process_targets.items():
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
    parser = argparse.ArgumentParser(description="Run Stream Local services")
    parser.add_argument(
        "--service",
        choices=("web", "coordinator", "agent", "all"),
        default=os.environ.get("STREAM_SERVICE", "web"),
        help="Service mode to run",
    )
    args = parser.parse_args()

    service = str(args.service).strip().lower()
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
