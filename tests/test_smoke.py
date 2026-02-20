from __future__ import annotations

import importlib
from pathlib import Path

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
