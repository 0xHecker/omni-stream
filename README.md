# Distributed LAN File Access (Coordinator + Agent)

This repo contains three production services:

- `coordinator/`: control plane (identity, pairing, ACL, transfer orchestration, events).
- `agent/`: data plane on each sharing device (read/search/stream/download + inbox transfers).
- `stream_server/`: web UI and local file browsing service.

## One-Click Binaries (No Python Required)

For non-coders, use the prebuilt binary for your OS:

- Windows: `stream-local.exe`
- macOS: `stream-local`
- Linux: `stream-local`

Important: there is no single universal binary for all OSes. Each OS needs its own native binary format.  
This repo ships a self-contained binary per OS (no Python install required).
AppImage is Linux-only, so the default release strategy is native binaries for all three desktop OSes.

### First Run UX

1. Launch the binary.
2. Browser opens automatically.
3. Complete `/setup` once:
   - choose shared folder
   - set 4-12 digit PIN
4. Log in and use the app.

Settings are saved locally to:

- Windows: `%APPDATA%\\StreamLocalFiles\\settings.json`
- macOS: `~/Library/Application Support/StreamLocalFiles/settings.json`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/StreamLocalFiles/settings.json`

If startup fails, the app now writes a crash log to:

- Windows: `%APPDATA%\\StreamLocalFiles\\logs\\startup-error-*.log`
- macOS: `~/Library/Application Support/StreamLocalFiles/logs/startup-error-*.log`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/StreamLocalFiles/logs/startup-error-*.log`

No manual environment variables are required for this flow.

## Services

- Coordinator: `python coordinator_app.py` (default `:7000`)
- Agent: `python agent_app.py` (default `:7001`)
- Web UI: `python app.py --service web` (default `:5000`)
- Unified launcher: `python app.py --service all` (starts coordinator + agent + web in dedicated processes)

## Build Binaries

Local build (current OS only):

1. `uv sync --frozen`
2. `uv run python scripts/build_binary.py`
3. Output: `dist/stream-local` (or `dist/stream-local.exe` on Windows)

CI multi-OS build:

- GitHub Actions workflow: `.github/workflows/build-binaries.yml`
- Runs on every commit push (all branches/tags) and on manual dispatch.
- Builds and packages native binaries for Windows, macOS, and Linux.
- Uses pinned tool versions and lockfile sync for reproducible builds.
- Smoke-tests the built binary before packaging.
- On every push, publishes binaries to rolling `edge` release assets.
- On `v*` tags, publishes immutable versioned release assets.
- On every push, publishes a GHCR package so binaries are visible under the repo `Packages` tab.
- Uses shell-only steps (no external marketplace `uses:` actions), which fits orgs that only allow owner-scoped actions.

GitHub Packages target:

- `ghcr.io/<owner>/<repo>-binaries:edge` (latest commit on branch pushes)
- `ghcr.io/<owner>/<repo>-binaries:sha-<commit12>` (immutable commit build)
- `ghcr.io/<owner>/<repo>-binaries:<tag>` and `:latest` on version tags

## SemVer Automation

Semantic versioning is controlled by `pyproject.toml` `version`.

- Manual local bump:
  - `python scripts/bump_semver.py --bump patch`
  - `python scripts/bump_semver.py --bump minor`
  - `python scripts/bump_semver.py --bump major`
  - `python scripts/bump_semver.py --bump prerelease --prerelease-label rc`

- GitHub automated bump + tag:
  - Workflow: `.github/workflows/semver-tag.yml`
  - Runs automatically on every push to `master` (`patch` bump).
  - Can also be run manually from Actions tab with custom bump type.
  - It updates `pyproject.toml`, commits, creates `vX.Y.Z` tag, and pushes.
  - Tag push triggers `.github/workflows/build-binaries.yml` to build packages and publish release assets.

## Core Features Implemented

- Multi-device principal pairing and device-bound credentials.
- Share-level ACL checks (`read`, `download`, `request_send`, `accept_incoming`, `manage_share`).
- Visible/hidden device mode.
- Federated file search across accessible shares.
- Transfer lifecycle:
  - request -> receiver approve/reject
  - receiver sets 4-digit passcode
  - sender opens passcode window
  - resumable chunk upload to receiver inbox
  - commit (size verify + SHA-256 verify when provided)
  - finalize to selected folder
- Pausable transfer streams:
  - `POST /agent/v1/inbox/transfers/{transfer_id}/pause`
  - `POST /agent/v1/inbox/transfers/{transfer_id}/resume`
  - `GET /agent/v1/inbox/transfers/{transfer_id}/status`

## Quick Start

