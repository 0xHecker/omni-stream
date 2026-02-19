from __future__ import annotations

import argparse
import hashlib
import platform
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


def normalize_arch(machine: str) -> str:
    value = machine.strip().lower()
    mapping = {
        "x86_64": "x64",
        "amd64": "x64",
        "arm64": "arm64",
        "aarch64": "arm64",
    }
    return mapping.get(value, value or "unknown")


def normalize_os(runner_os: str) -> str:
    mapping = {
        "Windows": "windows",
        "Linux": "linux",
        "macOS": "macos",
    }
    return mapping.get(runner_os, runner_os.lower())


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file_obj:
        for chunk in iter(lambda: file_obj.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description="Package built binary into release archive")
    parser.add_argument("--version", required=True, help="Version string without v prefix")
    parser.add_argument("--runner-os", required=True, help="GitHub runner OS value")
    parser.add_argument("--dist-dir", default="dist", help="Directory containing built binary")
    parser.add_argument("--out-dir", default="packages", help="Output package directory")
    args = parser.parse_args()

    dist_dir = Path(args.dist_dir).resolve()
    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    binary_name = "stream-local.exe" if args.runner_os == "Windows" else "stream-local"
    binary_path = dist_dir / binary_name
    if not binary_path.exists():
        raise SystemExit(f"Built binary not found: {binary_path}")

    target = f"{normalize_os(args.runner_os)}-{normalize_arch(platform.machine())}"
    archive_name = f"stream-local-v{args.version}-{target}.zip"
    archive_path = out_dir / archive_name

    with ZipFile(archive_path, "w", compression=ZIP_DEFLATED) as archive:
        archive.write(binary_path, arcname=binary_path.name)

    checksum = sha256_file(archive_path)
    checksum_path = archive_path.with_suffix(f"{archive_path.suffix}.sha256")
    checksum_path.write_text(f"{checksum}  {archive_path.name}\n", encoding="utf-8")

    print(archive_path)
    print(checksum_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
