# Stream Local Files on Same Network

Stream Local is a LAN file-sharing package that combines:

- A web file explorer (`stream_server`, Flask)
- A coordinator control plane (`coordinator`, FastAPI)
- A device agent data plane (`agent`, FastAPI)

The packaged binary can run all services together, so each machine becomes a self-contained LAN hub.

Quick architecture reference: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

## Core Capabilities

- Local setup flow for each machine (`/setup`) to define:
  - shared folder
  - local PIN (4-12 digits)
- Local login flow (`/login`) for browser access control
- Auto-discovery of hubs on the same LAN
- Multi-device explorer UI:
  - first view shows discovered LAN devices as folder-like entries
  - each remote device unlocks with its own PIN
  - unlock state is remembered per device in the current browser session
  - if a remote PIN changes, only that device is relocked
- Browse, search, preview, stream, and download across local and remote hubs
- Transfer orchestration with coordinator + agent (request/approve/upload/finalize)

## Platform Artifacts

Release artifacts are platform-specific:

- Windows: `stream-local.exe`
- macOS: `stream-local`
- Linux: `stream-local`

Each artifact is built for its target operating system and architecture.

## How It Works on a LAN

### 1) Per-Machine Runtime

```text
+-------------------------------------------------------------------+
| Machine N                                                         |
|                                                                   |
|  stream-local (single launcher)                                   |
|    |                                                              |
|    +--> Web UI        :5000  (setup/login/explorer)              |
|    +--> Coordinator   :7000  (discovery/authz/transfers/events)  |
|    +--> Agent         :7001  (share access/upload inbox)         |
|                                                                   |
|  Shared Folder <---- configured in /setup for this machine        |
+-------------------------------------------------------------------+
```

### 2) Multi-Machine Hub Merge

```text
                          Same LAN

 +----------------+     +----------------+     +----------------+
 | Host A         |     | Host B         |     | Host C         |
 | Web:5000       |<--->| Web:5000       |<--->| Web:5000       |
 | Coord:7000     |<--->| Coord:7000     |<--->| Coord:7000     |
 | Agent:7001     |     | Agent:7001     |     | Agent:7001     |
 +----------------+     +----------------+     +----------------+
         ^
         |
   Browser on Host A
   "Devices" root shows: [Host A] [Host B] [Host C]
```

### 3) Open Remote Device (Per-Device PIN)

```text
User selects "Host B" in Devices root
  -> local web calls POST /api/hubs/select (Host B)
  -> if locked: UI opens PIN modal
  -> local web calls POST /api/hubs/unlock {hub_id, pin}
  -> local web validates by logging into Host B and probing /list
  -> Host B marked unlocked for this browser session
  -> existing explorer calls (/list, /search, /stream, ...) proxy to Host B
```

### 4) PIN Rotation Handling

```text
If Host B PIN changes:
  remote call returns auth failure
    -> local hub session for Host B is invalidated
    -> Host B is relocked
    -> browser returns to Devices/root context
Other unlocked hubs remain unlocked.
```

## Quick Start (Packaged Binary)

1. Download the binary for your OS.
2. Run it.
3. Open `http://<your-lan-ip>:5000/` (auto-open is enabled by default).
4. Complete `/setup` on that machine:
   - choose the shared folder
   - set the local PIN
5. Log in and use the explorer.

The **Open On Other Devices** panel provides copy-ready LAN URLs.

### Local Settings and Logs

Settings file:

- Windows: `%APPDATA%\StreamLocalFiles\settings.json`
- macOS: `~/Library/Application Support/StreamLocalFiles/settings.json`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/StreamLocalFiles/settings.json`

Startup error logs:

- Windows: `%APPDATA%\StreamLocalFiles\logs\startup-error-*.log`
- macOS: `~/Library/Application Support/StreamLocalFiles/logs/startup-error-*.log`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/StreamLocalFiles/logs/startup-error-*.log`

## Multi-Machine LAN Runbook

Use this when you want each machine to expose its own folder and PIN.

1. Install and run the app on each machine (A/B/C).
2. Keep default ports unless you have a routing constraint:
   - Web `5000`
   - Coordinator `7000`
   - Agent `7001`
3. On each machine, complete `/setup` with that machine's folder and PIN.
4. From any machine's browser, open the app and go to **Devices**.
5. Select a device:
   - unlocked device opens immediately
   - locked device prompts for that device's PIN
6. Use **Back to Devices** to switch between machines.

### Network Requirements

- Machines must be on the same reachable LAN segment.
- Host firewall rules must allow inbound traffic to `5000`, `7000`, and `7001`.
- For auto-discovery, use the same web port across machines (default `5000`).
- If you run non-standard ports, provide explicit hints with `STREAM_HUB_HINTS`.

## Security Model

- Setup actions are local-only:
  - changing folder/PIN is allowed only on the local coordinator
  - remote coordinator settings are not exposed for mutation in UI
- Remote unlock state is scoped per browser session and per device.
- Device relock is isolated:
  - remote auth failure invalidates only that device session
  - other device sessions remain active
- Coordinator/agent paths enforce ACL and signed ticket checks for remote operations.

## Run from Source

### Prerequisites

- Python 3.11+
- `uv` (recommended)

### Setup

1. Bootstrap environment:
   - Windows: `powershell -ExecutionPolicy Bypass -File scripts/bootstrap.ps1`
   - macOS/Linux: `bash scripts/bootstrap.sh`
2. Sync dependencies (if needed): `uv sync --frozen`

### Start Services

- Web only: `python app.py --service web`
- Coordinator only: `python app.py --service coordinator`
- Agent only: `python app.py --service agent`
- All services (recommended for local hub): `python app.py --service all`

Defaults:

- Source mode defaults to `web`
- Packaged binary defaults to `all`

## Build Binaries

Local build for current OS:

1. `uv sync --frozen`
2. `uv run python scripts/build_binary.py`
3. Output in `dist/` (`stream-local` or `stream-local.exe`)

CI build/publish pipelines are defined in:

- `.github/workflows/build-binaries.yml`
- `.github/workflows/semver-tag.yml`

## Test

- `python -m pytest -q`

## High-Level API Surface

Explorer and hub endpoints (web):

- `GET /api/hub/meta`
- `GET /api/hubs`
- `GET /api/discovery/coordinators`
- `POST /api/hubs/select`
- `POST /api/hubs/unlock`
- `POST /api/hubs/lock`
- `GET /list`
- `GET /search`
- `GET /stream`
- `GET /stream_transcode`
- `GET /download`
- `GET /thumbnail`
- `GET /video_info`
- `GET /get_adjacent_file`

Coordinator and agent APIs are documented in code and `docs/ARCHITECTURE.md`.