1. Bootstrap environment (installs Python + uv + dependencies if missing):
   - Windows (PowerShell): `powershell -ExecutionPolicy Bypass -File scripts/bootstrap.ps1`
   - macOS/Linux: `bash scripts/bootstrap.sh`
   - If system Python is missing, bootstrap installs a uv-managed Python 3.11 runtime (sandboxed) and uses that.
   - Note: auto-install may require admin/sudo privileges and internet access.
   - Bootstrap sync uses `uv sync --frozen` for reproducible installs.
2. Copy env defaults:
   - `copy .env.example .env` (Windows)
   - `cp .env.example .env` (macOS/Linux)
3. Replace placeholder secrets/PINs in `.env` before starting services.
   - For local-only smoke tests, you can temporarily set `ALLOW_INSECURE_DEFAULTS=1`.
4. Start coordinator:
   - `python coordinator_app.py`
5. Bootstrap first principal:
   - `POST /api/v1/pairing/start`
   - First call auto-creates principal + first client device.
6. Set agent env:
   - `AGENT_OWNER_PRINCIPAL_ID` to the bootstrap principal.
   - `AGENT_PUBLIC_BASE_URL` reachable by other LAN clients.
   - `AGENT_DEFAULT_SHARE_ROOT` to local shared folder.
7. Start agent:
   - `python agent_app.py`
   - Agent auto-registers and sends heartbeats to coordinator.

## Runtime Performance Controls

- Coordinator process model:
  - `COORDINATOR_WORKERS` (uvicorn worker processes)
  - `COORDINATOR_SYNC_THREAD_TOKENS` (thread slots for sync I/O handlers)
  - `COORDINATOR_SEARCH_WORKERS` (shared federated-search executor threads)
- Agent process model:
  - `AGENT_WORKERS`
  - `AGENT_SYNC_THREAD_TOKENS`
- Web process model:
  - `WEB_THREADS` (Waitress worker threads)
  - `WEB_CONNECTION_LIMIT`
- Thumbnail controls:
  - `STREAM_ENABLE_VIDEO_THUMBNAILS=1|0`
  - `STREAM_THUMBNAIL_CACHE_DIR` (optional temp cache path)
  - `STREAM_THUMBNAIL_CACHE_TTL_SECONDS`
  - `STREAM_THUMBNAIL_CACHE_MAX_MB`
  - `STREAM_THUMBNAIL_MAX_CONCURRENT`
  - `STREAM_THUMBNAIL_ACQUIRE_TIMEOUT_MS`
  - `STREAM_FFMPEG_BIN` (optional explicit ffmpeg path)

Defaults are tuned for low memory + high read throughput and can be raised per host.
`imageio-ffmpeg` is bundled as a fallback ffmpeg runtime when system ffmpeg is not present.

## Coordinator API (high-level)

- Pairing:
  - `POST /api/v1/pairing/start`
  - `POST /api/v1/pairing/confirm`
- Auth:
  - `POST /api/v1/auth/token`
  - `GET /api/v1/auth/me`
- Catalog:
  - `GET /api/v1/catalog/devices`
  - `GET /api/v1/catalog/shares`
- Files:
  - `GET /api/v1/files/list`
  - `GET /api/v1/files/search`
- Transfers:
  - `POST /api/v1/transfers`
  - `GET /api/v1/transfers/{id}`
  - `POST /api/v1/transfers/{id}/approve`
  - `POST /api/v1/transfers/{id}/reject`
  - `POST /api/v1/transfers/{id}/passcode/open`
- Events:
  - `GET /api/v1/events/token`
  - `GET /api/v1/events/ws` (WebSocket)

## Pause/Resume Upload Flow

After `POST /api/v1/transfers/{id}/passcode/open`, use returned:
- `upload_base_url`
- `upload_ticket`

For each file item:
1. Stream chunks to:
   - `POST {upload_base_url}/chunk?share_id=...&item_id=...&filename=...&size=...&sha256=...&ticket=...`
   - Set headers:
     - `x-chunk-offset: <current_offset>`
     - `x-chunk-last: 1` on final chunk
2. Pause anytime:
   - `POST {upload_base_url}/pause?share_id=...&ticket=...`
3. Resume:
   - `POST {upload_base_url}/resume?share_id=...&ticket=...`
4. Read offsets:
   - `GET {upload_base_url}/status?share_id=...&ticket=...`
5. Commit:
   - `POST {upload_base_url}/commit?share_id=...&item_id=...&ticket=...`
6. Finalize into destination:
   - `POST {upload_base_url}/finalize?share_id=...&ticket=...`

## Notes

- Tickets are short-lived and signed by coordinator secret.
- WebSocket auth uses short-lived event tokens (bearer-authenticated token endpoint + subprotocol transport).
- Passcode windows are Argon2-hashed with lockout on repeated failures.
- Device visibility hide mode removes devices from discovery for non-owners.

## Test

- Run backend smoke tests:
  - `python -m pytest -q`
