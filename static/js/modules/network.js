const PERSISTED_PROFILE_KEY = "network_coordinator_profile_v2";
const RUNTIME_SESSION_KEY = "network_runtime_session_v2";
const UNKNOWN_SHA256 = "0".repeat(64);
const UPLOAD_CHUNK_BYTES = 1024 * 1024;
const MAX_TRANSFER_ITEMS_PER_REQUEST = 200;
const DEVICE_REFRESH_INTERVAL_MS = 10000;
const HIDDEN_DEVICE_REFRESH_INTERVAL_MS = 60000;
const TRANSFER_BACKUP_REFRESH_INTERVAL_MS = 10000;
const WS_PING_INTERVAL_MS = 20000;
const WS_RECONNECT_MAX_DELAY_MS = 12000;
const REMOTE_LIST_MAX_RESULTS = 300;
const REMOTE_SEARCH_MAX_RESULTS = 300;
const COORDINATOR_PROBE_TIMEOUT_MS = 1200;
const COORDINATOR_REQUEST_TIMEOUT_MS = 12000;
const AGENT_REQUEST_TIMEOUT_MS = 15000;
const DISCOVERY_CACHE_TTL_MS = 15000;
const RECOVERY_MIN_INTERVAL_MS = 10000;
const MAX_COORDINATOR_CANDIDATES = 16;
const MAX_REFRESH_FAILURES = 3;
const MAX_WS_RECONNECT_ATTEMPTS_BEFORE_RECOVERY = 4;

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

function randomPasscode() {
  return String(Math.floor(Math.random() * 9000) + 1000);
}

function parseTransferPreferences(transfer) {
  const fallback = {
    destinationPath: "",
    autoPasscode: "",
  };
  const raw = String(transfer?.reason || "").trim();
  if (!raw) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return fallback;
    }
    if (String(parsed.kind || "") !== "receiver_preferences") {
      return fallback;
    }
    return {
      destinationPath: String(parsed.destination_path || "").trim(),
      autoPasscode: String(parsed.auto_passcode || "").trim(),
    };
  } catch {
    return fallback;
  }
}

