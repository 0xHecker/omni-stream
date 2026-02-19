from __future__ import annotations

import argparse
import http.client
import json
import os
import re
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


def _api_request(
    method: str,
    url: str,
    token: str,
    *,
    payload: dict | None = None,
    binary: bytes | None = None,
    content_type: str | None = None,
) -> tuple[int, bytes]:
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "stream-local-release-script",
    }
    data: bytes | None = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    elif binary is not None:
        data = binary
        headers["Content-Type"] = content_type or "application/octet-stream"

    request = urllib.request.Request(url=url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request) as response:
            body = response.read()
            return int(response.status), body
    except urllib.error.HTTPError as exc:
        body = exc.read()
        return int(exc.code), body


def _api_upload_file(url: str, token: str, path: Path) -> tuple[int, bytes]:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"https", "http"}:
        raise RuntimeError(f"Unsupported upload URL scheme: {parsed.scheme}")
    if not parsed.netloc:
        raise RuntimeError("Upload URL is missing host")

    request_path = parsed.path or "/"
    if parsed.query:
        request_path = f"{request_path}?{parsed.query}"

    connection_cls = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
    connection = connection_cls(parsed.netloc, timeout=300)
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "stream-local-release-script",
        "Content-Type": "application/octet-stream",
        "Content-Length": str(path.stat().st_size),
    }

    try:
        connection.putrequest("POST", request_path)
        for name, value in headers.items():
            connection.putheader(name, value)
        connection.endheaders()

        with path.open("rb") as file_obj:
            for chunk in iter(lambda: file_obj.read(1024 * 1024), b""):
                connection.send(chunk)

        response = connection.getresponse()
        body = response.read()
        return int(response.status), body
    finally:
        connection.close()


def _decode_json(body: bytes) -> dict:
    if not body:
        return {}
    try:
        data = json.loads(body.decode("utf-8"))
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def _get_or_create_release(repo: str, token: str, tag: str, prerelease: bool) -> dict:
    api_base = f"https://api.github.com/repos/{repo}"
    get_url = f"{api_base}/releases/tags/{urllib.parse.quote(tag, safe='')}"
    status, body = _api_request("GET", get_url, token)
    if status == 200:
        release = _decode_json(body)
        if release.get("id"):
            return release
        raise RuntimeError("GitHub API returned invalid release payload")
    if status != 404:
        detail = body.decode("utf-8", errors="ignore")
        raise RuntimeError(f"Failed to fetch release for tag {tag}: HTTP {status} {detail}")

    create_url = f"{api_base}/releases"
    payload = {
        "tag_name": tag,
        "name": tag,
        "generate_release_notes": True,
        "prerelease": prerelease,
    }
    status, body = _api_request("POST", create_url, token, payload=payload)
    if status in {200, 201}:
        release = _decode_json(body)
        if not release.get("id"):
            raise RuntimeError("GitHub API returned invalid created release payload")
        return release

    if status == 422:
        # Another runner likely created the release between our GET and POST.
        status_retry, body_retry = _api_request("GET", get_url, token)
        if status_retry == 200:
            release = _decode_json(body_retry)
            if release.get("id"):
                return release

    detail = body.decode("utf-8", errors="ignore")
    raise RuntimeError(f"Failed to create release for tag {tag}: HTTP {status} {detail}")


def _delete_asset_if_exists(repo: str, token: str, release: dict, filename: str) -> None:
    assets = release.get("assets")
    if not isinstance(assets, list):
        return
    for item in assets:
        if not isinstance(item, dict):
            continue
        if str(item.get("name") or "") != filename:
            continue
        asset_id = item.get("id")
        if not asset_id:
            continue
        delete_url = f"https://api.github.com/repos/{repo}/releases/assets/{asset_id}"
        status, body = _api_request("DELETE", delete_url, token)
        if status not in {200, 204}:
            detail = body.decode("utf-8", errors="ignore")
            raise RuntimeError(f"Failed to delete existing asset {filename}: HTTP {status} {detail}")


def _upload_assets(repo: str, token: str, release: dict, files: list[Path]) -> None:
    upload_url_template = str(release.get("upload_url") or "")
    if not upload_url_template:
        raise RuntimeError("Release payload is missing upload_url")
    upload_base = upload_url_template.split("{", 1)[0]

    for path in files:
        filename = path.name
        _delete_asset_if_exists(repo, token, release, filename)
        upload_url = f"{upload_base}?name={urllib.parse.quote(filename, safe='')}"
        status, body = _api_upload_file(upload_url, token, path)
        if status not in {200, 201}:
            detail = body.decode("utf-8", errors="ignore")
            raise RuntimeError(f"Failed to upload asset {filename}: HTTP {status} {detail}")
        print(f"Uploaded: {filename}")


def _is_prerelease_tag(tag: str) -> bool:
    normalized = tag[1:] if tag.startswith("v") else tag
    return bool(re.search(r"-[0-9A-Za-z.-]+$", normalized))


def main() -> int:
    parser = argparse.ArgumentParser(description="Publish files to a GitHub release")
    parser.add_argument("--tag", required=True, help="Release tag, e.g. v1.2.3")
    parser.add_argument("--files", nargs="+", required=True, help="Files to upload")
    args = parser.parse_args()

    repo = _require_env("GITHUB_REPOSITORY")
    token = _require_env("GITHUB_TOKEN")
    files = [Path(item).resolve() for item in args.files]
    missing = [str(path) for path in files if not path.exists() or not path.is_file()]
    if missing:
        raise RuntimeError(f"Release asset files not found: {', '.join(missing)}")

    prerelease = _is_prerelease_tag(args.tag)
    release = _get_or_create_release(repo, token, args.tag, prerelease)
    _upload_assets(repo, token, release, files)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
