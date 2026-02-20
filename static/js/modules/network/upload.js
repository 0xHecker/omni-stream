import {
  UNKNOWN_SHA256,
  UPLOAD_CHUNK_BYTES,
  MAX_TRANSFER_ITEMS_PER_REQUEST,
  AGENT_REQUEST_TIMEOUT_MS,
  sleep,
  fileFingerprint,
  bytesToLabel,
  parseTransferPreferences,
} from "./shared.js";

export function createNetworkUploadApi(ctx) {
  const { state, elements } = ctx;
  const onStatus = ctx.onStatus;
  const renderUploadJobs = (...args) => ctx.renderUploadJobs(...args);
  const requestJson = (...args) => ctx.requestJson(...args);
  const refreshTransfers = (...args) => ctx.refreshTransfers(...args);
  const refreshDevicesAndShares = (...args) => ctx.refreshDevicesAndShares(...args);
  const renderShareList = (...args) => ctx.renderShareList(...args);
  const renderSendShareOptions = (...args) => ctx.renderSendShareOptions(...args);
  const loadRemoteDirectory = (...args) => ctx.loadRemoteDirectory(...args);
  const setSessionStatus = (...args) => ctx.setSessionStatus(...args);
  const getTransferById = (...args) => ctx.getTransferById(...args);
  const openIncomingTransferModal = (...args) => ctx.openIncomingTransferModal(...args);
  const closeIncomingTransferModal = (...args) => ctx.closeIncomingTransferModal(...args);
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
  return {
    createTransferRequest,
    openUploadWindow,
    agentJson,
    buildAgentTransferUrl,
    formatUploadError,
    processUploadJob,
    setTransferPaused,
    handleTransferAction,
    handleDeviceAction,
    handleShareAction,
    handleRemoteAction,
  };
}
