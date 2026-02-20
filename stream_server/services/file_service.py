from __future__ import annotations

import io
import heapq
import hashlib
import mimetypes
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
from functools import lru_cache
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any

from PIL import Image, ImageDraw, ImageFont, ImageOps, UnidentifiedImageError


from .file_service_catalog import (
    get_adjacent_file,
    get_file_type,
    guess_mimetype,
    list_directory,
    resolve_requested_path,
    search_entries,
    to_client_path,
)
THUMBNAIL_MIN_EDGE = 64
THUMBNAIL_MAX_EDGE = 512
TEXT_THUMBNAIL_MAX_BYTES = 16 * 1024
TEXT_THUMBNAIL_MAX_LINES = 9
TEXT_THUMBNAIL_MAX_LINE_CHARS = 34
STREAM_CHUNK_BYTES = 64 * 1024
THUMBNAIL_CACHE_VERSION = 3
THUMBNAIL_DEFAULT_CACHE_TTL_SECONDS = 30 * 60
THUMBNAIL_DEFAULT_CACHE_MAX_BYTES = 256 * 1024 * 1024
THUMBNAIL_CACHE_PRUNE_INTERVAL_SECONDS = 5 * 60
THUMBNAIL_GENERATION_DEFAULT_CONCURRENCY = max(2, min(6, os.cpu_count() or 2))
THUMBNAIL_GENERATION_ACQUIRE_TIMEOUT_SECONDS = 0.08

_THUMBNAIL_LABELS = {
    "directory": "DIR",
    "video": "VID",
    "image": "IMG",
    "svg": "SVG",
    "pdf": "PDF",
    "word": "DOC",
    "excel": "XLS",
    "markdown": "MD",
    "html": "HTML",
    "code": "CODE",
    "text": "TXT",
    "other": "FILE",
}

_THUMBNAIL_COLORS = {
    "directory": ((246, 201, 92), (233, 177, 49), (95, 70, 18)),
    "video": ((67, 141, 233), (40, 108, 191), (18, 54, 101)),
    "image": ((68, 176, 132), (43, 145, 102), (19, 80, 52)),
    "svg": ((53, 170, 174), (34, 134, 138), (18, 73, 76)),
    "pdf": ((214, 95, 89), (178, 67, 61), (102, 28, 25)),
    "word": ((72, 119, 225), (48, 88, 182), (24, 45, 103)),
    "excel": ((52, 146, 104), (35, 113, 77), (19, 67, 44)),
    "markdown": ((140, 120, 200), (109, 90, 166), (59, 45, 99)),
    "html": ((220, 131, 69), (179, 98, 45), (96, 52, 20)),
    "code": ((124, 133, 143), (93, 100, 110), (46, 50, 55)),
    "text": ((154, 164, 177), (118, 128, 141), (66, 72, 79)),
    "other": ((124, 133, 143), (93, 100, 110), (46, 50, 55)),
}
_TEXT_THUMBNAIL_TYPES = {"code", "text", "markdown", "html"}

try:  # Optional dependency: if available, render first PDF page thumbnails.
    import fitz  # type: ignore[import-not-found]
except Exception:  # noqa: BLE001
    fitz = None

try:  # Optional fallback ffmpeg binary distributed via wheel.
    import imageio_ffmpeg  # type: ignore[import-not-found]
except Exception:  # noqa: BLE001
    imageio_ffmpeg = None


def _initial_thumbnail_concurrency() -> int:
    raw = os.environ.get("STREAM_THUMBNAIL_MAX_CONCURRENT", "").strip()
    if not raw:
        return THUMBNAIL_GENERATION_DEFAULT_CONCURRENCY
    try:
        parsed = int(raw)
    except (TypeError, ValueError):
        return THUMBNAIL_GENERATION_DEFAULT_CONCURRENCY
    return max(1, min(parsed, 16))


_thumbnail_generation_sem = threading.BoundedSemaphore(_initial_thumbnail_concurrency())
_thumbnail_cache_prune_lock = threading.Lock()
_thumbnail_cache_last_prune = 0.0



def _normalize_thumbnail_size(size: tuple[int, int]) -> tuple[int, int]:
    width = max(THUMBNAIL_MIN_EDGE, min(int(size[0]), THUMBNAIL_MAX_EDGE))
    height = max(THUMBNAIL_MIN_EDGE, min(int(size[1]), THUMBNAIL_MAX_EDGE))
    return width, height


