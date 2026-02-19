const PERSISTED_PROFILE_KEY = "network_coordinator_profile_v2";
const RUNTIME_SESSION_KEY = "network_runtime_session_v2";
const UNKNOWN_SHA256 = "0".repeat(64);
const UPLOAD_CHUNK_BYTES = 1024 * 1024;
const DEVICE_REFRESH_INTERVAL_MS = 30000;
const HIDDEN_DEVICE_REFRESH_INTERVAL_MS = 120000;
const TRANSFER_BACKUP_REFRESH_INTERVAL_MS = 180000;
const WS_PING_INTERVAL_MS = 20000;
const WS_RECONNECT_MAX_DELAY_MS = 12000;
const REMOTE_LIST_MAX_RESULTS = 300;
const REMOTE_SEARCH_MAX_RESULTS = 300;

function sleep(milliseconds) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

function normalizeBaseUrl(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) {
    return "";
  }
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const url = new URL(withProtocol);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "";
  }
}

function escapeHtml(input) {
  return String(input ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sanitizeRemoteUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) {
    return "#";
  }
  try {
    const parsed = new URL(value, window.location.origin);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
  } catch {
    // Fall through to default.
  }
  return "#";
}

function fileFingerprint({ filename, size, sha256 }) {
  return `${filename}::${size}::${String(sha256 || "").toLowerCase()}`;
}

