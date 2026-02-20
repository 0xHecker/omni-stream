export function createNetworkEventsApi(ctx) {
  const { state, elements, transferRoleButtons } = ctx;
  const onStatus = ctx.onStatus;
  const connectAndRefresh = (...args) => ctx.connectAndRefresh(...args);
  const setSessionStatus = (...args) => ctx.setSessionStatus(...args);
  const readSessionForm = (...args) => ctx.readSessionForm(...args);
  const saveSessionProfile = (...args) => ctx.saveSessionProfile(...args);
  const saveRuntimeSession = (...args) => ctx.saveRuntimeSession(...args);
  const closeEventsSocket = (...args) => ctx.closeEventsSocket(...args);
  const resetSessionState = (...args) => ctx.resetSessionState(...args);
  const requestRecovery = (...args) => ctx.requestRecovery(...args);
  const openEventsSocket = (...args) => ctx.openEventsSocket(...args);
  const scheduleWsReconnect = (...args) => ctx.scheduleWsReconnect(...args);
  const refreshAll = (...args) => ctx.refreshAll(...args);
  const bootstrapOrStartPairing = (...args) => ctx.bootstrapOrStartPairing(...args);
  const setPairingStatus = (...args) => ctx.setPairingStatus(...args);
  const confirmPairing = (...args) => ctx.confirmPairing(...args);
  const cancelPendingTransfers = (...args) => ctx.cancelPendingTransfers(...args);
  const clearTransferHistory = (...args) => ctx.clearTransferHistory(...args);
  const closeIncomingTransferModal = (...args) => ctx.closeIncomingTransferModal(...args);
  const browseIncomingDestinationFolder = (...args) => ctx.browseIncomingDestinationFolder(...args);
  const approveIncomingTransferFromModal = (...args) => ctx.approveIncomingTransferFromModal(...args);
  const rejectIncomingTransferFromModal = (...args) => ctx.rejectIncomingTransferFromModal(...args);
  const refreshDevicesAndShares = (...args) => ctx.refreshDevicesAndShares(...args);
  const renderShareList = (...args) => ctx.renderShareList(...args);
  const loadRemoteDirectory = (...args) => ctx.loadRemoteDirectory(...args);
  const runRemoteSearch = (...args) => ctx.runRemoteSearch(...args);
  const createTransferRequest = (...args) => ctx.createTransferRequest(...args);
  const setTransferRole = (...args) => ctx.setTransferRole(...args);
  const refreshTransfers = (...args) => ctx.refreshTransfers(...args);
  const handleDeviceAction = (...args) => ctx.handleDeviceAction(...args);
  const handleShareAction = (...args) => ctx.handleShareAction(...args);
  const handleRemoteAction = (...args) => ctx.handleRemoteAction(...args);
  const handleTransferAction = (...args) => ctx.handleTransferAction(...args);
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
  return {
    bindEvents,
  };
}