def _thumbnail_label(file_type: str, custom_label: str | None = None) -> str:
    if custom_label:
        label = custom_label.strip().upper()
        if label:
            return label[:8]
    return _THUMBNAIL_LABELS.get(file_type, _THUMBNAIL_LABELS["other"])


def _resolve_ffmpeg_bin() -> str | None:
    env_path = os.environ.get("STREAM_FFMPEG_BIN", "").strip()
    if env_path:
        return env_path

    system_ffmpeg = shutil.which("ffmpeg")
    if system_ffmpeg:
        return system_ffmpeg

    if imageio_ffmpeg is not None:
        try:
            return str(imageio_ffmpeg.get_ffmpeg_exe())
        except Exception:  # noqa: BLE001
            return None

    return None


def _env_int(name: str, default: int, *, minimum: int | None = None, maximum: int | None = None) -> int:
    raw = os.environ.get(name)
    if raw is None:
        value = default
    else:
        try:
            value = int(raw.strip())
        except (TypeError, ValueError):
            value = default
    if minimum is not None and value < minimum:
        value = minimum
    if maximum is not None and value > maximum:
        value = maximum
    return value


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    value = raw.strip().lower()
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False
    return default


def _thumbnail_cache_dir() -> Path:
    raw = os.environ.get("STREAM_THUMBNAIL_CACHE_DIR", "").strip()
    if raw:
        cache_dir = Path(raw).expanduser()
    else:
        cache_dir = Path(tempfile.gettempdir()) / "StreamLocalFiles" / "thumb-cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir


def _thumbnail_cache_ttl_seconds() -> int:
    return _env_int(
        "STREAM_THUMBNAIL_CACHE_TTL_SECONDS",
        THUMBNAIL_DEFAULT_CACHE_TTL_SECONDS,
        minimum=60,
        maximum=24 * 60 * 60,
    )


def _thumbnail_cache_max_bytes() -> int:
    max_mb = _env_int("STREAM_THUMBNAIL_CACHE_MAX_MB", THUMBNAIL_DEFAULT_CACHE_MAX_BYTES // (1024 * 1024), minimum=32, maximum=4096)
    return max_mb * 1024 * 1024


def _thumbnail_cache_path(target: Path, file_type: str, width: int, height: int) -> Path:
    try:
        stats = target.stat()
        stat_signature = f"{stats.st_size}:{stats.st_mtime_ns}"
    except OSError:
        stat_signature = "na"
    key_raw = f"{THUMBNAIL_CACHE_VERSION}|{target.resolve()}|{file_type}|{width}x{height}|{stat_signature}"
    digest = hashlib.sha256(key_raw.encode("utf-8", errors="ignore")).hexdigest()
    cache_dir = _thumbnail_cache_dir() / digest[:2]
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir / f"{digest}.jpg"


def _read_cached_thumbnail(cache_path: Path, ttl_seconds: int) -> bytes | None:
    if not cache_path.exists():
        return None
    try:
        now = time.time()
        age_seconds = now - cache_path.stat().st_mtime
        if age_seconds > ttl_seconds:
            cache_path.unlink(missing_ok=True)
            return None
        return cache_path.read_bytes()
    except OSError:
        return None


def _write_cached_thumbnail(cache_path: Path, payload: bytes) -> None:
    temp_path = cache_path.with_suffix(cache_path.suffix + ".tmp")
    try:
        temp_path.write_bytes(payload)
        temp_path.replace(cache_path)
    except OSError:
        try:
            temp_path.unlink(missing_ok=True)
        except OSError:
            pass


def _prune_thumbnail_cache(ttl_seconds: int, max_bytes: int) -> None:
    global _thumbnail_cache_last_prune
    now = time.time()
    if now - _thumbnail_cache_last_prune < THUMBNAIL_CACHE_PRUNE_INTERVAL_SECONDS:
        return
    with _thumbnail_cache_prune_lock:
        now = time.time()
        if now - _thumbnail_cache_last_prune < THUMBNAIL_CACHE_PRUNE_INTERVAL_SECONDS:
            return
        _thumbnail_cache_last_prune = now

        root = _thumbnail_cache_dir()
        files: list[tuple[float, int, Path]] = []
        total_size = 0
        stale_before = now - ttl_seconds

        for child in root.rglob("*.jpg"):
            try:
                stat = child.stat()
            except OSError:
                continue
            if stat.st_mtime < stale_before:
                try:
                    child.unlink(missing_ok=True)
                except OSError:
                    pass
                continue
            files.append((stat.st_mtime, stat.st_size, child))
            total_size += stat.st_size

        if total_size <= max_bytes:
            return

        files.sort(key=lambda row: row[0])  # oldest first
        for _mtime, size, path in files:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                continue
            total_size -= size
            if total_size <= max_bytes:
                break


def _video_thumbnails_enabled() -> bool:
    return _env_bool("STREAM_ENABLE_VIDEO_THUMBNAILS", True)


@lru_cache(maxsize=384)
def _image_thumbnail_cache(path_key: str, mtime_ns: int, width: int, height: int) -> bytes:
    del mtime_ns
    with Image.open(path_key) as image:
        image = ImageOps.exif_transpose(image)
        image.thumbnail((width, height))
        if image.mode not in ("RGB", "L"):
            image = image.convert("RGB")
        output = io.BytesIO()
        image.save(output, format="JPEG", quality=82, optimize=True)
        return output.getvalue()


@lru_cache(maxsize=192)
def _video_thumbnail_cache(path_key: str, mtime_ns: int, size_bytes: int, width: int, height: int) -> bytes:
    del mtime_ns, size_bytes
    ffmpeg_bin = _resolve_ffmpeg_bin()
    if not ffmpeg_bin:
        raise FileNotFoundError("ffmpeg not available")

    vf = (
        f"thumbnail=120,scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black"
    )
    command = [
        ffmpeg_bin,
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        path_key,
        "-vf",
        vf,
        "-frames:v",
        "1",
        "-f",
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "pipe:1",
    ]
    completed = subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=15,
    )
    if completed.returncode != 0 or not completed.stdout:
        raise OSError("Unable to extract video frame thumbnail")

    with Image.open(io.BytesIO(completed.stdout)) as image:
        image.thumbnail((width, height))
        if image.mode not in ("RGB", "L"):
            image = image.convert("RGB")
        output = io.BytesIO()
        image.save(output, format="JPEG", quality=82, optimize=True)
        return output.getvalue()


