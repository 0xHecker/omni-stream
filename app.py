from __future__ import annotations

from datetime import datetime, timezone
import os
import platform
import threading
import traceback
import webbrowser
from pathlib import Path


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


def _run() -> None:
    from stream_server import create_app

    app = create_app()
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", str(app.config.get("PORT", 5000))))
    auto_open_browser = os.environ.get("STREAM_NO_BROWSER", "").strip() != "1" and bool(
        app.config.get("AUTO_OPEN_BROWSER", True)
    )
    if auto_open_browser:
        threading.Timer(1.0, lambda: webbrowser.open(f"http://127.0.0.1:{port}/", new=2)).start()

    app.run(
        host=host,
        port=port,
        debug=os.environ.get("FLASK_DEBUG") == "1",
    )


if __name__ == "__main__":
    try:
        _run()
    except Exception as exc:  # noqa: BLE001
        path = _write_startup_error_log(exc)
        _show_startup_error(exc, path)
        raise SystemExit(1)
