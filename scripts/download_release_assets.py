from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


def _require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def _api_request(method: str, url: str, token: str, *, accept: str = "application/vnd.github+json") -> tuple[int, bytes]:
    headers = {
        "Accept": accept,
        "Authorization": f"Bearer {token}",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "stream-local-release-script",
    }
    request = urllib.request.Request(url=url, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request) as response:
            return int(response.status), response.read()
    except urllib.error.HTTPError as exc:
        return int(exc.code), exc.read()


def _decode_json(payload: bytes) -> dict:
    if not payload:
        return {}
    try:
        data = json.loads(payload.decode("utf-8"))
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def _fetch_release(repo: str, token: str, tag: str) -> dict:
    tag_encoded = urllib.parse.quote(tag, safe="")
    url = f"https://api.github.com/repos/{repo}/releases/tags/{tag_encoded}"
    status, body = _api_request("GET", url, token)
    if status != 200:
        detail = body.decode("utf-8", errors="ignore")
        raise RuntimeError(f"Failed to fetch release for tag {tag}: HTTP {status} {detail}")
    payload = _decode_json(body)
    if not payload.get("id"):
        raise RuntimeError("GitHub API returned invalid release payload")
    return payload


def _download_asset(asset: dict, token: str, output_dir: Path) -> Path:
    asset_id = int(asset.get("id") or 0)
    asset_name = str(asset.get("name") or "").strip()
    if asset_id <= 0 or not asset_name:
        raise RuntimeError("Invalid release asset payload")

    asset_url = f"https://api.github.com/repos/{_require_env('GITHUB_REPOSITORY')}/releases/assets/{asset_id}"
    headers = {
        "Accept": "application/octet-stream",
        "Authorization": f"Bearer {token}",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "stream-local-release-script",
    }
    request = urllib.request.Request(url=asset_url, headers=headers, method="GET")
    output_path = output_dir / asset_name
    try:
        with urllib.request.urlopen(request) as response:
            with output_path.open("wb") as file_obj:
                for chunk in iter(lambda: response.read(1024 * 1024), b""):
                    file_obj.write(chunk)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"Failed to download asset {asset_name}: HTTP {exc.code} {detail}") from exc
    return output_path


def _include_asset(name: str, include_checksums: bool) -> bool:
    if include_checksums:
        return True
    return not name.endswith(".sha256")


def main() -> int:
    parser = argparse.ArgumentParser(description="Download release assets for a Git tag")
    parser.add_argument("--tag", required=True, help="Release tag, e.g. v1.2.3")
    parser.add_argument("--out-dir", required=True, help="Output directory for downloaded assets")
    parser.add_argument(
        "--include-checksums",
        action="store_true",
        help="Include .sha256 checksum assets (default is binary archives only)",
    )
    args = parser.parse_args()

    repo = _require_env("GITHUB_REPOSITORY")
    token = _require_env("GITHUB_TOKEN")
    output_dir = Path(args.out_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    release = _fetch_release(repo, token, args.tag)
    assets = release.get("assets")
    if not isinstance(assets, list) or not assets:
        raise RuntimeError(f"No assets found for tag {args.tag}")

    downloaded: list[Path] = []
    for asset in assets:
        if not isinstance(asset, dict):
            continue
        name = str(asset.get("name") or "")
        if not _include_asset(name, args.include_checksums):
            continue
        downloaded.append(_download_asset(asset, token, output_dir))

    if not downloaded:
        raise RuntimeError("No matching assets were downloaded")

    for path in downloaded:
        print(path)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