function bytesToLabel(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let index = 0;
  let value = bytes;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function sha256Hex(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (const value of bytes) {
    out += value.toString(16).padStart(2, "0");
  }
  return out;
}

function defaultSession() {
  return {
    baseUrl: "",
    principalId: "",
    clientDeviceId: "",
    deviceSecret: "",
    accessToken: "",
  };
}

export function createNetworkController({
  elements,
  onStatus,
}) {
  const state = {
    session: defaultSession(),
    devices: [],
    shares: [],
    selectedDeviceId: "",
    selectedShareId: "",
    remotePath: "",
    transferRole: "all",
    transfers: [],
    uploadJobs: new Map(),
    transferFiles: new Map(),
    transferDestinations: new Map(),
    refreshTimer: null,
    refreshInFlight: false,
    lastTransferRefreshAt: 0,
    ws: null,
    wsReconnectTimer: null,
    wsReconnectAttempts: 0,
    wsManualClose: false,
    wsPingTimer: null,
  };

  function loadSessionFromStorage() {
    state.session = defaultSession();

    const persistedRaw = localStorage.getItem(PERSISTED_PROFILE_KEY);
    if (persistedRaw) {
      try {
        const parsed = JSON.parse(persistedRaw);
        state.session.baseUrl = normalizeBaseUrl(parsed.baseUrl);
        state.session.principalId = String(parsed.principalId || "");
        state.session.clientDeviceId = String(parsed.clientDeviceId || "");
      } catch {
        localStorage.removeItem(PERSISTED_PROFILE_KEY);
      }
    }

    const runtimeRaw = sessionStorage.getItem(RUNTIME_SESSION_KEY);
    if (runtimeRaw) {
      try {
        const parsed = JSON.parse(runtimeRaw);
        state.session.deviceSecret = String(parsed.deviceSecret || "");
      } catch {
        sessionStorage.removeItem(RUNTIME_SESSION_KEY);
      }
    }
  }

  function saveSessionProfile() {
    const profile = {
      baseUrl: state.session.baseUrl,
      principalId: state.session.principalId,
      clientDeviceId: state.session.clientDeviceId,
    };
    localStorage.setItem(PERSISTED_PROFILE_KEY, JSON.stringify(profile));
  }

  function saveRuntimeSession() {
    const runtime = {
      deviceSecret: state.session.deviceSecret,
    };
    sessionStorage.setItem(RUNTIME_SESSION_KEY, JSON.stringify(runtime));
  }

  function clearSessionStorage() {
    localStorage.removeItem(PERSISTED_PROFILE_KEY);
    sessionStorage.removeItem(RUNTIME_SESSION_KEY);
  }

  function syncSessionForm() {
    elements.coordUrl.value = state.session.baseUrl;
    elements.principalId.value = state.session.principalId;
    elements.clientDeviceId.value = state.session.clientDeviceId;
    elements.deviceSecret.value = state.session.deviceSecret;
  }

  function readSessionForm() {
    state.session.baseUrl = normalizeBaseUrl(elements.coordUrl.value);
    state.session.principalId = String(elements.principalId.value || "").trim();
    state.session.clientDeviceId = String(elements.clientDeviceId.value || "").trim();
    state.session.deviceSecret = String(elements.deviceSecret.value || "").trim();
  }

  function setSessionStatus(message, kind = "neutral") {
    elements.sessionStatus.textContent = message;
    elements.sessionStatus.classList.remove("error", "success");
    if (kind === "error") {
      elements.sessionStatus.classList.add("error");
    } else if (kind === "success") {
      elements.sessionStatus.classList.add("success");
    }
  }

  function setPairingStatus(message, kind = "neutral") {
    elements.pairingStatus.textContent = message;
    elements.pairingStatus.classList.remove("error", "success");
    if (kind === "error") {
      elements.pairingStatus.classList.add("error");
    } else if (kind === "success") {
      elements.pairingStatus.classList.add("success");
    }
  }

  async function requestJson(path, { method = "GET", body, auth = true } = {}) {
    if (!state.session.baseUrl) {
      throw new Error("Coordinator URL is required");
    }
    const headers = {
      Accept: "application/json",
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (auth) {
      if (!state.session.accessToken) {
        throw new Error("Connect first to get a coordinator token");
      }
      headers.authorization = `Bearer ${state.session.accessToken}`;
    }

    const response = await fetch(`${state.session.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const contentType = response.headers.get("content-type") || "";
    const isJson = contentType.includes("application/json");
    const payload = isJson ? await response.json() : null;
    if (response.status === 401) {
      if (auth) {
        state.session.accessToken = "";
        closeEventsSocket({ allowReconnect: false });
      }
      throw new Error((payload && (payload.detail || payload.error)) || "Coordinator authentication failed");
    }
    if (!response.ok) {
      throw new Error((payload && (payload.detail || payload.error)) || `Request failed (${response.status})`);
    }
    if (!payload) {
      throw new Error("Unexpected coordinator response");
    }
    return payload;
  }

  async function connectSession() {
    readSessionForm();
    if (!state.session.baseUrl) {
      throw new Error("Coordinator URL is invalid");
    }
    if (!state.session.principalId || !state.session.clientDeviceId || !state.session.deviceSecret) {
      throw new Error("Principal ID, Client Device ID, and Device Secret are required");
    }

    const tokenPayload = await requestJson("/api/v1/auth/token", {
      method: "POST",
      auth: false,
      body: {
        principal_id: state.session.principalId,
        client_device_id: state.session.clientDeviceId,
        device_secret: state.session.deviceSecret,
      },
    });
    state.session.accessToken = tokenPayload.access_token;
    state.session.principalId = tokenPayload.principal_id;
    state.session.clientDeviceId = tokenPayload.client_device_id;
    saveSessionProfile();
    saveRuntimeSession();
    syncSessionForm();
    setSessionStatus("Connected", "success");
  }

  async function bootstrapOrStartPairing() {
    readSessionForm();
    if (!state.session.baseUrl) {
      throw new Error("Coordinator URL is invalid");
    }

    const displayName = String(elements.pairDisplayName.value || "").trim();
    const deviceName = String(elements.pairDeviceName.value || "").trim();
    if (!displayName || !deviceName) {
      throw new Error("Display name and device name are required");
    }

    const payload = await requestJson("/api/v1/pairing/start", {
      method: "POST",
      auth: false,
      body: {
        display_name: displayName,
        device_name: deviceName,
        platform: navigator.platform || "browser",
        public_key: null,
      },
    });

    if (payload.bootstrap) {
      state.session.principalId = payload.principal_id;
      state.session.clientDeviceId = payload.client_device_id;
      state.session.deviceSecret = payload.device_secret;
      state.session.accessToken = payload.access_token;
      saveSessionProfile();
      saveRuntimeSession();
      syncSessionForm();
      setPairingStatus("Bootstrap complete. Credentials saved.", "success");
      setSessionStatus("Connected", "success");
      return;
    }

    elements.pairPendingId.value = payload.pending_pairing_id || "";
    elements.pairCode.value = payload.pairing_code || "";
    setPairingStatus("Pairing request created. Share ID/code with trusted session.", "success");
  }

  async function confirmPairing() {
    const pendingId = String(elements.pairPendingId.value || "").trim();
    const pairingCode = String(elements.pairCode.value || "").trim();
    if (!pendingId || !pairingCode) {
      throw new Error("Pending pairing ID and pairing code are required");
    }
    if (!state.session.accessToken) {
      throw new Error("Connect with an authorized session first");
    }

    const payload = await requestJson("/api/v1/pairing/confirm", {
      method: "POST",
      auth: true,
      body: {
        pending_pairing_id: pendingId,
        pairing_code: pairingCode,
      },
    });

    state.session.principalId = payload.principal_id;
    state.session.clientDeviceId = payload.client_device_id;
    state.session.deviceSecret = payload.device_secret;
    state.session.accessToken = payload.access_token;
    saveSessionProfile();
    saveRuntimeSession();
    syncSessionForm();
    setPairingStatus("Pairing confirmed and credentials updated.", "success");
    setSessionStatus("Connected", "success");
  }

  async function refreshDevicesAndShares() {
    const previousDeviceId = state.selectedDeviceId;
    const previousShareId = state.selectedShareId;

    const devicesPayload = await requestJson("/api/v1/catalog/devices");
    state.devices = devicesPayload.devices || [];
    if (!state.selectedDeviceId || !state.devices.some((item) => item.id === state.selectedDeviceId)) {
      state.selectedDeviceId = state.devices[0]?.id || "";
    }
    renderDeviceList();
    renderSendDeviceOptions();

    if (state.selectedDeviceId) {
      const sharesPayload = await requestJson(`/api/v1/catalog/shares?device_id=${encodeURIComponent(state.selectedDeviceId)}`);
      state.shares = sharesPayload.shares || [];
    } else {
      state.shares = [];
    }
    if (!state.selectedShareId || !state.shares.some((item) => item.id === state.selectedShareId)) {
      state.selectedShareId = state.shares[0]?.id || "";
    }
    renderShareList();
    renderSendShareOptions();

    const selectionChanged = previousDeviceId !== state.selectedDeviceId || previousShareId !== state.selectedShareId;
    if (selectionChanged && state.selectedDeviceId && state.selectedShareId) {
      try {
        await loadRemoteDirectory("");
      } catch {
        // Ignore remote refresh errors during background device updates.
      }
    }
  }

  async function refreshTransfers() {
    const payload = await requestJson(`/api/v1/transfers?role=${encodeURIComponent(state.transferRole)}`);
    state.transfers = payload.transfers || [];
    state.lastTransferRefreshAt = Date.now();
    renderTransferList();
  }

  async function refreshAll({ includeTransfers = false, force = false } = {}) {
    if (state.refreshInFlight && !force) {
      return;
    }
    state.refreshInFlight = true;
    if (!state.session.accessToken) {
      renderDeviceList();
      renderShareList();
      renderTransferList();
      if (elements.remoteList) {
        elements.remoteList.innerHTML = `<div class="list-item"><p class="list-item-meta">Connect to coordinator to browse remote files.</p></div>`;
      }
      state.refreshInFlight = false;
      return;
    }
    try {
      await refreshDevicesAndShares();
      const shouldRefreshTransfers = includeTransfers || Date.now() - state.lastTransferRefreshAt >= TRANSFER_BACKUP_REFRESH_INTERVAL_MS;
      if (shouldRefreshTransfers) {
        await refreshTransfers();
      }
    } finally {
      state.refreshInFlight = false;
    }
  }

  function renderDeviceList() {
    if (!elements.deviceList) {
      return;
    }
    if (!state.devices.length) {
      elements.deviceList.innerHTML = `<div class="list-item"><p class="list-item-meta">No devices discovered.</p></div>`;
      return;
    }

    elements.deviceList.innerHTML = state.devices
      .map((device) => {
        const selected = device.id === state.selectedDeviceId;
        const isOwner = device.owner_principal_id === state.session.principalId;
        const onlineClass = device.online ? "online" : "offline";
        const onlineText = device.online ? "Online" : "Offline";
        return `
          <div class="list-item ${selected ? "selected" : ""}" data-device-id="${escapeHtml(device.id)}">
            <div class="list-item-head">
              <p class="list-item-title">${escapeHtml(device.name)}</p>
              <span class="pill ${onlineClass}">${onlineText}</span>
            </div>
            <p class="list-item-meta">${escapeHtml(device.id)}</p>
            <div class="transfer-actions">
              <button type="button" data-action="select-device" data-device-id="${escapeHtml(device.id)}">Select</button>
              ${
                isOwner
                  ? `<button type="button" data-action="toggle-visibility" data-device-id="${escapeHtml(device.id)}" data-visible="${device.visible ? "1" : "0"}">${device.visible ? "Hide" : "Show"}</button>`
                  : ""
              }
            </div>
          </div>
        `;
      })
      .join("");
  }

  function renderShareList() {
    if (!elements.shareList) {
      return;
    }
    if (!state.shares.length) {
      elements.shareList.innerHTML = `<div class="list-item"><p class="list-item-meta">No accessible shares.</p></div>`;
      return;
    }
    elements.shareList.innerHTML = state.shares
      .map((share) => {
        const selected = share.id === state.selectedShareId;
        return `
          <div class="list-item ${selected ? "selected" : ""}">
            <div class="list-item-head">
              <p class="list-item-title">${escapeHtml(share.name)}</p>
              <span class="pill ${share.device_online ? "online" : "offline"}">${share.device_online ? "Online" : "Offline"}</span>
            </div>
            <p class="list-item-meta">${escapeHtml((share.permissions || []).join(", "))}</p>
            <div class="transfer-actions">
              <button type="button" data-action="select-share" data-share-id="${escapeHtml(share.id)}">Use</button>
            </div>
          </div>
        `;
      })
      .join("");
  }

  function renderSendDeviceOptions() {
    if (!elements.sendDevice) {
      return;
    }
    if (!state.devices.length) {
      elements.sendDevice.innerHTML = `<option value="">No devices</option>`;
      return;
    }

    const options = state.devices
      .map((device) => {
        const selected = state.selectedDeviceId === device.id ? " selected" : "";
        return `<option value="${escapeHtml(device.id)}"${selected}>${escapeHtml(device.name)} (${device.online ? "online" : "offline"})</option>`;
      })
      .join("");
    elements.sendDevice.innerHTML = options;
  }

  function renderSendShareOptions() {
    if (!elements.sendShare) {
      return;
    }
    if (!state.shares.length) {
      elements.sendShare.innerHTML = `<option value="">No shares</option>`;
      return;
    }
    const options = state.shares
      .map((share) => {
        const selected = share.id === state.selectedShareId ? " selected" : "";
        return `<option value="${escapeHtml(share.id)}"${selected}>${escapeHtml(share.name)} (${escapeHtml((share.permissions || []).join("/") || "none")})</option>`;
      })
      .join("");
    elements.sendShare.innerHTML = options;
  }

  function renderRemoteList(payload, query = "") {
    if (!elements.remoteList) {
      return;
    }
    const items = payload?.items || [];
    const parentPath = payload?.parent_path ?? payload?.base_path ?? "";
    const truncated = Boolean(payload?.truncated);
    const limit = Number(payload?.limit || REMOTE_LIST_MAX_RESULTS);
    if (!items.length) {
      const text = query ? "No matches in remote share." : "No files for this path.";
      elements.remoteList.innerHTML = `<div class="list-item"><p class="list-item-meta">${escapeHtml(text)}</p></div>`;
      return;
    }

    const parentButton = parentPath !== null
      ? `<div class="list-item"><div class="transfer-actions"><button type="button" data-action="remote-open-path" data-path="${escapeHtml(parentPath || "")}">Open Parent</button></div></div>`
      : "";

    const rows = items
      .map((item) => {
        const itemPath = item.path || "";
        const isDir = Boolean(item.is_dir);
        const previewUrl = sanitizeRemoteUrl(item.stream_url || "");
        const downloadUrl = sanitizeRemoteUrl(item.download_url || "");
        const actions = isDir
          ? `<button type="button" data-action="remote-open-path" data-path="${escapeHtml(itemPath)}">Open</button>`
          : `<a href="${escapeHtml(previewUrl)}" target="_blank" rel="noopener noreferrer nofollow">Preview</a>
             ${downloadUrl !== "#" ? `<a href="${escapeHtml(downloadUrl)}" target="_blank" rel="noopener noreferrer nofollow">Download</a>` : ""}`;
        return `
          <div class="list-item">
            <div class="list-item-head">
              <p class="list-item-title">${escapeHtml(item.name || "(unnamed)")}</p>
              <span class="pill">${escapeHtml(isDir ? "DIR" : (item.type || "file").toUpperCase())}</span>
            </div>
            <p class="list-item-meta">${escapeHtml(itemPath)}</p>
            <div class="transfer-actions">${actions}</div>
          </div>
        `;
      })
      .join("");

    const limitNote = truncated
      ? `<div class="list-item"><p class="list-item-meta">Showing first ${escapeHtml(String(limit))} entries for speed. Refine path/search for more.</p></div>`
      : "";
    elements.remoteList.innerHTML = `${limitNote}${parentButton}${rows}`;
  }

  async function loadRemoteDirectory(pathOverride = null) {
    if (!state.session.accessToken || !state.selectedDeviceId || !state.selectedShareId) {
      if (elements.remoteList) {
        elements.remoteList.innerHTML = `<div class="list-item"><p class="list-item-meta">Select a device/share to browse remotely.</p></div>`;
      }
      return;
    }
    const targetPath = pathOverride !== null ? String(pathOverride) : String(elements.remotePath?.value || state.remotePath || "");
    state.remotePath = targetPath;
    if (elements.remotePath) {
      elements.remotePath.value = targetPath;
    }

    const payload = await requestJson(
      `/api/v1/files/list?device_id=${encodeURIComponent(state.selectedDeviceId)}&share_id=${encodeURIComponent(state.selectedShareId)}&path=${encodeURIComponent(targetPath)}&max_results=${encodeURIComponent(String(REMOTE_LIST_MAX_RESULTS))}`,
    );
    renderRemoteList(payload, "");
  }

  async function runRemoteSearch() {
    if (!state.session.accessToken || !state.selectedDeviceId || !state.selectedShareId) {
      throw new Error("Connect and select a device/share first");
    }
    const query = String(elements.remoteSearch?.value || "").trim();
    if (!query) {
      await loadRemoteDirectory();
      return;
    }

    const payload = await requestJson(
      `/api/v1/files/search?device_id=${encodeURIComponent(state.selectedDeviceId)}&share_id=${encodeURIComponent(state.selectedShareId)}&q=${encodeURIComponent(query)}&path=${encodeURIComponent(String(elements.remotePath?.value || ""))}&recursive=1&max_results_per_share=${encodeURIComponent(String(REMOTE_SEARCH_MAX_RESULTS))}&max_results_total=${encodeURIComponent(String(REMOTE_SEARCH_MAX_RESULTS))}`,
    );
    renderRemoteList(payload, query);
  }

  function transferDirection(transfer) {
    return transfer.sender_principal_id === state.session.principalId ? "outgoing" : "incoming";
  }

  function renderTransferList() {
    if (!elements.transferList) {
      return;
    }
    if (!state.transfers.length) {
      elements.transferList.innerHTML = `<div class="list-item"><p class="list-item-meta">No transfers for this filter.</p></div>`;
      return;
    }

    const html = state.transfers
      .map((transfer) => {
        const direction = transferDirection(transfer);
        const job = state.uploadJobs.get(transfer.id);
        const itemList = (transfer.items || [])
          .map((item) => `${escapeHtml(item.filename)} (${escapeHtml(item.state)})`)
          .join("</li><li>");

        let actions = "";
        if (direction === "incoming" && transfer.state === "pending_receiver_approval") {
          actions = `
            <div class="transfer-actions">
              <input class="passcode-input" type="password" inputmode="numeric" maxlength="4" placeholder="4-digit PIN" aria-label="Approval PIN" />
              <button type="button" data-action="approve-transfer" data-transfer-id="${escapeHtml(transfer.id)}">Approve</button>
              <button type="button" data-action="reject-transfer" data-transfer-id="${escapeHtml(transfer.id)}">Reject</button>
            </div>
          `;
        } else if (
          direction === "outgoing" &&
          (transfer.state === "approved_pending_sender_passcode" || transfer.state === "passcode_open")
        ) {
          actions = `
            <div class="transfer-actions">
              <input class="passcode-input" type="password" inputmode="numeric" maxlength="4" placeholder="4-digit PIN" aria-label="Sender PIN" />
              <button type="button" data-action="open-upload" data-transfer-id="${escapeHtml(transfer.id)}">Open + Upload</button>
              ${
                job
                  ? `<button type="button" data-action="${job.paused ? "resume-upload" : "pause-upload"}" data-transfer-id="${escapeHtml(transfer.id)}">${job.paused ? "Resume" : "Pause"}</button>`
                  : ""
              }
            </div>
          `;
        }

        return `
          <div class="list-item" data-transfer-id="${escapeHtml(transfer.id)}">
            <div class="list-item-head">
              <p class="list-item-title">${escapeHtml(direction === "incoming" ? "Incoming" : "Outgoing")} • ${escapeHtml(transfer.state)}</p>
              <span class="pill">${escapeHtml(transfer.id.slice(0, 8))}</span>
            </div>
            <ul class="transfer-items"><li>${itemList || "No items"}</li></ul>
            ${actions}
          </div>
        `;
      })
      .join("");
    elements.transferList.innerHTML = html;
  }

  function renderUploadJobs() {
    if (!elements.uploadJobs) {
      return;
    }
    const jobs = [...state.uploadJobs.values()];
    if (!jobs.length) {
      elements.uploadJobs.innerHTML = `<div class="list-item"><p class="list-item-meta">No active uploads.</p></div>`;
      return;
    }

    elements.uploadJobs.innerHTML = jobs
      .map((job) => {
        const percent = Math.max(0, Math.min(100, Math.round(job.progress * 100)));
        return `
          <div class="list-item" data-upload-transfer-id="${escapeHtml(job.transferId)}">
            <div class="list-item-head">
              <p class="list-item-title">${escapeHtml(job.label)}</p>
              <span class="pill">${percent}%</span>
            </div>
            <p class="list-item-meta">${escapeHtml(job.message)}</p>
            <div class="job-progress"><span style="width:${percent}%"></span></div>
            <div class="transfer-actions">
              <button type="button" data-action="${job.paused ? "resume-upload" : "pause-upload"}" data-transfer-id="${escapeHtml(job.transferId)}">${job.paused ? "Resume" : "Pause"}</button>
            </div>
          </div>
        `;
      })
      .join("");
  }

  async function hashFile(file, index, total) {
    if (file.size > 64 * 1024 * 1024) {
      setSessionStatus(`Preparing ${file.name} (${index + 1}/${total})...`);
      return UNKNOWN_SHA256;
    }
    if (!window.crypto || !window.crypto.subtle) {
      return UNKNOWN_SHA256;
    }
    setSessionStatus(`Hashing ${file.name} (${index + 1}/${total})...`);
    const buffer = await file.arrayBuffer();
    const hashBuffer = await window.crypto.subtle.digest("SHA-256", buffer);
    return sha256Hex(hashBuffer);
  }

  async function createTransferRequest() {
    if (!state.session.accessToken) {
      throw new Error("Connect to coordinator first");
    }
    const receiverDeviceId = String(elements.sendDevice.value || "").trim();
    const receiverShareId = String(elements.sendShare.value || "").trim();
    const files = [...(elements.sendFiles.files || [])];

    if (!receiverDeviceId || !receiverShareId) {
      throw new Error("Select a target device and share");
    }
    if (!files.length) {
      throw new Error("Select at least one file");
    }

    const items = [];
    const localFileMap = new Map();
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const sha256 = await hashFile(file, index, files.length);
      const item = {
        filename: file.name,
        size: file.size,
        sha256,
        mime_type: file.type || null,
      };
      items.push(item);
      localFileMap.set(fileFingerprint(item), file);
    }

    const transfer = await requestJson("/api/v1/transfers", {
      method: "POST",
      body: {
        receiver_device_id: receiverDeviceId,
        receiver_share_id: receiverShareId,
        items,
      },
    });

    state.transferFiles.set(transfer.id, localFileMap);
    state.transferDestinations.set(transfer.id, String(elements.sendDestination.value || "").trim());
    elements.sendFiles.value = "";
    setSessionStatus("Transfer request created.", "success");
    await refreshTransfers();
  }

  async function openUploadWindow(transferId, passcode) {
    if (!passcode || !/^\d{4}$/.test(passcode)) {
      throw new Error("Enter a valid 4-digit PIN");
    }
    return requestJson(`/api/v1/transfers/${encodeURIComponent(transferId)}/passcode/open`, {
      method: "POST",
      body: { passcode },
    });
  }

  async function agentJson(url, { method = "GET", body, headers } = {}) {
    const response = await fetch(url, {
      method,
      headers,
      body,
    });
    const contentType = response.headers.get("content-type") || "";
    const isJson = contentType.includes("application/json");
    const payload = isJson ? await response.json() : null;
    if (!response.ok) {
      throw new Error((payload && (payload.detail || payload.error)) || `Agent request failed (${response.status})`);
    }
    return payload || {};
  }

  function buildAgentTransferUrl(uploadBaseUrl, action, query) {
    const params = new URLSearchParams(query);
    return `${uploadBaseUrl}/${action}?${params.toString()}`;
  }

  async function processUploadJob(transfer, uploadOpenPayload) {
    const transferId = transfer.id;
    const files = state.transferFiles.get(transferId);
    if (!files) {
      throw new Error("Local files are unavailable for this transfer. Recreate request with selected files.");
    }

    const uploadBaseUrl = uploadOpenPayload.upload_base_url;
    const uploadTicket = uploadOpenPayload.upload_ticket;
    const receiverShareId = uploadOpenPayload.transfer.receiver_share_id;
    const destinationPath = state.transferDestinations.get(transferId) || "";
    const totalBytes = (transfer.items || []).reduce((sum, item) => sum + Number(item.size || 0), 0);

    state.uploadJobs.set(transferId, {
      transferId,
      label: transferId.slice(0, 8),
      message: "Preparing upload...",
      progress: 0,
      paused: false,
      uploadBaseUrl,
      uploadTicket,
      receiverShareId,
      totalBytes,
      uploadedBytes: 0,
    });
    renderUploadJobs();

    const job = state.uploadJobs.get(transferId);
    if (!job) {
      return;
    }
    let completed = false;
    try {
      for (const item of transfer.items || []) {
        const signature = fileFingerprint(item);
        const file = files.get(signature);
        if (!file) {
          throw new Error(`Missing local file for ${item.filename}`);
        }

        const statusPayload = await agentJson(
          buildAgentTransferUrl(uploadBaseUrl, "status", {
            share_id: receiverShareId,
            ticket: uploadTicket,
          }),
        );
        const knownItem = (statusPayload.items || []).find((entry) => entry.item_id === item.id);
        let offset = Number(knownItem?.received_size || 0);
        job.uploadedBytes = Math.max(job.uploadedBytes, offset);
        job.message = `Uploading ${item.filename} (${bytesToLabel(offset)} / ${bytesToLabel(file.size)})`;
        job.progress = totalBytes ? Math.min(1, job.uploadedBytes / totalBytes) : 0;
        renderUploadJobs();

        while (offset < file.size) {
          if (job.paused) {
            await sleep(260);
            continue;
          }
          const nextOffset = Math.min(offset + UPLOAD_CHUNK_BYTES, file.size);
          const chunk = file.slice(offset, nextOffset);
          const response = await fetch(
            buildAgentTransferUrl(uploadBaseUrl, "chunk", {
              share_id: receiverShareId,
              item_id: item.id,
              filename: item.filename,
              size: String(item.size),
              sha256: item.sha256,
              ticket: uploadTicket,
            }),
            {
              method: "POST",
              headers: {
                "x-chunk-offset": String(offset),
                "x-chunk-last": nextOffset >= file.size ? "1" : "0",
              },
              body: chunk,
            },
          );
          if (!response.ok) {
            let detail = `Chunk upload failed (${response.status})`;
            try {
              const payload = await response.json();
              detail = payload.detail || payload.error || detail;
            } catch {
              // keep default detail
            }
            throw new Error(detail);
          }

          offset = nextOffset;
          job.uploadedBytes = Math.min(totalBytes, job.uploadedBytes + chunk.size);
          job.message = `Uploading ${item.filename} (${bytesToLabel(offset)} / ${bytesToLabel(file.size)})`;
          job.progress = totalBytes ? Math.min(1, job.uploadedBytes / totalBytes) : 0;
          renderUploadJobs();
        }

        await agentJson(
          buildAgentTransferUrl(uploadBaseUrl, "commit", {
            share_id: receiverShareId,
            item_id: item.id,
            ticket: uploadTicket,
          }),
          { method: "POST" },
        );

        await agentJson(
          buildAgentTransferUrl(uploadBaseUrl, "finalize", {
            share_id: receiverShareId,
            ticket: uploadTicket,
          }),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              item_id: item.id,
              destination_path: destinationPath,
              keep_original_name: true,
            }),
          },
        );
        job.message = `Completed ${item.filename}`;
        renderUploadJobs();
      }

      job.progress = 1;
      job.message = "Upload completed";
      renderUploadJobs();
      completed = true;
      await refreshTransfers();
    } catch (error) {
      job.message = "Upload failed. Recreate request to retry.";
      renderUploadJobs();
      throw error;
    } finally {
      state.transferFiles.delete(transferId);
      state.transferDestinations.delete(transferId);
      const removeAfterMs = completed ? 12000 : 20000;
      window.setTimeout(() => {
        state.uploadJobs.delete(transferId);
        renderUploadJobs();
      }, removeAfterMs);
    }
  }

  async function setTransferPaused(transferId, paused) {
    const job = state.uploadJobs.get(transferId);
    if (!job) {
      return;
    }
    job.paused = paused;
    renderUploadJobs();
    const action = paused ? "pause" : "resume";
    await agentJson(
      buildAgentTransferUrl(job.uploadBaseUrl, action, {
        share_id: job.receiverShareId,
        ticket: job.uploadTicket,
      }),
      { method: "POST" },
    );
  }

  async function handleTransferAction(event) {
    const actionButton = event.target.closest("button[data-action]");
    if (!actionButton) {
      return;
    }
    const action = actionButton.dataset.action;
    const transferId = actionButton.dataset.transferId;
    if (!transferId) {
      return;
    }
    const transferNode = actionButton.closest("[data-transfer-id]");
    const passcodeInput = transferNode?.querySelector(".passcode-input");
    const passcode = String(passcodeInput?.value || "").trim();

    try {
      if (action === "approve-transfer") {
        if (!/^\d{4}$/.test(passcode)) {
          throw new Error("Approve requires a valid 4-digit PIN");
        }
        await requestJson(`/api/v1/transfers/${encodeURIComponent(transferId)}/approve`, {
          method: "POST",
          body: { passcode },
        });
        await refreshTransfers();
        return;
      }

      if (action === "reject-transfer") {
        await requestJson(`/api/v1/transfers/${encodeURIComponent(transferId)}/reject`, {
          method: "POST",
          body: { reason: "" },
        });
        await refreshTransfers();
        return;
      }

      if (action === "open-upload") {
        const transfer = state.transfers.find((item) => item.id === transferId);
        if (!transfer) {
          throw new Error("Transfer not found");
        }
        const openPayload = await openUploadWindow(transferId, passcode);
        await processUploadJob(transfer, openPayload);
        return;
      }

      if (action === "pause-upload") {
        await setTransferPaused(transferId, true);
        return;
      }
      if (action === "resume-upload") {
        await setTransferPaused(transferId, false);
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Transfer action failed";
      setSessionStatus(message, "error");
      onStatus?.(message, true);
    }
  }

  async function handleDeviceAction(event) {
    const button = event.target.closest("button[data-action]");
    if (!button) {
      return;
    }
    const action = button.dataset.action;
    const deviceId = button.dataset.deviceId;
    if (!deviceId) {
      return;
    }

    try {
      if (action === "select-device") {
        state.selectedDeviceId = deviceId;
        await refreshDevicesAndShares();
        await refreshTransfers();
        return;
      }
      if (action === "toggle-visibility") {
        const nextVisible = button.dataset.visible !== "1";
        await requestJson(`/api/v1/catalog/devices/${encodeURIComponent(deviceId)}/visibility`, {
          method: "POST",
          body: { visible: nextVisible },
        });
        await refreshDevicesAndShares();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Device action failed";
      setSessionStatus(message, "error");
      onStatus?.(message, true);
    }
  }

  async function handleShareAction(event) {
    const button = event.target.closest("button[data-action='select-share']");
    if (!button) {
      return;
    }
    const shareId = button.dataset.shareId;
    if (!shareId) {
      return;
    }
    state.selectedShareId = shareId;
    renderShareList();
    renderSendShareOptions();
    await loadRemoteDirectory("");
  }

  async function handleRemoteAction(event) {
    const button = event.target.closest("button[data-action='remote-open-path']");
    if (!button) {
      return;
    }
    const path = String(button.dataset.path || "");
    try {
      await loadRemoteDirectory(path);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed loading remote path";
      setSessionStatus(message, "error");
      onStatus?.(message, true);
    }
  }

  function syncTransferRoleTabs() {
    for (const button of elements.transferRoleButtons) {
      const role = button.dataset.role || "all";
      const active = role === state.transferRole;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    }
  }

  function setTransferRole(role) {
    state.transferRole = role;
    syncTransferRoleTabs();
  }

  function stopWsPing() {
    if (state.wsPingTimer) {
      window.clearInterval(state.wsPingTimer);
      state.wsPingTimer = null;
    }
  }

  function startWsPing(socket) {
    stopWsPing();
    state.wsPingTimer = window.setInterval(() => {
      if (state.ws !== socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      try {
        socket.send("ping");
      } catch {
        // Ignore intermittent ping errors.
      }
    }, WS_PING_INTERVAL_MS);
  }

  function clearWsReconnectTimer() {
    if (state.wsReconnectTimer) {
      window.clearTimeout(state.wsReconnectTimer);
      state.wsReconnectTimer = null;
    }
  }

  function scheduleWsReconnect() {
    if (state.wsManualClose || !state.session.accessToken) {
      return;
    }
    clearWsReconnectTimer();
    const attempt = state.wsReconnectAttempts;
    const delay = Math.min(WS_RECONNECT_MAX_DELAY_MS, 500 * (2 ** attempt));
    const jitter = Math.floor(Math.random() * 300);
    state.wsReconnectTimer = window.setTimeout(async () => {
      state.wsReconnectTimer = null;
      try {
        await openEventsSocket();
      } catch {
        // openEventsSocket handles retries.
      }
    }, delay + jitter);
    state.wsReconnectAttempts += 1;
  }

  function closeEventsSocket({ allowReconnect = false } = {}) {
    state.wsManualClose = !allowReconnect;
    clearWsReconnectTimer();
    stopWsPing();
    if (state.ws) {
      const activeSocket = state.ws;
      state.ws = null;
      try {
        activeSocket.close();
      } catch {
        // Ignore close failures.
      }
    }
    if (!allowReconnect) {
      state.wsReconnectAttempts = 0;
    }
  }

  async function fetchEventsWsToken() {
    const payload = await requestJson("/api/v1/events/token");
    return String(payload.ws_token || "");
  }

  async function openEventsSocket() {
    closeEventsSocket({ allowReconnect: true });
    if (!state.session.baseUrl || !state.session.accessToken) {
      return;
    }

    const wsToken = await fetchEventsWsToken();
    if (!wsToken) {
      throw new Error("Unable to obtain websocket token");
    }

    const wsUrl = state.session.baseUrl.replace(/^http/i, "ws");
    const socket = new WebSocket(`${wsUrl}/api/v1/events/ws`, ["stream-v1", `auth.${wsToken}`]);
    state.wsManualClose = false;
    state.ws = socket;
    socket.onopen = () => {
      state.wsReconnectAttempts = 0;
      startWsPing(socket);
    };
    socket.onmessage = async (event) => {
      let payload = null;
      try {
        payload = JSON.parse(event.data);
      } catch {
        payload = null;
      }
      if (!payload || typeof payload !== "object") {
        return;
      }
      if (typeof payload.type === "string" && payload.type.startsWith("transfer_")) {
        try {
          await refreshTransfers();
        } catch {
          // Transfer polling backup handles intermittent failures.
        }
      }
    };
    socket.onerror = () => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.close();
      }
    };
    socket.onclose = () => {
      if (state.ws === socket) {
        state.ws = null;
      }
      stopWsPing();
      scheduleWsReconnect();
    };
  }

  async function connectAndRefresh() {
    await connectSession();
    try {
      await openEventsSocket();
    } catch {
      scheduleWsReconnect();
    }
    await refreshAll({ includeTransfers: true, force: true });
  }

  function getRefreshIntervalMs() {
    return document.visibilityState === "hidden"
      ? HIDDEN_DEVICE_REFRESH_INTERVAL_MS
      : DEVICE_REFRESH_INTERVAL_MS;
  }

  function scheduleRefreshLoop() {
    if (state.refreshTimer) {
      window.clearTimeout(state.refreshTimer);
      state.refreshTimer = null;
    }
    const tick = async () => {
      state.refreshTimer = window.setTimeout(async () => {
        if (state.session.accessToken) {
          try {
            await refreshAll();
          } catch {
            // no-op
          }
        }
        await tick();
      }, getRefreshIntervalMs());
    };
    tick();
  }

  function bindEvents() {
    elements.connectButton.addEventListener("click", async () => {
      try {
        await connectAndRefresh();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Connection failed";
        setSessionStatus(message, "error");
        onStatus?.(message, true);
      }
    });

    elements.saveSettingsButton.addEventListener("click", () => {
      const previousIdentity = `${state.session.baseUrl}|${state.session.principalId}|${state.session.clientDeviceId}`;
      readSessionForm();
      if (!state.session.baseUrl) {
        setSessionStatus("Invalid coordinator URL", "error");
        return;
      }
      const nextIdentity = `${state.session.baseUrl}|${state.session.principalId}|${state.session.clientDeviceId}`;
      saveSessionProfile();
      saveRuntimeSession();
      if (previousIdentity !== nextIdentity) {
        state.session.accessToken = "";
        closeEventsSocket({ allowReconnect: false });
      }
      setSessionStatus("Settings saved", "success");
    });

    elements.clearSettingsButton.addEventListener("click", () => {
      closeEventsSocket({ allowReconnect: false });
      state.session = defaultSession();
      state.devices = [];
      state.shares = [];
      state.transfers = [];
      state.uploadJobs.clear();
      state.transferFiles.clear();
      state.transferDestinations.clear();
      clearSessionStorage();
      syncSessionForm();
      renderDeviceList();
      renderShareList();
      renderTransferList();
      renderUploadJobs();
      setSessionStatus("Settings cleared");
    });

    elements.pairStartButton.addEventListener("click", async () => {
      try {
        await bootstrapOrStartPairing();
        if (state.session.accessToken) {
          try {
            await openEventsSocket();
          } catch {
            scheduleWsReconnect();
          }
          await refreshAll({ includeTransfers: true, force: true });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Pairing start failed";
        setPairingStatus(message, "error");
        onStatus?.(message, true);
      }
    });

    elements.pairConfirmButton.addEventListener("click", async () => {
      try {
        await confirmPairing();
        try {
          await openEventsSocket();
        } catch {
          scheduleWsReconnect();
        }
        await refreshAll({ includeTransfers: true, force: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Pairing confirmation failed";
        setPairingStatus(message, "error");
        onStatus?.(message, true);
      }
    });

    elements.networkRefresh.addEventListener("click", async () => {
      try {
        await refreshAll({ includeTransfers: true, force: true });
        setSessionStatus("Refreshed", "success");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Refresh failed";
        setSessionStatus(message, "error");
      }
    });

    elements.sendDevice.addEventListener("change", async () => {
      state.selectedDeviceId = String(elements.sendDevice.value || "");
      try {
        await refreshDevicesAndShares();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed loading shares";
        setSessionStatus(message, "error");
      }
    });

    elements.sendShare.addEventListener("change", async () => {
      state.selectedShareId = String(elements.sendShare.value || "");
      renderShareList();
      try {
        await loadRemoteDirectory("");
      } catch {
        // ignore single refresh errors
      }
    });

    elements.remoteLoadButton.addEventListener("click", async () => {
      try {
        await loadRemoteDirectory();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to load remote directory";
        setSessionStatus(message, "error");
        onStatus?.(message, true);
      }
    });

    elements.remoteRunSearchButton.addEventListener("click", async () => {
      try {
        await runRemoteSearch();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Remote search failed";
        setSessionStatus(message, "error");
        onStatus?.(message, true);
      }
    });

    elements.sendRequestButton.addEventListener("click", async () => {
      try {
        await createTransferRequest();
        onStatus?.("Transfer request created", false);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to create transfer";
        setSessionStatus(message, "error");
        onStatus?.(message, true);
      }
    });

    elements.transferRoleButtons.forEach((button) => {
      button.addEventListener("click", async () => {
        setTransferRole(button.dataset.role || "all");
        try {
          await refreshTransfers();
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed loading transfers";
          setSessionStatus(message, "error");
        }
      });
      button.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight"].includes(event.key)) {
          return;
        }
        event.preventDefault();
        const items = elements.transferRoleButtons;
        if (!items.length) {
          return;
        }
        const currentIndex = items.indexOf(button);
        if (currentIndex < 0) {
          return;
        }
        const delta = event.key === "ArrowRight" ? 1 : -1;
        const nextIndex = (currentIndex + delta + items.length) % items.length;
        items[nextIndex].focus();
      });
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && state.session.accessToken) {
        refreshAll({ force: true }).catch(() => {
          // no-op
        });
      }
    });

    elements.deviceList.addEventListener("click", (event) => {
      handleDeviceAction(event);
    });
    elements.shareList.addEventListener("click", (event) => {
      handleShareAction(event);
    });
    elements.remoteList.addEventListener("click", (event) => {
      handleRemoteAction(event);
    });
    elements.transferList.addEventListener("click", (event) => {
      handleTransferAction(event);
    });
    elements.uploadJobs.addEventListener("click", (event) => {
      handleTransferAction(event);
    });
  }

  async function init() {
    loadSessionFromStorage();
    syncSessionForm();
    bindEvents();
    setTransferRole(state.transferRole);
    scheduleRefreshLoop();

    const hasProfile = state.session.baseUrl && state.session.principalId && state.session.clientDeviceId;
    if (hasProfile && state.session.deviceSecret) {
      try {
        await connectAndRefresh();
      } catch {
        setSessionStatus("Saved profile found. Connect to refresh session.");
      }
    } else if (hasProfile) {
      setSessionStatus("Saved profile found. Enter device secret, then connect.");
    } else {
      setSessionStatus("Configure coordinator session to enable network features.");
    }
    renderDeviceList();
    renderShareList();
    renderTransferList();
    renderUploadJobs();
  }

  return {
    init,
  };
}