@lru_cache(maxsize=96)
def _pdf_thumbnail_cache(path_key: str, mtime_ns: int, width: int, height: int) -> bytes:
    del mtime_ns
    if fitz is None:
        raise FileNotFoundError("PDF thumbnail renderer not installed")

    document = fitz.open(path_key)
    try:
        if document.page_count < 1:
            raise OSError("PDF has no pages")
        page = document.load_page(0)
        matrix = fitz.Matrix(1.5, 1.5)
        pixmap = page.get_pixmap(matrix=matrix, alpha=False)
        image = Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)
    finally:
        document.close()

    try:
        image.thumbnail((width, height))
        output = io.BytesIO()
        image.save(output, format="JPEG", quality=82, optimize=True)
        return output.getvalue()
    finally:
        image.close()


@lru_cache(maxsize=512)
def _placeholder_thumbnail_cache(file_type: str, label: str, width: int, height: int) -> bytes:
    thumb_type = file_type if file_type in _THUMBNAIL_COLORS else "other"
    top_color, bottom_color, accent_color = _THUMBNAIL_COLORS[thumb_type]

    image = Image.new("RGB", (width, height), color=top_color)
    draw = ImageDraw.Draw(image)

    split_y = max(1, int(height * 0.62))
    draw.rectangle((0, split_y, width, height), fill=bottom_color)

    inset = max(6, min(width, height) // 12)
    radius = max(8, min(width, height) // 7)
    border_width = max(2, min(width, height) // 32)
    draw.rounded_rectangle(
        (inset, inset, width - inset, height - inset),
        radius=radius,
        outline=accent_color,
        width=border_width,
    )

    label_text = label[:8].upper()
    font = ImageFont.load_default()
    if hasattr(draw, "textbbox"):
        left, top, right, bottom = draw.textbbox((0, 0), label_text, font=font)
        text_w = right - left
        text_h = bottom - top
    else:
        text_w, text_h = draw.textsize(label_text, font=font)
    text_x = max(0, (width - text_w) // 2)
    text_y = max(0, (height - text_h) // 2)
    draw.text((text_x, text_y), label_text, fill=(244, 247, 250), font=font)

    output = io.BytesIO()
    image.save(output, format="JPEG", quality=82, optimize=True)
    image.close()
    return output.getvalue()


def _strip_controls(value: str) -> str:
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", value)


def _read_text_thumbnail_snippet(path: Path) -> str:
    with path.open("rb") as file_obj:
        raw = file_obj.read(TEXT_THUMBNAIL_MAX_BYTES + 1)
    decoded = raw.decode("utf-8", errors="replace")
    cleaned = _strip_controls(decoded)
    lines = []
    for line in cleaned.splitlines():
        trimmed = line.strip("\r\n")
        if not trimmed:
            continue
        lines.append(trimmed[:TEXT_THUMBNAIL_MAX_LINE_CHARS])
        if len(lines) >= TEXT_THUMBNAIL_MAX_LINES:
            break
    return "\n".join(lines)


@lru_cache(maxsize=320)
def _text_thumbnail_cache(path_key: str, mtime_ns: int, size_bytes: int, file_type: str, width: int, height: int) -> bytes:
    del mtime_ns, size_bytes
    snippet = _read_text_thumbnail_snippet(Path(path_key))
    if not snippet:
        return _placeholder_thumbnail_cache(file_type, _thumbnail_label(file_type), width, height)

    bg = (17, 24, 39)
    if file_type == "markdown":
        bg = (35, 36, 48)
    elif file_type == "html":
        bg = (43, 28, 19)
    image = Image.new("RGB", (width, height), color=bg)
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default()

    header_h = max(18, height // 7)
    header_color = {
        "code": (66, 99, 143),
        "text": (86, 95, 108),
        "markdown": (126, 98, 164),
        "html": (166, 104, 62),
    }.get(file_type, (86, 95, 108))
    draw.rectangle((0, 0, width, header_h), fill=header_color)
    draw.text((8, max(2, (header_h - 10) // 2)), _thumbnail_label(file_type), fill=(242, 246, 251), font=font)

    y = header_h + 6
    for line in snippet.splitlines():
        if y > height - 12:
            break
        draw.text((8, y), line, fill=(218, 226, 236), font=font)
        y += 12

    output = io.BytesIO()
    image.save(output, format="JPEG", quality=82, optimize=True)
    image.close()
    return output.getvalue()


def generate_placeholder_thumbnail_bytes(file_type: str, size: tuple[int, int], *, label: str | None = None) -> bytes:
    width, height = _normalize_thumbnail_size(size)
    thumb_type = file_type if file_type in _THUMBNAIL_LABELS else "other"
    return _placeholder_thumbnail_cache(
        thumb_type,
        _thumbnail_label(thumb_type, label),
        width,
        height,
    )


def generate_text_thumbnail_bytes(target: Path, file_type: str, size: tuple[int, int]) -> bytes:
    width, height = _normalize_thumbnail_size(size)
    stats = target.stat()
    normalized_type = file_type if file_type in _TEXT_THUMBNAIL_TYPES else "text"
    return _text_thumbnail_cache(
        str(target),
        stats.st_mtime_ns,
        stats.st_size,
        normalized_type,
        width,
        height,
    )


def generate_thumbnail_bytes(image_path: Path, size: tuple[int, int]) -> bytes:
    width, height = _normalize_thumbnail_size(size)
    image_stats = image_path.stat()
    return _image_thumbnail_cache(
        str(image_path),
        image_stats.st_mtime_ns,
        width,
        height,
    )


def generate_video_thumbnail_bytes(video_path: Path, size: tuple[int, int]) -> bytes:
    width, height = _normalize_thumbnail_size(size)
    video_stats = video_path.stat()
    return _video_thumbnail_cache(
        str(video_path),
        video_stats.st_mtime_ns,
        video_stats.st_size,
        width,
        height,
    )


def generate_pdf_thumbnail_bytes(pdf_path: Path, size: tuple[int, int]) -> bytes:
    width, height = _normalize_thumbnail_size(size)
    pdf_stats = pdf_path.stat()
    return _pdf_thumbnail_cache(
        str(pdf_path),
        pdf_stats.st_mtime_ns,
        width,
        height,
    )


def generate_file_thumbnail_bytes(target: Path, file_type: str, size: tuple[int, int]) -> bytes:
    if file_type == "video" and not _video_thumbnails_enabled():
        return generate_placeholder_thumbnail_bytes("video", size)
    if file_type == "image":
        return generate_thumbnail_bytes(target, size)
    if file_type == "video":
        try:
            return generate_video_thumbnail_bytes(target, size)
        except (FileNotFoundError, PermissionError, OSError, UnidentifiedImageError, subprocess.TimeoutExpired):
            return generate_placeholder_thumbnail_bytes("video", size)
    if file_type == "pdf":
        try:
            return generate_pdf_thumbnail_bytes(target, size)
        except (FileNotFoundError, PermissionError, OSError, UnidentifiedImageError):
            return generate_placeholder_thumbnail_bytes("pdf", size)
    if file_type == "directory":
        return generate_placeholder_thumbnail_bytes("directory", size)
    if file_type in _TEXT_THUMBNAIL_TYPES:
        try:
            return generate_text_thumbnail_bytes(target, file_type, size)
        except (FileNotFoundError, PermissionError, OSError, UnicodeError):
            return generate_placeholder_thumbnail_bytes(file_type, size)
    return generate_placeholder_thumbnail_bytes(file_type, size)


def generate_cached_thumbnail_bytes(target: Path, file_type: str, size: tuple[int, int]) -> bytes:
    width, height = _normalize_thumbnail_size(size)
    cacheable_types = {"video", "pdf", "word", "excel", "code", "text", "markdown", "html", "directory"}
    uses_cache = file_type in cacheable_types

    ttl_seconds = _thumbnail_cache_ttl_seconds()
    max_bytes = _thumbnail_cache_max_bytes()
    cache_path: Path | None = None
    if uses_cache:
        cache_path = _thumbnail_cache_path(target, file_type, width, height)
        cached = _read_cached_thumbnail(cache_path, ttl_seconds)
        if cached is not None:
            return cached

    heavy_type = file_type in {"video", "pdf"}
    acquired = True
    if heavy_type:
        timeout = _env_int("STREAM_THUMBNAIL_ACQUIRE_TIMEOUT_MS", int(THUMBNAIL_GENERATION_ACQUIRE_TIMEOUT_SECONDS * 1000), minimum=20, maximum=2000) / 1000
        acquired = _thumbnail_generation_sem.acquire(timeout=timeout)
        if not acquired:
            return generate_placeholder_thumbnail_bytes(file_type, (width, height))

    try:
        payload = generate_file_thumbnail_bytes(target, file_type, (width, height))
    finally:
        if heavy_type and acquired:
            _thumbnail_generation_sem.release()

    if uses_cache and cache_path is not None:
        _write_cached_thumbnail(cache_path, payload)
        _prune_thumbnail_cache(ttl_seconds, max_bytes)
    return payload


def iter_transcoded_video_chunks(video_path: Path, *, chunk_size: int = STREAM_CHUNK_BYTES, start_time: float = 0.0):
    ffmpeg_bin = _resolve_ffmpeg_bin()
    if not ffmpeg_bin:
        raise FileNotFoundError("ffmpeg is not available on this host")

    command = [
        ffmpeg_bin,
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
    ]
    if start_time > 0:
        command.extend(["-ss", str(float(start_time))])
        
    command.extend([
        "-i",
        str(video_path),
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-sn",
        "-vf",
        "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-ac",
        "2",
        "-movflags",
        "frag_keyframe+empty_moov+default_base_moof",
        "-f",
        "mp4",
        "pipe:1",
    ])

    process = subprocess.Popen(  # noqa: S603
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    if not process.stdout:
        process.kill()
        raise OSError("Failed to create ffmpeg stream")

    first_chunk = process.stdout.read(chunk_size)
    if not first_chunk:
        process.stdout.close()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=2)
        raise OSError("ffmpeg did not produce output")

    def _generator():
        try:
            yield first_chunk
            while True:
                chunk = process.stdout.read(chunk_size)
                if not chunk:
                    break
                yield chunk
        finally:
            if process.poll() is None:
                process.kill()
            try:
                process.stdout.close()
            except Exception:  # noqa: BLE001
                pass
            try:
                process.wait(timeout=5)
            except Exception:  # noqa: BLE001
                pass

    return _generator()


def get_video_info(video_path: Path) -> dict[str, Any]:
    ffmpeg_bin = _resolve_ffmpeg_bin()
    if not ffmpeg_bin:
        return {"duration": 0}
    ffprobe_bin = ffmpeg_bin.replace("ffmpeg", "ffprobe")
    command = [
        ffprobe_bin,
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        str(video_path)
    ]
    try:
        res = subprocess.run(command, capture_output=True, text=True, timeout=5)
        duration = float(res.stdout.strip())
        return {"duration": duration}
    except Exception:
        return {"duration": 0}