function normalizeFsPath(pathValue) {
  return String(pathValue || "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/\/+$/, "");
}

function toShareRelativePath(shareRootPath, selectedPath) {
  const rootRaw = normalizeFsPath(shareRootPath);
  const targetRaw = normalizeFsPath(selectedPath);
  if (!rootRaw || !targetRaw) {
    return null;
  }

  const rootLower = rootRaw.toLowerCase();
  const targetLower = targetRaw.toLowerCase();
  if (targetLower === rootLower) {
    return "";
  }
  if (!targetLower.startsWith(`${rootLower}/`)) {
    return null;
  }
  return targetRaw.slice(rootRaw.length + 1);
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
  const transferRoleButtons = Array.isArray(elements.transferRoleButtons) ? elements.transferRoleButtons : [];

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
    quickSendQueued: false,
    recoverPromise: null,
    consecutiveRefreshFailures: 0,
    lastRecoveryAttemptAt: 0,
    coordinatorCandidates: [],
    lastDiscoveryAt: 0,
    shareRootById: new Map(),
    incomingModalTransferId: "",
    incomingModalQueued: [],
    incomingDismissedTransferIds: new Set(),
    autoUploadOpenedTransferIds: new Set(),
  };

  function getDefaultDatasetValue(key) {
    return String(elements.networkRoot?.dataset?.[key] || "").trim();
  }

  function getInputValue(inputElement, fallback = "") {
    if (!inputElement) {
      return String(fallback || "").trim();
    }
    const value = String(inputElement.value || "").trim();
    return value || String(fallback || "").trim();
  }

  function setInputValue(inputElement, value) {
    if (inputElement) {
      inputElement.value = value;
    }
  }

  function uniqueNormalizedUrls(values) {
    const output = [];
    const seen = new Set();
    for (const rawValue of values || []) {
      const normalized = normalizeBaseUrl(rawValue);
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      output.push(normalized);
      if (output.length >= MAX_COORDINATOR_CANDIDATES) {
        break;
      }
    }
    return output;
  }

  function currentIdentitySnapshot() {
    return {
      principalId: String(state.session.principalId || "").trim(),
      clientDeviceId: String(state.session.clientDeviceId || "").trim(),
      deviceSecret: String(state.session.deviceSecret || "").trim(),
    };
  }

  function hasIdentity(snapshot) {
    return Boolean(snapshot?.principalId && snapshot?.clientDeviceId && snapshot?.deviceSecret);
  }

  function restoreIdentity(snapshot) {
    state.session.principalId = String(snapshot?.principalId || "").trim();
    state.session.clientDeviceId = String(snapshot?.clientDeviceId || "").trim();
    state.session.deviceSecret = String(snapshot?.deviceSecret || "").trim();
  }

  function shouldAttemptRecovery() {
    return Date.now() - state.lastRecoveryAttemptAt >= RECOVERY_MIN_INTERVAL_MS;
  }

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

    if (!state.session.baseUrl) {
      const defaultCoordinatorUrl = normalizeBaseUrl(
        elements.coordUrl?.dataset.defaultUrl || getDefaultDatasetValue("defaultCoordinatorUrl"),
      );
      if (defaultCoordinatorUrl) {
        state.session.baseUrl = defaultCoordinatorUrl;
      }
    }

    if (!state.session.principalId) {
      state.session.principalId = String(
        elements.principalId?.dataset.defaultValue || getDefaultDatasetValue("defaultPrincipalId"),
      ).trim();
    }
    if (!state.session.clientDeviceId) {
      state.session.clientDeviceId = String(
        elements.clientDeviceId?.dataset.defaultValue || getDefaultDatasetValue("defaultClientDeviceId"),
      ).trim();
    }
    if (!state.session.deviceSecret) {
      state.session.deviceSecret = String(
        elements.deviceSecret?.dataset.defaultValue || getDefaultDatasetValue("defaultDeviceSecret"),
      ).trim();
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
    setInputValue(elements.coordUrl, state.session.baseUrl);
    setInputValue(elements.principalId, state.session.principalId);
    setInputValue(elements.clientDeviceId, state.session.clientDeviceId);
    setInputValue(elements.deviceSecret, state.session.deviceSecret);
  }

  function readSessionForm() {
    state.session.baseUrl = normalizeBaseUrl(getInputValue(
      elements.coordUrl,
      state.session.baseUrl || getDefaultDatasetValue("defaultCoordinatorUrl"),
    ));
    state.session.principalId = getInputValue(
      elements.principalId,
      state.session.principalId || getDefaultDatasetValue("defaultPrincipalId"),
    );
    state.session.clientDeviceId = getInputValue(
      elements.clientDeviceId,
      state.session.clientDeviceId || getDefaultDatasetValue("defaultClientDeviceId"),
    );
    state.session.deviceSecret = getInputValue(
      elements.deviceSecret,
      state.session.deviceSecret || getDefaultDatasetValue("defaultDeviceSecret"),
    );
  }

  function setSessionStatus(message, kind = "neutral") {
    if (!elements.sessionStatus) {
      return;
    }
    elements.sessionStatus.textContent = message;
    elements.sessionStatus.classList.remove("error", "success");
    if (kind === "error") {
      elements.sessionStatus.classList.add("error");
    } else if (kind === "success") {
      elements.sessionStatus.classList.add("success");
    }
  }

  function setPairingStatus(message, kind = "neutral") {
    if (!elements.pairingStatus) {
      setSessionStatus(message, kind);
      return;
    }
    elements.pairingStatus.textContent = message;
    elements.pairingStatus.classList.remove("error", "success");
    if (kind === "error") {
      elements.pairingStatus.classList.add("error");
    } else if (kind === "success") {
      elements.pairingStatus.classList.add("success");
    }
  }

  function coordinatorErrorMessage(responseStatus, payload) {
    if (payload && typeof payload === "object") {
      const detail = payload.detail;
      if (typeof detail === "string" && detail.trim()) {
        return detail.trim();
      }
      if (Array.isArray(detail) && detail.length) {
        const first = detail[0];
        if (first && typeof first === "object") {
          const loc = Array.isArray(first.loc) ? first.loc.join(".") : "";
          const msg = String(first.msg || "Validation error");
          return loc ? `${loc}: ${msg}` : msg;
        }
        return String(detail[0] || "Validation error");
      }
      if (typeof payload.error === "string" && payload.error.trim()) {
        return payload.error.trim();
      }
    }
    return `Request failed (${responseStatus})`;
  }

  async function requestJson(path, { method = "GET", body, auth = true, timeoutMs } = {}) {
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

    const controller = new AbortController();
    const requestTimeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : COORDINATOR_REQUEST_TIMEOUT_MS;
    const timeout = window.setTimeout(() => controller.abort(), requestTimeout);
    let response;
    try {
      response = await fetch(`${state.session.baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error("Coordinator request timed out");
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }

    const contentType = response.headers.get("content-type") || "";
    const isJson = contentType.includes("application/json");
    const payload = isJson ? await response.json() : null;
    if (response.status === 401) {
      if (auth) {
        state.session.accessToken = "";
        closeEventsSocket({ allowReconnect: false });
      }
      throw new Error(coordinatorErrorMessage(response.status, payload) || "Coordinator authentication failed");
    }
    if (!response.ok) {
      throw new Error(coordinatorErrorMessage(response.status, payload));
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

  async function bootstrapOrStartPairing({ autoJoin = false } = {}) {
    readSessionForm();
    if (!state.session.baseUrl) {
      throw new Error("Coordinator URL is invalid");
    }

    const fallbackLabel = (window.navigator?.platform || "LAN Device").slice(0, 60);
    const displayName = String(elements.pairDisplayName?.value || "").trim() || fallbackLabel;
    const deviceName = String(elements.pairDeviceName?.value || "").trim() || fallbackLabel;
    const query = autoJoin ? "?auto_join=1" : "";

    const payload = await requestJson(`/api/v1/pairing/start${query}`, {
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
      setPairingStatus(autoJoin ? "Auto-join complete." : "Bootstrap complete. Credentials saved.", "success");
      setSessionStatus("Connected", "success");
      return;
    }

    if (elements.pairPendingId) {
      elements.pairPendingId.value = payload.pending_pairing_id || "";
    }
    if (elements.pairCode) {
      elements.pairCode.value = payload.pairing_code || "";
    }
    setPairingStatus("Pairing request created. Share ID/code with trusted session.", "success");
  }

  async function probeCoordinatorBaseUrl(baseUrl) {
    const normalized = normalizeBaseUrl(baseUrl);
    if (!normalized) {
      return false;
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), COORDINATOR_PROBE_TIMEOUT_MS);
    try {
      const response = await fetch(`${normalized}/`, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) {
        return false;
      }
      const payload = await response.json();
      return Boolean(payload && typeof payload === "object" && String(payload.service || "").toLowerCase() === "coordinator");
    } catch {
      return false;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function discoverCoordinatorBaseUrls({ force = false } = {}) {
    const cachedCandidates = uniqueNormalizedUrls([
      state.session.baseUrl,
      getDefaultDatasetValue("defaultCoordinatorUrl"),
      ...state.coordinatorCandidates,
    ]);
    if (!force && cachedCandidates.length && Date.now() - state.lastDiscoveryAt < DISCOVERY_CACHE_TTL_MS) {
      return cachedCandidates;
    }

    let discoveredCandidates = state.coordinatorCandidates;
    try {
      const response = await fetch("/api/discovery/coordinators", { headers: { Accept: "application/json" } });
      if (response.ok) {
        const payload = await response.json();
        const coordinators = Array.isArray(payload?.coordinators) ? payload.coordinators : [];
        discoveredCandidates = uniqueNormalizedUrls(coordinators);
      }
    } catch {
      // Keep cached candidates when discovery endpoint is unavailable.
    }

    state.lastDiscoveryAt = Date.now();
    state.coordinatorCandidates = discoveredCandidates;
    return uniqueNormalizedUrls([
      state.session.baseUrl,
      getDefaultDatasetValue("defaultCoordinatorUrl"),
      ...discoveredCandidates,
    ]);
  }

  async function confirmPairing() {
    const pendingId = String(elements.pairPendingId?.value || "").trim();
    const pairingCode = String(elements.pairCode?.value || "").trim();
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
    if (selectionChanged && state.selectedDeviceId && state.selectedShareId && elements.remoteList) {
      try {
        await loadRemoteDirectory("");
      } catch {
        // Ignore remote refresh errors during background device updates.
      }
    }
  }

  async function refreshTransfers() {
    const payload = await requestJson("/api/v1/transfers?role=all");
    state.transfers = payload.transfers || [];
    const terminalStates = new Set(["completed", "rejected", "expired", "failed", "cancelled"]);
    for (const transfer of state.transfers) {
      if (terminalStates.has(String(transfer.state || ""))) {
        state.autoUploadOpenedTransferIds.delete(transfer.id);
      }
    }
    state.lastTransferRefreshAt = Date.now();
    renderTransferList();
    maybeShowIncomingTransferModal();
    maybeAutoOpenOutgoingUploads().catch(() => {
      // Background auto-open failures should not block refresh updates.
    });
  }

  async function cancelPendingTransfers() {
    const payload = await requestJson("/api/v1/transfers/pending/cancel", { method: "POST" });
    await refreshTransfers();
    const cancelled = Number(payload?.cancelled || 0);
    setSessionStatus(`Cancelled ${cancelled} pending transfer(s).`, "success");
  }

  async function clearTransferHistory() {
    const payload = await requestJson("/api/v1/transfers/history/clear", { method: "POST" });
    await refreshTransfers();
    const deleted = Number(payload?.deleted || 0);
    setSessionStatus(`Cleared ${deleted} transfer history item(s).`, "success");
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
        const localAgentDeviceId = String(elements.networkRoot?.dataset?.localAgentDeviceId || "").trim();
        const isLocalAgent = Boolean(localAgentDeviceId && device.id === localAgentDeviceId);
        const onlineClass = device.online ? "online" : "offline";
        const onlineText = device.online ? "Online" : "Offline";
        return `
          <div class="list-item ${selected ? "selected" : ""}" data-device-id="${escapeHtml(device.id)}">
            <div class="list-item-head">
              <p class="list-item-title">${escapeHtml(device.name)}</p>
              <span class="pill ${onlineClass}">${onlineText}</span>
            </div>
            <p class="list-item-meta">${escapeHtml(device.id)}${isLocalAgent ? " • This device" : ""}</p>
            <div class="transfer-actions">
              <button type="button" data-action="quick-send-device" data-device-id="${escapeHtml(device.id)}">Send Files</button>
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

  function transferItemProgressWeight(itemState) {
    const normalized = String(itemState || "").trim().toLowerCase();
    if (!normalized || normalized === "pending") {
      return 0;
    }
    if (normalized === "receiving") {
      return 0.35;
    }
    if (normalized === "staged") {
      return 0.7;
    }
    if (normalized === "committed") {
      return 0.9;
    }
    if (normalized === "finalized" || normalized === "completed") {
      return 1;
    }
    if (["rejected", "failed", "cancelled", "expired"].includes(normalized)) {
      return 0;
    }
    return 0.1;
  }

  function transferProgressDetails(transfer) {
    const items = Array.isArray(transfer?.items) ? transfer.items : [];
    if (!items.length) {
      return {
        percent: 0,
        label: "No file metadata",
      };
    }

    let weightedProgress = 0;
    let finalizedCount = 0;
    let activeCount = 0;
    for (const item of items) {
      const itemState = String(item?.state || "").trim().toLowerCase();
      weightedProgress += transferItemProgressWeight(itemState);
      if (itemState === "finalized" || itemState === "completed") {
        finalizedCount += 1;
      }
      if (itemState === "receiving" || itemState === "staged" || itemState === "committed") {
        activeCount += 1;
      }
    }

    const progress = Math.max(0, Math.min(1, weightedProgress / items.length));
    const percent = Math.round(progress * 100);
    let label = `${finalizedCount}/${items.length} file(s) finalized`;
    if (activeCount > 0) {
      label += ` • ${activeCount} active`;
    }
    if (finalizedCount === items.length) {
      label = "All files finalized";
    }
    return { percent, label };
  }

  function describeTransferState(transfer, direction) {
    const normalized = String(transfer?.state || "").trim().toLowerCase();
    if (!normalized) {
      return "Unknown";
    }
    if (normalized === "pending_receiver_approval") {
      return direction === "incoming" ? "Awaiting your approval" : "Awaiting receiver approval";
    }
    if (normalized === "approved_pending_sender_passcode") {
      return "Awaiting sender PIN";
    }
    if (normalized === "passcode_open") {
      return "Ready to upload";
    }
    if (normalized === "in_progress") {
      return "Transfer in progress";
    }
    if (normalized === "completed") {
      return "Completed";
    }
    if (normalized === "rejected") {
      return "Rejected";
    }
    if (normalized === "failed") {
      return "Failed";
    }
    if (normalized === "cancelled") {
      return "Cancelled";
    }
    if (normalized === "expired") {
      return "Expired";
    }
    return normalized.replaceAll("_", " ");
  }

  function getTransferTargetDeviceLabel(transfer) {
    const receiverDeviceId = String(transfer?.receiver_device_id || "").trim();
    const receiverDevice = state.devices.find((item) => String(item?.id || "").trim() === receiverDeviceId);
    const localAgentDeviceId = String(elements.networkRoot?.dataset?.localAgentDeviceId || "").trim();
    const isLocalReceiver = Boolean(localAgentDeviceId && receiverDeviceId && receiverDeviceId === localAgentDeviceId);
    const baseLabel = String(receiverDevice?.name || "").trim() || receiverDeviceId.slice(0, 8) || "Unknown device";
    return `${baseLabel}${isLocalReceiver ? " • This device" : ""}`;
  }

  function transferDirection(transfer) {
    const transferId = String(transfer?.id || "").trim();
    if (transferId && (state.transferFiles.has(transferId) || state.uploadJobs.has(transferId))) {
      return "outgoing";
    }

    const localAgentDeviceId = String(elements.networkRoot?.dataset?.localAgentDeviceId || "").trim();
    const receiverDeviceId = String(transfer?.receiver_device_id || "").trim();
    if (localAgentDeviceId && receiverDeviceId) {
      return receiverDeviceId === localAgentDeviceId ? "incoming" : "outgoing";
    }

    if (String(transfer?.sender_principal_id || "").trim() === state.session.principalId) {
      return "outgoing";
    }
    return "incoming";
  }

  function getPendingIncomingTransfers() {
    return state.transfers.filter(
      (transfer) =>
        transferDirection(transfer) === "incoming"
        && transfer.state === "pending_receiver_approval"
        && !state.incomingDismissedTransferIds.has(transfer.id),
    );
  }

  function getTransferById(transferId) {
    return state.transfers.find((transfer) => transfer.id === transferId) || null;
  }

  function closeIncomingTransferModal({ dismiss = true } = {}) {
    if (!elements.incomingTransferModal) {
      return;
    }
    if (dismiss && state.incomingModalTransferId) {
      state.incomingDismissedTransferIds.add(state.incomingModalTransferId);
    }
    state.incomingModalTransferId = "";
    elements.incomingTransferModal.classList.add("hidden");
  }

  async function ensureShareRootPath(transfer) {
    const shareId = String(transfer?.receiver_share_id || "").trim();
    if (!shareId) {
      return "";
    }
    if (state.shareRootById.has(shareId)) {
      return String(state.shareRootById.get(shareId) || "");
    }

    let rootPath = "";
    const existingShare = state.shares.find((share) => share.id === shareId);
    if (existingShare && existingShare.root_path) {
      rootPath = String(existingShare.root_path || "").trim();
    }

    if (!rootPath) {
      try {
        const payload = await requestJson(
          `/api/v1/catalog/shares?device_id=${encodeURIComponent(String(transfer.receiver_device_id || ""))}`,
        );
        const shares = Array.isArray(payload?.shares) ? payload.shares : [];
        for (const share of shares) {
          const id = String(share.id || "").trim();
          if (!id) {
            continue;
          }
          const candidateRoot = String(share.root_path || "").trim();
          state.shareRootById.set(id, candidateRoot);
        }
        rootPath = String(state.shareRootById.get(shareId) || "");
      } catch {
        rootPath = "";
      }
    }

    state.shareRootById.set(shareId, rootPath);
    return rootPath;
  }

  async function browseIncomingDestinationFolder() {
    const transfer = getTransferById(state.incomingModalTransferId);
    if (!transfer) {
      throw new Error("Incoming transfer is no longer available");
    }
    const shareRootPath = await ensureShareRootPath(transfer);
    if (!shareRootPath) {
      throw new Error("Folder picker is available only for the owner of this shared folder");
    }

    const response = await fetch("/api/choose_folder", { headers: { Accept: "application/json" } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(String(payload?.error || "Unable to open folder picker"));
    }
    const selectedPath = String(payload?.path || "").trim();
    if (!selectedPath) {
      return;
    }
    const relativePath = toShareRelativePath(shareRootPath, selectedPath);
    if (relativePath === null) {
      throw new Error("Choose a folder inside the receiver shared root");
    }
    if (elements.incomingTransferDestination) {
      elements.incomingTransferDestination.value = relativePath;
    }
  }

  function openIncomingTransferModal(transfer) {
    if (!elements.incomingTransferModal) {
      return;
    }
    state.incomingModalTransferId = transfer.id;

    const targetDeviceLabel = getTransferTargetDeviceLabel(transfer);
    const totalBytes = (transfer.items || []).reduce((sum, item) => sum + Number(item.size || 0), 0);
    if (elements.incomingTransferSummary) {
      elements.incomingTransferSummary.textContent = `${transfer.items.length} file(s) pending • ${bytesToLabel(totalBytes)} total • Target: ${targetDeviceLabel}`;
    }
    if (elements.incomingTransferFiles) {
      const fileRows = (transfer.items || [])
        .map((item) => `<div class="list-item"><p class="list-item-title">${escapeHtml(item.filename)}</p><p class="list-item-meta">${bytesToLabel(Number(item.size || 0))}</p></div>`)
        .join("");
      elements.incomingTransferFiles.innerHTML = fileRows || `<div class="list-item"><p class="list-item-meta">No file metadata.</p></div>`;
    }
    if (elements.incomingTransferPasscode) {
      const preferences = parseTransferPreferences(transfer);
      elements.incomingTransferPasscode.value = /^\d{4}$/.test(preferences.autoPasscode)
        ? preferences.autoPasscode
        : randomPasscode();
    }
    if (elements.incomingTransferDestination) {
      const preferences = parseTransferPreferences(transfer);
      elements.incomingTransferDestination.value = String(preferences.destinationPath || "").trim();
    }

    elements.incomingTransferModal.classList.remove("hidden");
  }

  function maybeShowIncomingTransferModal() {
    if (!elements.incomingTransferModal || !state.session.accessToken) {
      return;
    }
    if (state.incomingModalTransferId) {
      const active = getTransferById(state.incomingModalTransferId);
      if (
        active
        && transferDirection(active) === "incoming"
        && String(active.state || "") === "pending_receiver_approval"
      ) {
        return;
      }
      closeIncomingTransferModal({ dismiss: false });
    }

    const pending = getPendingIncomingTransfers();
    state.incomingModalQueued = pending.map((transfer) => transfer.id);
    if (!pending.length) {
      return;
    }
    openIncomingTransferModal(pending[0]);
  }

  async function maybeAutoOpenOutgoingUploads() {
    for (const transfer of state.transfers) {
      if (transferDirection(transfer) !== "outgoing") {
        continue;
      }
      if (!["approved_pending_sender_passcode", "passcode_open"].includes(String(transfer.state || ""))) {
        continue;
      }
      if (!state.transferFiles.has(transfer.id) || state.uploadJobs.has(transfer.id)) {
        continue;
      }
      if (state.autoUploadOpenedTransferIds.has(transfer.id)) {
        continue;
      }
      const preferences = parseTransferPreferences(transfer);
      if (!/^\d{4}$/.test(preferences.autoPasscode)) {
        continue;
      }

      state.autoUploadOpenedTransferIds.add(transfer.id);
      try {
        const openPayload = await openUploadWindow(transfer.id, preferences.autoPasscode);
        await processUploadJob(transfer, openPayload);
      } catch {
        state.autoUploadOpenedTransferIds.delete(transfer.id);
      }
    }
  }

  async function approveIncomingTransferFromModal() {
    const transfer = getTransferById(state.incomingModalTransferId);
    if (!transfer) {
      throw new Error("Incoming transfer is no longer available");
    }

    const rawPasscode = String(elements.incomingTransferPasscode?.value || "").trim();
    const passcode = /^\d{4}$/.test(rawPasscode) ? rawPasscode : randomPasscode();
    const destinationPath = String(elements.incomingTransferDestination?.value || "").trim();

    await requestJson(`/api/v1/transfers/${encodeURIComponent(transfer.id)}/approve`, {
      method: "POST",
      body: {
        passcode,
        destination_path: destinationPath,
      },
    });
    state.incomingDismissedTransferIds.add(transfer.id);
    closeIncomingTransferModal({ dismiss: false });
    await refreshTransfers();
  }

  async function rejectIncomingTransferFromModal() {
    const transfer = getTransferById(state.incomingModalTransferId);
    if (!transfer) {
      throw new Error("Incoming transfer is no longer available");
    }
    await requestJson(`/api/v1/transfers/${encodeURIComponent(transfer.id)}/reject`, {
      method: "POST",
      body: { reason: "Rejected by receiver" },
    });
    state.incomingDismissedTransferIds.add(transfer.id);
    closeIncomingTransferModal({ dismiss: false });
    await refreshTransfers();
  }

  function renderTransferList() {
    if (!elements.transferList) {
      return;
    }
    const visibleTransfers = state.transfers.filter((transfer) => {
      const direction = transferDirection(transfer);
      if (state.transferRole === "incoming") {
        return direction === "incoming";
      }
      if (state.transferRole === "outgoing") {
        return direction === "outgoing";
      }
      return true;
    });
    if (!visibleTransfers.length) {
      elements.transferList.innerHTML = `<div class="list-item"><p class="list-item-meta">No transfers for this filter.</p></div>`;
      return;
    }

    const html = visibleTransfers
      .map((transfer) => {
        const direction = transferDirection(transfer);
        const job = state.uploadJobs.get(transfer.id);
        const preferences = parseTransferPreferences(transfer);
        const stateLabel = describeTransferState(transfer, direction);
        const targetDeviceLabel = getTransferTargetDeviceLabel(transfer);
        const progressDetails = transferProgressDetails(transfer);
        const itemList = (transfer.items || [])
          .map((item) => `${escapeHtml(item.filename)} (${escapeHtml(item.state)})`)
          .join("</li><li>");

        let actions = "";
        if (direction === "incoming" && transfer.state === "pending_receiver_approval") {
          actions = `
            <div class="transfer-actions">
              <button type="button" data-action="review-transfer" data-transfer-id="${escapeHtml(transfer.id)}">Review</button>
            </div>
          `;
        } else if (
          direction === "outgoing" &&
          (transfer.state === "approved_pending_sender_passcode" || transfer.state === "passcode_open")
        ) {
          actions = `
            <div class="transfer-actions">
              <input class="passcode-input" type="password" inputmode="numeric" maxlength="4" placeholder="4-digit PIN" aria-label="Sender PIN" value="${escapeHtml(preferences.autoPasscode)}" />
              <button type="button" data-action="open-upload" data-transfer-id="${escapeHtml(transfer.id)}">Open + Upload</button>
              ${
                job
                  ? `<button type="button" data-action="${job.paused ? "resume-upload" : "pause-upload"}" data-transfer-id="${escapeHtml(transfer.id)}">${job.paused ? "Resume" : "Pause"}</button>`
                  : ""
              }
            </div>
          `;
        }

        const destinationMeta = preferences.destinationPath
          ? `<p class="list-item-meta">Destination: ${escapeHtml(preferences.destinationPath)}</p>`
          : "";
        const targetMeta = `<p class="list-item-meta">Target device: ${escapeHtml(targetDeviceLabel)}</p>`;

        return `
          <div class="list-item" data-transfer-id="${escapeHtml(transfer.id)}">
            <div class="list-item-head">
              <p class="list-item-title">${escapeHtml(direction === "incoming" ? "Receiving" : "Sending")} • ${escapeHtml(stateLabel)}</p>
              <span class="pill">${escapeHtml(transfer.id.slice(0, 8))}</span>
            </div>
            ${targetMeta}
            <ul class="transfer-items"><li>${itemList || "No items"}</li></ul>
            <p class="list-item-meta">${escapeHtml(progressDetails.label)}</p>
            <div class="job-progress"><span style="width:${progressDetails.percent}%"></span></div>
            ${destinationMeta}
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
    setSessionStatus("Preparing transfer metadata (hashing disabled for speed).");
    for (const file of files) {
      const item = {
        filename: file.name,
        size: file.size,
        sha256: UNKNOWN_SHA256,
        mime_type: file.type || null,
      };
      items.push(item);
      localFileMap.set(fileFingerprint(item), file);
    }

    const chunks = [];
    for (let index = 0; index < items.length; index += MAX_TRANSFER_ITEMS_PER_REQUEST) {
      chunks.push(items.slice(index, index + MAX_TRANSFER_ITEMS_PER_REQUEST));
    }

    const destination = String(elements.sendDestination?.value || "").trim();
    let createdCount = 0;
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const transfer = await requestJson("/api/v1/transfers", {
        method: "POST",
        timeoutMs: 60000,
        body: {
          receiver_device_id: receiverDeviceId,
          receiver_share_id: receiverShareId,
          items: chunk,
        },
      });
      const chunkFileMap = new Map();
      for (const item of chunk) {
        const signature = fileFingerprint(item);
        const file = localFileMap.get(signature);
        if (file) {
          chunkFileMap.set(signature, file);
        }
      }
      state.transferFiles.set(transfer.id, chunkFileMap);
      state.transferDestinations.set(transfer.id, destination);
      state.autoUploadOpenedTransferIds.delete(transfer.id);
      createdCount += 1;
      if (chunks.length > 1) {
        setSessionStatus(`Created transfer batch ${index + 1}/${chunks.length}...`);
      }
    }

    elements.sendFiles.value = "";
    setSessionStatus(
      createdCount > 1
        ? `Created ${createdCount} transfer requests (${items.length} files).`
        : "Transfer request created.",
      "success",
    );
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
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), AGENT_REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error("Agent request timed out");
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
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

  function formatUploadError(error) {
    const message = error instanceof Error ? error.message : String(error || "Upload failed");
    const normalized = message.toLowerCase();
    if (normalized.includes("failed to fetch") || normalized.includes("networkerror")) {
      return "Upload could not reach receiver agent. Check both devices are on the same LAN and agent port is reachable.";
    }
    if (normalized.includes("cors")) {
      return "Upload blocked by browser cross-origin rules. Confirm receiver agent allows CORS.";
    }
    return message;
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
    const preferences = parseTransferPreferences(uploadOpenPayload.transfer || transfer);
    const destinationPath = state.transferDestinations.get(transferId) || preferences.destinationPath || "";
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
      job.message = `Upload failed: ${formatUploadError(error)}`;
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
      if (action === "review-transfer") {
        const transfer = getTransferById(transferId);
        if (!transfer) {
          throw new Error("Transfer not found");
        }
        state.incomingDismissedTransferIds.delete(transferId);
        openIncomingTransferModal(transfer);
        return;
      }

      if (action === "approve-transfer") {
        if (!/^\d{4}$/.test(passcode)) {
          throw new Error("Approve requires a valid 4-digit PIN");
        }
        await requestJson(`/api/v1/transfers/${encodeURIComponent(transferId)}/approve`, {
          method: "POST",
          body: { passcode, destination_path: "" },
        });
        state.incomingDismissedTransferIds.add(transferId);
        if (state.incomingModalTransferId === transferId) {
          closeIncomingTransferModal({ dismiss: false });
        }
        await refreshTransfers();
        return;
      }

      if (action === "reject-transfer") {
        await requestJson(`/api/v1/transfers/${encodeURIComponent(transferId)}/reject`, {
          method: "POST",
          body: { reason: "" },
        });
        state.incomingDismissedTransferIds.add(transferId);
        if (state.incomingModalTransferId === transferId) {
          closeIncomingTransferModal({ dismiss: false });
        }
        await refreshTransfers();
        return;
      }

      if (action === "open-upload") {
        const transfer = state.transfers.find((item) => item.id === transferId);
        if (!transfer) {
          throw new Error("Transfer not found");
        }
        const preferences = parseTransferPreferences(transfer);
        const resolvedPasscode = /^\d{4}$/.test(passcode) ? passcode : preferences.autoPasscode;
        if (!/^\d{4}$/.test(resolvedPasscode)) {
          throw new Error("Open upload requires a valid 4-digit PIN");
        }
        const openPayload = await openUploadWindow(transferId, resolvedPasscode);
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
      if (action === "quick-send-device") {
        state.selectedDeviceId = deviceId;
        await refreshDevicesAndShares();
        if (!state.selectedShareId) {
          throw new Error("No shared folder available for this device");
        }
        state.quickSendQueued = true;
        if (elements.sendFiles) {
          elements.sendFiles.click();
        }
        setSessionStatus("Select files to send.", "success");
        return;
      }
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
    for (const button of transferRoleButtons) {
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
        if (state.wsReconnectAttempts >= MAX_WS_RECONNECT_ATTEMPTS_BEFORE_RECOVERY) {
          await requestRecovery({ force: true });
          return;
        }
        await openEventsSocket();
      } catch {
        if (state.wsReconnectAttempts >= MAX_WS_RECONNECT_ATTEMPTS_BEFORE_RECOVERY) {
          try {
            await requestRecovery({ force: true });
          } catch {
            // Keep reconnect loop alive.
          }
        }
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
            state.consecutiveRefreshFailures = 0;
          } catch {
            state.consecutiveRefreshFailures += 1;
            if (state.consecutiveRefreshFailures >= MAX_REFRESH_FAILURES) {
              state.session.accessToken = "";
              closeEventsSocket({ allowReconnect: false });
              requestRecovery().catch(() => {
                // no-op
              });
            }
          }
        } else if (state.session.baseUrl && shouldAttemptRecovery()) {
          requestRecovery().catch(() => {
            // no-op
          });
        }
        await tick();
      }, getRefreshIntervalMs());
    };
    tick();
  }

  function resetSessionState() {
    closeEventsSocket({ allowReconnect: false });
    state.session = defaultSession();
    state.devices = [];
    state.shares = [];
    state.transfers = [];
    state.uploadJobs.clear();
    state.transferFiles.clear();
    state.transferDestinations.clear();
    state.shareRootById.clear();
    state.incomingModalTransferId = "";
    state.incomingModalQueued = [];
    state.incomingDismissedTransferIds.clear();
    state.autoUploadOpenedTransferIds.clear();
    clearSessionStorage();
    syncSessionForm();
    renderDeviceList();
    renderShareList();
    renderTransferList();
    renderUploadJobs();
  }

  async function tryConnectCandidate(baseUrl, identitySnapshot) {
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
    if (!normalizedBaseUrl) {
      throw new Error("Invalid coordinator URL");
    }

    state.session.baseUrl = normalizedBaseUrl;
    state.session.accessToken = "";
    restoreIdentity(identitySnapshot);
    syncSessionForm();

    if (hasIdentity(identitySnapshot)) {
      try {
        await connectAndRefresh();
        return;
      } catch {
        state.session.accessToken = "";
      }
    }

    restoreIdentity({ principalId: "", clientDeviceId: "", deviceSecret: "" });
    syncSessionForm();
    await bootstrapOrStartPairing({ autoJoin: true });
    await connectAndRefresh();
  }

  async function recoverAutoConnection({ force = false } = {}) {
    if (!force && !shouldAttemptRecovery()) {
      return;
    }
    state.lastRecoveryAttemptAt = Date.now();
    readSessionForm();

    const identitySnapshot = currentIdentitySnapshot();
    const candidates = await discoverCoordinatorBaseUrls({ force });
    if (!candidates.length) {
      throw new Error("No coordinator found on this network");
    }

    const failures = [];
    const probeResults = await Promise.all(
      candidates.map(async (candidate) => ({
        candidate,
        reachable: await probeCoordinatorBaseUrl(candidate),
      })),
    );

    const reachableCandidates = [];
    for (const result of probeResults) {
      if (!result.reachable) {
        failures.push(`${result.candidate} unreachable`);
        continue;
      }
      reachableCandidates.push(result.candidate);
    }

    for (const candidate of reachableCandidates) {
      try {
        await tryConnectCandidate(candidate, identitySnapshot);
        state.consecutiveRefreshFailures = 0;
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : "connection failed";
        failures.push(`${candidate}: ${message}`);
      }
    }

    // If all probes failed, attempt direct connect on top candidates as a final fallback.
    if (!reachableCandidates.length) {
      for (const candidate of candidates.slice(0, 3)) {
        try {
          await tryConnectCandidate(candidate, identitySnapshot);
          state.consecutiveRefreshFailures = 0;
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : "connection failed";
          failures.push(`${candidate}: ${message}`);
        }
      }
    }

    throw new Error(failures[0] || "No coordinator found on this network");
  }

  function requestRecovery(options = {}) {
    if (state.recoverPromise) {
      return state.recoverPromise;
    }
    state.recoverPromise = (async () => {
      try {
        await recoverAutoConnection(options);
      } finally {
        state.recoverPromise = null;
      }
    })();
    return state.recoverPromise;
  }

  function bindEvents() {
    if (elements.connectButton) {
      elements.connectButton.addEventListener("click", async () => {
        try {
          await connectAndRefresh();
        } catch (error) {
          const message = error instanceof Error ? error.message : "Connection failed";
          setSessionStatus(message, "error");
          onStatus?.(message, true);
        }
      });
    }

    if (elements.saveSettingsButton) {
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
    }

    if (elements.clearSettingsButton) {
      elements.clearSettingsButton.addEventListener("click", async () => {
        resetSessionState();
        setSessionStatus("Session reset. Reconnecting...");
        try {
          await requestRecovery({ force: true });
          setSessionStatus("Connected automatically.", "success");
        } catch (error) {
          const message = error instanceof Error ? error.message : "Reconnect failed";
          setSessionStatus(message, "error");
        }
      });
    }

    if (elements.pairStartButton) {
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
    }

    if (elements.pairConfirmButton) {
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
    }

    if (elements.networkRefresh) {
      elements.networkRefresh.addEventListener("click", async () => {
        try {
          if (!state.session.accessToken) {
            await requestRecovery({ force: true });
          } else {
            await refreshAll({ includeTransfers: true, force: true });
            state.consecutiveRefreshFailures = 0;
          }
          setSessionStatus("Refreshed", "success");
        } catch (error) {
          const message = error instanceof Error ? error.message : "Refresh failed";
          setSessionStatus(message, "error");
          onStatus?.(message, true);
        }
      });
    }

    if (elements.transferCancelPendingButton) {
      elements.transferCancelPendingButton.addEventListener("click", async () => {
        try {
          await cancelPendingTransfers();
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to cancel pending transfers";
          setSessionStatus(message, "error");
          onStatus?.(message, true);
        }
      });
    }

    if (elements.transferClearHistoryButton) {
      elements.transferClearHistoryButton.addEventListener("click", async () => {
        try {
          await clearTransferHistory();
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to clear transfer history";
          setSessionStatus(message, "error");
          onStatus?.(message, true);
        }
      });
    }

    if (elements.incomingTransferClose) {
      elements.incomingTransferClose.addEventListener("click", () => {
        closeIncomingTransferModal();
      });
    }
    if (elements.incomingTransferModal) {
      elements.incomingTransferModal.addEventListener("click", (event) => {
        if (event.target === elements.incomingTransferModal) {
          closeIncomingTransferModal();
        }
      });
    }
    if (elements.incomingTransferBrowse) {
      elements.incomingTransferBrowse.addEventListener("click", async () => {
        try {
          await browseIncomingDestinationFolder();
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unable to choose destination folder";
          setSessionStatus(message, "error");
          onStatus?.(message, true);
        }
      });
    }
    if (elements.incomingTransferApprove) {
      elements.incomingTransferApprove.addEventListener("click", async () => {
        try {
          await approveIncomingTransferFromModal();
          setSessionStatus("Transfer approved.", "success");
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to approve transfer";
          setSessionStatus(message, "error");
          onStatus?.(message, true);
        }
      });
    }
    if (elements.incomingTransferReject) {
      elements.incomingTransferReject.addEventListener("click", async () => {
        try {
          await rejectIncomingTransferFromModal();
          setSessionStatus("Transfer rejected.", "success");
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to reject transfer";
          setSessionStatus(message, "error");
          onStatus?.(message, true);
        }
      });
    }
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.incomingModalTransferId) {
        closeIncomingTransferModal();
      }
    });

    if (elements.sendDevice) {
      elements.sendDevice.addEventListener("change", async () => {
        state.selectedDeviceId = String(elements.sendDevice.value || "");
        try {
          await refreshDevicesAndShares();
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed loading shares";
          setSessionStatus(message, "error");
        }
      });
    }

    if (elements.sendShare) {
      elements.sendShare.addEventListener("change", async () => {
        state.selectedShareId = String(elements.sendShare.value || "");
        renderShareList();
        if (!elements.remoteList) {
          return;
        }
        try {
          await loadRemoteDirectory("");
        } catch {
          // ignore single refresh errors
        }
      });
    }

    if (elements.remoteLoadButton) {
      elements.remoteLoadButton.addEventListener("click", async () => {
        try {
          await loadRemoteDirectory();
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to load remote directory";
          setSessionStatus(message, "error");
          onStatus?.(message, true);
        }
      });
    }

    if (elements.remoteRunSearchButton) {
      elements.remoteRunSearchButton.addEventListener("click", async () => {
        try {
          await runRemoteSearch();
        } catch (error) {
          const message = error instanceof Error ? error.message : "Remote search failed";
          setSessionStatus(message, "error");
          onStatus?.(message, true);
        }
      });
    }

    if (elements.sendRequestButton) {
      elements.sendRequestButton.addEventListener("click", async () => {
        try {
          state.quickSendQueued = false;
          await createTransferRequest();
          onStatus?.("Transfer request created", false);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to create transfer";
          setSessionStatus(message, "error");
          onStatus?.(message, true);
        }
      });
    }

    if (elements.sendFiles) {
      elements.sendFiles.addEventListener("change", async () => {
        const count = elements.sendFiles.files ? elements.sendFiles.files.length : 0;
        if (count < 1) {
          state.quickSendQueued = false;
          return;
        }
        if (!state.quickSendQueued) {
          return;
        }
        try {
          await createTransferRequest();
          onStatus?.("Transfer request created", false);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to create transfer";
          setSessionStatus(message, "error");
          onStatus?.(message, true);
        } finally {
          state.quickSendQueued = false;
        }
      });
    }

    transferRoleButtons.forEach((button) => {
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
        if (!transferRoleButtons.length) {
          return;
        }
        const currentIndex = transferRoleButtons.indexOf(button);
        if (currentIndex < 0) {
          return;
        }
        const delta = event.key === "ArrowRight" ? 1 : -1;
        const nextIndex = (currentIndex + delta + transferRoleButtons.length) % transferRoleButtons.length;
        transferRoleButtons[nextIndex].focus();
      });
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        if (state.session.accessToken) {
          refreshAll({ force: true }).catch(() => {
            // no-op
          });
          return;
        }
        requestRecovery().catch(() => {
          // no-op
        });
      }
    });

    if (elements.deviceList) {
      elements.deviceList.addEventListener("click", (event) => {
        handleDeviceAction(event);
      });
    }
    if (elements.shareList) {
      elements.shareList.addEventListener("click", (event) => {
        handleShareAction(event);
      });
    }
    if (elements.remoteList) {
      elements.remoteList.addEventListener("click", (event) => {
        handleRemoteAction(event);
      });
    }
    if (elements.transferList) {
      elements.transferList.addEventListener("click", (event) => {
        handleTransferAction(event);
      });
    }
    if (elements.uploadJobs) {
      elements.uploadJobs.addEventListener("click", (event) => {
        handleTransferAction(event);
      });
    }
  }

  async function init() {
    loadSessionFromStorage();
    syncSessionForm();
    bindEvents();
    setTransferRole(state.transferRole);
    scheduleRefreshLoop();

    try {
      await requestRecovery({ force: true });
      setSessionStatus("Connected automatically.", "success");
    } catch {
      setSessionStatus("Waiting for nearby coordinator...");
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
