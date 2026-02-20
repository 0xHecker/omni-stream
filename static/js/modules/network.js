import { defaultSession } from "./network/shared.js";
import { createNetworkSessionApi } from "./network/session.js";
import { createNetworkRenderApi } from "./network/render.js";
import { createNetworkUploadApi } from "./network/upload.js";
import { createNetworkRealtimeApi } from "./network/realtime.js";
import { createNetworkEventsApi } from "./network/events.js";

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

  const ctx = {
    elements,
    onStatus,
    transferRoleButtons,
    state,
  };

  Object.assign(ctx, createNetworkSessionApi(ctx));
  Object.assign(ctx, createNetworkRenderApi(ctx));
  Object.assign(ctx, createNetworkUploadApi(ctx));
  Object.assign(ctx, createNetworkRealtimeApi(ctx));
  Object.assign(ctx, createNetworkEventsApi(ctx));

  async function init() {
    ctx.loadSessionFromStorage();
    ctx.syncSessionForm();
    ctx.bindEvents();
    ctx.setTransferRole(state.transferRole);
    ctx.scheduleRefreshLoop();

    try {
      await ctx.requestRecovery({ force: true });
      ctx.setSessionStatus("Connected automatically.", "success");
    } catch {
      ctx.setSessionStatus("Waiting for nearby coordinator...");
    }
    ctx.renderDeviceList();
    ctx.renderShareList();
    ctx.renderTransferList();
    ctx.renderUploadJobs();
  }

  return {
    init,
  };
}
