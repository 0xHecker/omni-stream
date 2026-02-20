# Stream Local Architecture

This system is a LAN-first package with three services:

- `web` (`stream_server`, Flask): browser UI, setup/login, local explorer, multi-hub proxy
- `coordinator` (FastAPI): identity, pairing, ACL, transfer orchestration, events
- `agent` (FastAPI): share data plane, transfer inbox, chunk commit/finalize

In packaged mode, one launcher process starts all three services on a machine.

## 1) Node Model

Each machine is a self-contained LAN hub.

```text
+------------------------------------------------------------------+
| Machine X                                                        |
|                                                                  |
| stream-local                                                     |
|   +--> web          :5000  (UI + setup/login + hub proxy)       |
|   +--> coordinator  :7000  (control plane)                      |
|   +--> agent        :7001  (data plane)                         |
|                                                                  |
| shared folder (configured locally in /setup)                    |
+------------------------------------------------------------------+
```

On a LAN, multiple machines run the same stack:

```text
 +----------------+      +----------------+      +----------------+
 | Hub A          |<---->| Hub B          |<---->| Hub C          |
 | web:5000       |      | web:5000       |      | web:5000       |
 | coord:7000     |      | coord:7000     |      | coord:7000     |
 | agent:7001     |      | agent:7001     |      | agent:7001     |
 +----------------+      +----------------+      +----------------+
```

## 2) Multi-Hub Explorer Architecture (Web Layer)

The web service supports a merged device-root UI across multiple hubs.

### Device discovery

Discovery pipeline in `stream_server/services/hub_proxy.py`:

1. Start with local hub metadata.
2. Discover coordinator hosts on LAN.
3. Convert each coordinator host into candidate web URL (`host:WEB_PORT`).
4. Add explicit `STREAM_HUB_HINTS` (if provided).
5. Probe `GET /api/hub/meta` on candidates.
6. Keep only valid `stream-web-hub` responses.

### Session model

Per browser session:

- `active_hub_id`: currently selected device hub
- `unlocked_hub_ids`: remote hubs unlocked with PIN
- `hub_browser_id`: key namespace for cached remote HTTP clients

### Hub API surface

- `GET /api/hub/meta` (public metadata for discovery)
- `GET /api/hubs` (discovered hubs + lock status + active hub)
- `POST /api/hubs/select`
- `POST /api/hubs/unlock`
- `POST /api/hubs/lock`

### Request routing

Explorer endpoints keep stable URLs (`/list`, `/search`, `/stream`, ...).

Routing rule:

- if active hub is local: serve local filesystem path
- if active hub is remote: proxy request to remote hub endpoint

```text
Browser
  -> Local Hub Web (/list)
      if active_hub = local:
         -> local file service
      else:
         -> remote hub /list via proxy client
  <- JSON response with unchanged schema
```

This preserves frontend compatibility while adding multi-device context.

## 3) Per-Device PIN Authentication Flow

Remote hubs are authenticated independently.

```text
User selects remote hub B
  -> POST /api/hubs/select
  -> if locked: 409, UI opens PIN modal
  -> POST /api/hubs/unlock {hub_id, pin}
     -> proxy posts pin to remote /login
     -> proxy probes remote /list
     -> on success: mark hub unlocked + set active_hub_id
  -> explorer calls proceed against hub B
```

PIN rotation or remote session expiry::

```text
Remote returns auth failure (401 or redirect to /login)
  -> local hub proxy marks that hub locked
  -> active_hub_id is cleared if it was that hub
  -> endpoint responds 409 ("PIN expired...unlock again")
  -> UI returns to device-root context
```

Lock invalidation is isolated to that hub only.

## 4) Security Boundaries

### Local-only setup controls

- `/setup` modifies local machine settings only:
  - local shared folder
  - local login PIN
- No remote setup/config mutation endpoints are exposed through hub selector UI.

### Access controls

- Web explorer access requires local session auth (`require_pin`).
- Remote hub access requires per-device unlock state.
- Coordinator and agent enforce ACL/ticket model for distributed transfer/file APIs.

### Session isolation

- Remote unlock state is scoped to browser session, not global process state.
- Logging out clears local auth session and per-browser remote proxy clients.

## 5) Coordinator/Agent Data Plane

Coordinator and agent remain the control/data plane for transfer and ACL-governed operations.

### Read/Search (coordinator/agent path)

```text
Client
  -> Coordinator /api/v1/files/list|search
     -> ACL check + signed read ticket
     -> Agent list/search with ticket
     -> aggregate response
  <- items + URLs
```

### Transfer path

```text
Sender -> Coordinator: create transfer
Receiver -> Coordinator: approve/reject
Sender -> Coordinator: open passcode window
Sender -> Receiver Agent: chunk upload (resumable)
Receiver Agent: commit -> finalize to destination folder
Coordinator: lifecycle/events broadcast
```

Agent responsibilities:

- serve share operations behind ticket checks
- accept chunk uploads with offset validation
- pause/resume, commit, checksum/size verification
- finalize to destination folder with safe path handling

## 6) Performance and Operational Behavior

- Process split avoids one service blocking others.
- Discovery is cached with short TTL to limit probe overhead.
- Remote hub proxy uses persistent `httpx` clients per browser session + hub.
- Thumbnail generation uses memory/disk caching and bounded concurrency.
- Binary proxy forwards range requests (`Range` / `Content-Range`) to support seekable media streaming across hubs.

## 7) Default Ports

- Web UI: `5000`
- Coordinator: `7000`
- Agent: `7001`

When defaults are used on all hosts, LAN merge and URL sharing work without additional routing rules.
