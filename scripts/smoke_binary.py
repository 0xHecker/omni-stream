from __future__ import annotations

import argparse
import os
import signal
import socket
import subprocess
import sys
import tempfile
from pathlib import Path


def resolve_binary_path(dist_dir: Path, runner_os: str) -> Path:
    binary_name = "stream-local.exe" if runner_os == "Windows" else "stream-local"
    binary_path = dist_dir / binary_name
    if not binary_path.exists():
        raise SystemExit(f"Built binary not found: {binary_path}")
    return binary_path


def terminate_process_tree(proc: subprocess.Popen[str]) -> None:
    if proc.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return

    os.killpg(proc.pid, signal.SIGTERM)
    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)


def pick_local_tcp_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def pick_unique_ports(count: int) -> list[int]:
    ports: list[int] = []
    while len(ports) < max(1, count):
        candidate = pick_local_tcp_port()
        if candidate in ports:
            continue
        ports.append(candidate)
    return ports


def main() -> int:
    parser = argparse.ArgumentParser(description="Smoke-test the packaged stream-local binary")
    parser.add_argument("--runner-os", required=True, help="GitHub runner OS value")
    parser.add_argument("--dist-dir", default="dist", help="Directory containing built binary")
    parser.add_argument("--timeout-seconds", type=int, default=5, help="Seconds binary must stay alive")
    args = parser.parse_args()

    binary_path = resolve_binary_path(Path(args.dist_dir).resolve(), args.runner_os)

    env = os.environ.copy()
    smoke_settings_dir = Path(tempfile.mkdtemp(prefix="stream-local-smoke-"))
    web_port, coordinator_port, agent_port = pick_unique_ports(3)
    env["STREAM_NO_BROWSER"] = "1"
    env["HOST"] = "127.0.0.1"
    env["STREAM_SERVICE"] = "all"
    env["PORT"] = str(web_port)
    env["WEB_PORT"] = str(web_port)
    env["COORDINATOR_PORT"] = str(coordinator_port)
    env["AGENT_PORT"] = str(agent_port)
    env["STREAM_SETTINGS_DIR"] = str(smoke_settings_dir)

    proc = subprocess.Popen(
        [str(binary_path)],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        proc.wait(timeout=max(args.timeout_seconds, 1))
    except subprocess.TimeoutExpired:
        terminate_process_tree(proc)
        print(f"Smoke test passed: {binary_path.name} stayed alive for {args.timeout_seconds}s")
        return 0

    stdout, stderr = proc.communicate(timeout=1)
    message = (
        f"Smoke test failed: {binary_path.name} exited early with code {proc.returncode}\n"
        f"stdout:\n{stdout}\n"
        f"stderr:\n{stderr}"
    )
    print(message, file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
