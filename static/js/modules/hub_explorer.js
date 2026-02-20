export function createHubExplorer(options) {
  const {
    api,
    dom,
    state,
    preview,
    renderBreadcrumb,
    renderFileList,
    showStatus,
    updateEmptyState,
    clearPaginationControls,
    onLoadDirectory,
  } = options;

  function normalizeHub(rawHub) {
    const hubId = String(rawHub?.id || "").trim().toLowerCase();
    return {
      id: hubId,
      name: String(rawHub?.name || "LAN Device").trim() || "LAN Device",
      isLocal: Boolean(rawHub?.is_local),
      locked: Boolean(rawHub?.locked),
      webUrl: String(rawHub?.web_url || "").trim(),
      canSetup: Boolean(rawHub?.can_setup),
    };
  }

  function getHubById(hubId) {
    const normalized = String(hubId || "").trim().toLowerCase();
    if (!normalized) {
      return null;
    }
    return state.hubs.find((hub) => hub.id === normalized) || null;
  }

  function isDeviceRootMode() {
    return !state.activeHubId;
  }

  function clearSearchInput() {
    dom.searchInput.value = "";
    state.searchQuery = "";
    dom.searchClear.classList.add("hidden");
  }

  function setSearchEnabled(enabled) {
    const isEnabled = Boolean(enabled);
    dom.searchInput.disabled = !isEnabled;
    dom.searchRecursive.disabled = !isEnabled;
    dom.searchClear.disabled = !isEnabled;
    dom.searchInput.placeholder = isEnabled
      ? "Search files or folders..."
      : "Select a device folder first";
  }

  function setBreadcrumbRootLabel(label) {
    const rootButton = dom.breadcrumb.querySelector(".crumb-item .crumb-btn");
    if (rootButton) {
      rootButton.textContent = String(label || "Root");
    }
  }

  function renderDeviceChips() {
    if (!dom.deviceChipList) {
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const hub of state.hubs) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "device-chip";
      if (hub.id === state.activeHubId) {
        button.classList.add("active");
      }
      if (hub.locked) {
        button.classList.add("locked");
      }
      if (hub.isLocal) {
        button.classList.add("local");
      }
      button.dataset.hubId = hub.id;
      button.textContent = hub.locked ? `${hub.name} (Locked)` : hub.name;
      fragment.appendChild(button);
    }
    dom.deviceChipList.replaceChildren(fragment);
  }

  function renderDeviceSelector() {
    if (dom.deviceBack) {
      dom.deviceBack.classList.toggle("hidden", isDeviceRootMode());
    }

    if (isDeviceRootMode()) {
      if (dom.deviceSelectorTitle) {
        dom.deviceSelectorTitle.textContent = "Devices";
      }
      if (dom.deviceSelectorSubtitle) {
        dom.deviceSelectorSubtitle.textContent = "Choose a device folder to browse files.";
      }
    } else {
      const hub = getHubById(state.activeHubId);
      if (dom.deviceSelectorTitle) {
        dom.deviceSelectorTitle.textContent = hub ? hub.name : "Device";
      }
      if (dom.deviceSelectorSubtitle) {
        dom.deviceSelectorSubtitle.textContent = hub?.locked
          ? "Locked. Enter PIN to continue."
          : "Browsing selected device.";
      }
    }
    renderDeviceChips();
  }

  async function refreshHubState({ refresh = false } = {}) {
    const payload = await api.listHubs({ refresh });
    if (!payload) {
      return;
    }
    const hubs = Array.isArray(payload.hubs) ? payload.hubs : [];
    state.hubs = hubs.map(normalizeHub).filter((hub) => hub.id);

    const nextActiveId = String(payload.active_hub_id || "").trim().toLowerCase();
    state.activeHubId = state.hubs.some((hub) => hub.id === nextActiveId) ? nextActiveId : "";
    renderDeviceSelector();
  }

  function renderDeviceRoot() {
    state.currentPath = "";
    state.searchMode = false;
    clearPaginationControls();
    clearSearchInput();
    setSearchEnabled(false);
    preview.closePreview();

    renderBreadcrumb(dom.breadcrumb, "", async () => {});
    setBreadcrumbRootLabel("Devices");

    const hubItems = state.hubs.map((hub) => ({
      name: hub.locked ? `${hub.name} (Locked)` : hub.name,
      is_dir: true,
      path: hub.id,
      parent_path: "",
      type: "directory",
      size: 0,
      modified_at: 0,
      created_at: 0,
    }));

    renderFileList(dom.fileList, hubItems, {
      onOpenDirectory: async (hubId) => {
        await openHubFromRoot(hubId);
      },
      onOpenFile: async () => {},
    });
    updateEmptyState(hubItems.length, "hubs");
  }

  async function returnToDeviceRoot() {
    await api.selectHub("");
    await refreshHubState();
    renderDeviceRoot();
    showStatus("Showing all devices.", false);
  }

  async function openHubFromRoot(hubId) {
    const hub = getHubById(hubId);
    if (!hub) {
      showStatus("Device is no longer available.", true);
      await refreshHubState({ refresh: true });
      renderDeviceRoot();
      return;
    }
    if (hub.locked) {
      openPinModal(hub);
      return;
    }
    await enterHub(hub.id);
  }

  async function enterHub(hubId) {
    const hub = getHubById(hubId);
    if (!hub) {
      showStatus("Device is no longer available.", true);
      return;
    }
    await api.selectHub(hub.id);
    await refreshHubState();
    clearSearchInput();
    setSearchEnabled(true);
    await onLoadDirectory("");
  }

  function openPinModal(hub) {
    if (!dom.devicePinModal || !dom.devicePinInput) {
      return;
    }
    state.pinTargetHubId = hub.id;
    if (dom.devicePinName) {
      dom.devicePinName.textContent = hub.name;
    }
    if (dom.devicePinError) {
      dom.devicePinError.classList.add("hidden");
      dom.devicePinError.textContent = "";
    }
    dom.devicePinInput.value = "";
    dom.devicePinModal.classList.remove("hidden");
    window.setTimeout(() => {
      dom.devicePinInput.focus();
    }, 0);
  }

  function closePinModal() {
    state.pinTargetHubId = "";
    if (dom.devicePinModal) {
      dom.devicePinModal.classList.add("hidden");
    }
    if (dom.devicePinError) {
      dom.devicePinError.classList.add("hidden");
      dom.devicePinError.textContent = "";
    }
  }

  function setPinError(message) {
    if (!dom.devicePinError) {
      showStatus(message, true);
      return;
    }
    dom.devicePinError.textContent = message;
    dom.devicePinError.classList.remove("hidden");
  }

  async function submitPinUnlock(event) {
    event.preventDefault();
    const hubId = String(state.pinTargetHubId || "").trim().toLowerCase();
    const pin = String(dom.devicePinInput?.value || "").trim();
    if (!hubId) {
      closePinModal();
      return;
    }
    if (!pin) {
      setPinError("Enter the device PIN.");
      return;
    }
    try {
      await api.unlockHub(hubId, pin);
      closePinModal();
      await refreshHubState({ refresh: true });
      await enterHub(hubId);
      showStatus("Device unlocked.", false);
    } catch (error) {
      setPinError(error?.message || "Unlock failed.");
    }
  }

  async function init() {
    await refreshHubState({ refresh: true });
    if (state.activeHubId) {
      setSearchEnabled(true);
      await onLoadDirectory("");
    } else {
      renderDeviceRoot();
      showStatus("Select a device folder to browse files.", false);
    }
  }

  return {
    clearSearchInput,
    closePinModal,
    enterHub,
    getHubById,
    init,
    isDeviceRootMode,
    openPinModal,
    refreshHubState,
    renderDeviceRoot,
    returnToDeviceRoot,
    setBreadcrumbRootLabel,
    setSearchEnabled,
    submitPinUnlock,
  };
}
