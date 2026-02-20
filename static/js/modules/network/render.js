import {
  REMOTE_LIST_MAX_RESULTS,
  REMOTE_SEARCH_MAX_RESULTS,
  escapeHtml,
  sanitizeRemoteUrl,
  parseTransferPreferences,
  randomPasscode,
  bytesToLabel,
  toShareRelativePath,
} from "./shared.js";

export function createNetworkRenderApi(ctx) {
  const { state, elements, transferRoleButtons } = ctx;
  const requestJson = (...args) => ctx.requestJson(...args);
  const refreshTransfers = (...args) => ctx.refreshTransfers(...args);
  const openUploadWindow = (...args) => ctx.openUploadWindow(...args);
  const processUploadJob = (...args) => ctx.processUploadJob(...args);
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
  return {
    renderDeviceList,
    renderShareList,
    renderSendDeviceOptions,
    renderSendShareOptions,
    renderRemoteList,
    loadRemoteDirectory,
    runRemoteSearch,
    transferItemProgressWeight,
    transferProgressDetails,
    describeTransferState,
    getTransferTargetDeviceLabel,
    transferDirection,
    getPendingIncomingTransfers,
    getTransferById,
    closeIncomingTransferModal,
    ensureShareRootPath,
    browseIncomingDestinationFolder,
    openIncomingTransferModal,
    maybeShowIncomingTransferModal,
    maybeAutoOpenOutgoingUploads,
    approveIncomingTransferFromModal,
    rejectIncomingTransferFromModal,
    renderTransferList,
    renderUploadJobs,
    syncTransferRoleTabs,
    setTransferRole,
  };
}
