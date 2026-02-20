import {
  DEVICE_REFRESH_INTERVAL_MS,
  HIDDEN_DEVICE_REFRESH_INTERVAL_MS,
  WS_PING_INTERVAL_MS,
  WS_RECONNECT_MAX_DELAY_MS,
  MAX_WS_RECONNECT_ATTEMPTS_BEFORE_RECOVERY,
  MAX_REFRESH_FAILURES,
  defaultSession,
  normalizeBaseUrl,
} from "./shared.js";

export function createNetworkRealtimeApi(ctx) {
  const { state } = ctx;
  const requestJson = (...args) => ctx.requestJson(...args);
  const refreshTransfers = (...args) => ctx.refreshTransfers(...args);
  const connectSession = (...args) => ctx.connectSession(...args);
  const refreshAll = (...args) => ctx.refreshAll(...args);
  const shouldAttemptRecovery = (...args) => ctx.shouldAttemptRecovery(...args);
  const clearSessionStorage = (...args) => ctx.clearSessionStorage(...args);
  const syncSessionForm = (...args) => ctx.syncSessionForm(...args);
  const renderDeviceList = (...args) => ctx.renderDeviceList(...args);
  const renderShareList = (...args) => ctx.renderShareList(...args);
  const renderTransferList = (...args) => ctx.renderTransferList(...args);
  const renderUploadJobs = (...args) => ctx.renderUploadJobs(...args);
  const restoreIdentity = (...args) => ctx.restoreIdentity(...args);
  const hasIdentity = (...args) => ctx.hasIdentity(...args);
  const bootstrapOrStartPairing = (...args) => ctx.bootstrapOrStartPairing(...args);
  const discoverCoordinatorBaseUrls = (...args) => ctx.discoverCoordinatorBaseUrls(...args);
  const probeCoordinatorBaseUrl = (...args) => ctx.probeCoordinatorBaseUrl(...args);
  const currentIdentitySnapshot = (...args) => ctx.currentIdentitySnapshot(...args);
  const readSessionForm = (...args) => ctx.readSessionForm(...args);
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
  return {
    stopWsPing,
    startWsPing,
    clearWsReconnectTimer,
    scheduleWsReconnect,
    closeEventsSocket,
    fetchEventsWsToken,
    openEventsSocket,
    connectAndRefresh,
    getRefreshIntervalMs,
    scheduleRefreshLoop,
    resetSessionState,
    tryConnectCandidate,
    recoverAutoConnection,
    requestRecovery,
  };
}
