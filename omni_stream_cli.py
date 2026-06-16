from __future__ import annotations

import argparse
import os
import platform
import shutil
import socket
import subprocess
import sys
import webbrowser
from pathlib import Path
from typing import Iterable

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - Python 3.11+ is required.
    tomllib = None  # type: ignore[assignment]


PROJECT_ROOT = Path(__file__).resolve().parent
ENV_FILE = Path(os.environ.get("OMNI_STREAM_ENV_FILE", PROJECT_ROOT / ".env")).expanduser()
PORT_KEYS = {
    "web": ("WEB_PORT", 5000),
    "coordinator": ("COORDINATOR_PORT", 7000),
    "agent": ("AGENT_PORT", 7001),
}


def _strip_env_quotes(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def _env_path(path: Path | None = None) -> Path:
    return path or ENV_FILE


def load_env_file(path: Path | None = None) -> None:
    path = _env_path(path)
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key:
            os.environ.setdefault(key, _strip_env_quotes(value))


def _env_file_values(path: Path | None = None) -> dict[str, str]:
    path = _env_path(path)
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key:
            values[key] = _strip_env_quotes(value)
    return values


def _write_env_values(updates: dict[str, str], path: Path | None = None) -> None:
    path = _env_path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    seen: set[str] = set()
    output: list[str] = []

    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in line:
            output.append(line)
            continue
        key = line.split("=", 1)[0].strip()
        if key in updates:
            output.append(f"{key}={updates[key]}")
            seen.add(key)
        else:
            output.append(line)

    for key, value in updates.items():
        if key not in seen:
            output.append(f"{key}={value}")

    path.write_text("\n".join(output).rstrip() + "\n", encoding="utf-8")


def _valid_port(raw: str | int) -> int:
    try:
        port = int(str(raw).strip())
    except (TypeError, ValueError) as exc:
        raise argparse.ArgumentTypeError(f"{raw!r} is not a valid port") from exc
    if not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError("port must be between 1 and 65535")
    return port


def _configured_port(name: str) -> int:
    key, default = PORT_KEYS[name]
    return _valid_port(os.environ.get(key, default))


def _port_state(port: int) -> str:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", port))
        except OSError:
            return "in use"
    return "free"


def _project_version() -> str:
    pyproject = PROJECT_ROOT / "pyproject.toml"
    if not pyproject.exists() or tomllib is None:
        return "unknown"
    with pyproject.open("rb") as fh:
        data = tomllib.load(fh)
    project = data.get("project", {})
    return str(project.get("version", "unknown"))


def _uv_version() -> str:
    uv_path = shutil.which("uv")
    commands = []
    if uv_path:
        commands.append([uv_path, "--version"])
    commands.append([sys.executable, "-m", "uv", "--version"])

    for command in commands:
        try:
            result = subprocess.run(
                command,
                check=False,
                capture_output=True,
                text=True,
                timeout=5,
            )
        except (OSError, subprocess.TimeoutExpired):
            continue
        if result.returncode == 0:
            return result.stdout.strip() or result.stderr.strip() or "available"
    return "not found"


def _apply_port_overrides(args: argparse.Namespace) -> None:
    mapping = {
        "web_port": "WEB_PORT",
        "coordinator_port": "COORDINATOR_PORT",
        "agent_port": "AGENT_PORT",
    }
    for arg_name, env_name in mapping.items():
        value = getattr(args, arg_name, None)
        if value is not None:
            os.environ[env_name] = str(value)


def _run_service(service: str, args: argparse.Namespace) -> int:
    _apply_port_overrides(args)
    if getattr(args, "no_browser", False):
        os.environ["STREAM_NO_BROWSER"] = "1"
    os.environ["STREAM_SERVICE"] = service

    import app as launcher

    original_argv = sys.argv[:]
    sys.argv = ["app.py", "--service", service]
    try:
        launcher._run()
    finally:
        sys.argv = original_argv
    return 0


def command_start(args: argparse.Namespace) -> int:
    return _run_service(args.service, args)


def command_service(args: argparse.Namespace) -> int:
    return _run_service(args.command, args)


def command_ports(args: argparse.Namespace) -> int:
    updates: dict[str, str] = {}
    if args.web is not None:
        updates["WEB_PORT"] = str(args.web)
    if args.coordinator is not None:
        updates["COORDINATOR_PORT"] = str(args.coordinator)
    if args.agent is not None:
        updates["AGENT_PORT"] = str(args.agent)

    if updates:
        _write_env_values(updates)
        for key, value in updates.items():
            os.environ[key] = value
        print(f"Updated {ENV_FILE}")
        print("Restart Omni Stream for port changes to affect running services.")

    values = _env_file_values()
    print("Ports:")
    for name, (key, default) in PORT_KEYS.items():
        value = os.environ.get(key) or values.get(key) or str(default)
        print(f"  {name:11} {value}")
    return 0


def command_open(args: argparse.Namespace) -> int:
    port = args.port or _configured_port("web")
    url = f"http://{args.host}:{port}/"
    print(f"Opening {url}")
    webbrowser.open(url, new=2)
    return 0


def command_where(_: argparse.Namespace) -> int:
    from stream_server.settings_store import settings_path

    print(f"Install root: {PROJECT_ROOT}")
    print(f"Environment:  {ENV_FILE}")
    print(f"Settings:     {settings_path()}")
    print(f"Python:       {sys.executable}")
    return 0


def command_doctor(_: argparse.Namespace) -> int:
    from stream_server.settings_store import settings_path

    print("Omni Stream doctor")
    print(f"Version:      {_project_version()}")
    print(f"OS:           {platform.platform()}")
    print(f"Install root: {PROJECT_ROOT}")
    print(f"Environment:  {ENV_FILE} ({'exists' if ENV_FILE.exists() else 'missing'})")
    print(f"Settings:     {settings_path()}")
    print(f"Python:       {platform.python_version()} at {sys.executable}")
    print(f"uv:           {_uv_version()}")
    print("Ports:")
    for name in PORT_KEYS:
        port = _configured_port(name)
        print(f"  {name:11} {port:<5} {_port_state(port)}")
    return 0


def _add_port_override_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--web-port", type=_valid_port, help="override WEB_PORT for this run")
    parser.add_argument("--coordinator-port", type=_valid_port, help="override COORDINATOR_PORT for this run")
    parser.add_argument("--agent-port", type=_valid_port, help="override AGENT_PORT for this run")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="omni-stream",
        description="Install-friendly CLI for the Omni Stream LAN file-sharing hub.",
    )
    parser.add_argument("--version", action="version", version=f"omni-stream {_project_version()}")
    subparsers = parser.add_subparsers(dest="command")

    start = subparsers.add_parser("start", aliases=["run", "serve"], help="start services in the foreground")
    start.add_argument(
        "--service",
        choices=("all", "web", "coordinator", "agent"),
        default=os.environ.get("STREAM_SERVICE", "all"),
        help="service group to start",
    )
    start.add_argument("--no-browser", action="store_true", help="do not auto-open the browser")
    _add_port_override_options(start)
    start.set_defaults(func=command_start)

    for service in ("all", "web", "coordinator", "agent"):
        service_parser = subparsers.add_parser(service, help=f"start {service} service mode")
        service_parser.add_argument("--no-browser", action="store_true", help="do not auto-open the browser")
        _add_port_override_options(service_parser)
        service_parser.set_defaults(func=command_service)

    ports = subparsers.add_parser("ports", help="show or persist service ports")
    ports.add_argument("--web", type=_valid_port, help="persist WEB_PORT")
    ports.add_argument("--coordinator", type=_valid_port, help="persist COORDINATOR_PORT")
    ports.add_argument("--agent", type=_valid_port, help="persist AGENT_PORT")
    ports.set_defaults(func=command_ports)

    open_cmd = subparsers.add_parser("open", help="open the web UI in a browser")
    open_cmd.add_argument("--host", default="127.0.0.1", help="host to open")
    open_cmd.add_argument("--port", type=_valid_port, help="web port to open")
    open_cmd.set_defaults(func=command_open)

    where = subparsers.add_parser("where", help="show install, env, and settings paths")
    where.set_defaults(func=command_where)

    doctor = subparsers.add_parser("doctor", help="check runtime dependencies and configured ports")
    doctor.set_defaults(func=command_doctor)

    return parser


def main(argv: Iterable[str] | None = None) -> int:
    load_env_file()
    args = build_parser().parse_args(list(argv) if argv is not None else None)
    if not hasattr(args, "func"):
        args = build_parser().parse_args(["start"])
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
