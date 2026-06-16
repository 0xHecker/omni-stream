from __future__ import annotations

import importlib
from pathlib import Path

from flask import Flask

from stream_server.services import file_service_catalog
from stream_server.services import hub_proxy
from stream_server.services.file_service import (
    generate_cached_thumbnail_bytes,
    generate_file_thumbnail_bytes,
    guess_mimetype,
)


def test_guess_mimetype_text_has_no_duplicate_charset() -> None:
    assert guess_mimetype(Path("notes.txt"), "text") == "text/plain"
    assert guess_mimetype(Path("index.html"), "html") == "text/html"


def test_cached_thumbnail_for_text_file(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "notes.txt"
    source.write_text("line 1\nline 2\nline 3\n", encoding="utf-8")
    cache_dir = tmp_path / "thumb-cache"
    monkeypatch.setenv("STREAM_THUMBNAIL_CACHE_DIR", str(cache_dir))
    monkeypatch.setenv("STREAM_THUMBNAIL_CACHE_TTL_SECONDS", "600")

    first = generate_cached_thumbnail_bytes(source, "text", (220, 220))
    second = generate_cached_thumbnail_bytes(source, "text", (220, 220))

    assert first
    assert second
    assert first == second


def test_directory_listing_reuses_cached_entries_across_pages(tmp_path: Path, monkeypatch) -> None:
    root = tmp_path
    for index in range(6):
        (root / f"file-{index}.txt").write_text(str(index), encoding="utf-8")

    file_service_catalog._cached_directory_entries.cache_clear()
    original_iter = file_service_catalog._iter_ranked_entries
    calls = 0

    def counting_iter(*args, **kwargs):
        nonlocal calls
        calls += 1
        yield from original_iter(*args, **kwargs)

    monkeypatch.setattr(file_service_catalog, "_iter_ranked_entries", counting_iter)

    first_page = file_service_catalog.list_directory(root, root, max_entries=2, page=1)
    second_page = file_service_catalog.list_directory(root, root, max_entries=2, page=2)

    assert [item["name"] for item in first_page["items"]] == ["file-0.txt", "file-1.txt"]
    assert [item["name"] for item in second_page["items"]] == ["file-2.txt", "file-3.txt"]
    assert calls == 1


def test_remote_binary_proxy_streams_without_buffering(monkeypatch) -> None:
    class FakeResponse:
        status_code = 200
        is_success = True
        headers = {
            "content-type": "application/octet-stream",
            "content-length": "6",
        }

        def __init__(self) -> None:
            self.closed = False

        @property
        def content(self):  # pragma: no cover - this should never be touched.
            raise AssertionError("proxy should stream bytes instead of buffering response.content")

        def iter_bytes(self):
            yield b"abc"
            yield b"def"

        def close(self) -> None:
            self.closed = True

    class FakeClient:
        def __init__(self, response: FakeResponse) -> None:
            self.response = response

        def build_request(self, *args, **kwargs):
            return ("request", args, kwargs)

        def send(self, _request, *, stream: bool = False):
            assert stream is True
            return self.response

    fake_response = FakeResponse()
    fake_client = FakeClient(fake_response)
    monkeypatch.setattr(hub_proxy, "_browser_session_id", lambda: "browser-1")
    monkeypatch.setattr(hub_proxy, "_get_or_create_hub_client", lambda *args, **kwargs: fake_client)

    app = Flask(__name__)
    app.secret_key = "test-secret"
    with app.test_request_context("/stream"):
        response = hub_proxy.proxy_remote_binary(
            {"id": "hub-1", "web_url": "http://hub.local:5000"},
            "/stream",
            params={"path": "movie.mp4"},
        )
        payload = b"".join(response.response)

    assert payload == b"abcdef"
    assert fake_response.closed


def test_video_thumbnail_can_be_disabled(tmp_path: Path, monkeypatch) -> None:
    video = tmp_path / "sample.mp4"
    video.write_bytes(b"not-a-real-video")
    monkeypatch.setenv("STREAM_ENABLE_VIDEO_THUMBNAILS", "0")

    payload = generate_file_thumbnail_bytes(video, "video", (220, 220))
    assert payload


def test_pdf_thumbnail_falls_back_to_placeholder_when_renderer_missing(tmp_path: Path, monkeypatch) -> None:
    pdf = tmp_path / "sample.pdf"
    pdf.write_bytes(b"%PDF-1.7\n%fake\n")
    monkeypatch.setattr("stream_server.services.file_service.fitz", None)

    payload = generate_file_thumbnail_bytes(pdf, "pdf", (220, 220))
    assert payload


def test_agent_app_enables_cors_middleware(monkeypatch) -> None:
    monkeypatch.setenv("ALLOW_INSECURE_DEFAULTS", "1")
    module = importlib.import_module("agent.main")
    app = module.create_app()
    middleware_names = {middleware.cls.__name__ for middleware in app.user_middleware}
    assert "CORSMiddleware" in middleware_names
