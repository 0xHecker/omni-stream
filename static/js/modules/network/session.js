import {
  PERSISTED_PROFILE_KEY,
  RUNTIME_SESSION_KEY,
  MAX_COORDINATOR_CANDIDATES,
  COORDINATOR_REQUEST_TIMEOUT_MS,
  COORDINATOR_PROBE_TIMEOUT_MS,
  DISCOVERY_CACHE_TTL_MS,
  TRANSFER_BACKUP_REFRESH_INTERVAL_MS,
  RECOVERY_MIN_INTERVAL_MS,
  REMOTE_LIST_MAX_RESULTS,
  normalizeBaseUrl,
  defaultSession,
} from "./shared.js";

export function createNetworkSessionApi(ctx) {
  const { state, elements } = ctx;
  const closeEventsSocket = (...args) => ctx.closeEventsSocket(...args);
  const renderDeviceList = (...args) => ctx.renderDeviceList(...args);
  const renderShareList = (...args) => ctx.renderShareList(...args);
  const renderTransferList = (...args) => ctx.renderTransferList(...args);
  const renderSendDeviceOptions = (...args) => ctx.renderSendDeviceOptions(...args);
  const renderSendShareOptions = (...args) => ctx.renderSendShareOptions(...args);
  const maybeShowIncomingTransferModal = (...args) => ctx.maybeShowIncomingTransferModal(...args);
  const maybeAutoOpenOutgoingUploads = (...args) => ctx.maybeAutoOpenOutgoingUploads(...args);
  const loadRemoteDirectory = (...args) => ctx.loadRemoteDirectory(...args);
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
  return {
    getDefaultDatasetValue,
    getInputValue,
    setInputValue,
    uniqueNormalizedUrls,
    currentIdentitySnapshot,
    hasIdentity,
    restoreIdentity,
    shouldAttemptRecovery,
    loadSessionFromStorage,
    saveSessionProfile,
    saveRuntimeSession,
    clearSessionStorage,
    syncSessionForm,
    readSessionForm,
    setSessionStatus,
    setPairingStatus,
    coordinatorErrorMessage,
    requestJson,
    connectSession,
    bootstrapOrStartPairing,
    probeCoordinatorBaseUrl,
    discoverCoordinatorBaseUrls,
    confirmPairing,
    refreshDevicesAndShares,
    refreshTransfers,
    cancelPendingTransfers,
    clearTransferHistory,
    refreshAll,
  };
}
