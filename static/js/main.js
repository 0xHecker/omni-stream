import { createApiClient } from "./modules/api.js";
import { createNetworkController } from "./modules/network.js";
import { createPreviewController } from "./modules/preview.js";
import { renderBreadcrumb, renderFileList } from "./modules/ui.js";
import { debounce, normalizePath } from "./modules/utils.js";

const state = {
  currentPath: "",
  searchQuery: "",
  searchMode: false,
  fileRequestId: 0,
  fileRequestController: null,
  adjacentRequestController: null,
};

const dom = {};

document.addEventListener("DOMContentLoaded", () => {
  dom.fileList = document.getElementById("file-list");
  dom.breadcrumb = document.getElementById("breadcrumb");
  dom.status = document.getElementById("status");
  dom.modal = document.getElementById("preview-modal");
  dom.modalPreview = document.getElementById("modal-preview");
  dom.closeModal = document.getElementById("close-modal");
  dom.prevButton = document.getElementById("nav-prev");
  dom.nextButton = document.getElementById("nav-next");
  dom.themeToggle = document.getElementById("theme-toggle");
  dom.downloadFile = document.getElementById("download-file");
  dom.searchInput = document.getElementById("search-input");
  dom.searchRecursive = document.getElementById("search-recursive");
  dom.searchClear = document.getElementById("search-clear");
  dom.emptyState = document.getElementById("empty-state");
  dom.networkRefresh = document.getElementById("network-refresh");
  dom.coordUrl = document.getElementById("coord-url");
  dom.principalId = document.getElementById("principal-id");
  dom.clientDeviceId = document.getElementById("client-device-id");
  dom.deviceSecret = document.getElementById("device-secret");
  dom.coordConnect = document.getElementById("coord-connect");
  dom.coordSaveSettings = document.getElementById("coord-save-settings");
  dom.coordClearSettings = document.getElementById("coord-clear-settings");
  dom.coordSessionStatus = document.getElementById("coord-session-status");
  dom.pairDisplayName = document.getElementById("pair-display-name");
  dom.pairDeviceName = document.getElementById("pair-device-name");
  dom.pairStart = document.getElementById("pair-start");
  dom.pairConfirm = document.getElementById("pair-confirm");
  dom.pairPendingId = document.getElementById("pair-pending-id");
  dom.pairCode = document.getElementById("pair-code");
  dom.pairingStatus = document.getElementById("pairing-status");
  dom.deviceList = document.getElementById("device-list");
  dom.shareList = document.getElementById("share-list");
  dom.sendDevice = document.getElementById("send-device");
  dom.sendShare = document.getElementById("send-share");
  dom.remotePath = document.getElementById("remote-path");
  dom.remoteSearch = document.getElementById("remote-search");
  dom.remoteLoad = document.getElementById("remote-load");
  dom.remoteRunSearch = document.getElementById("remote-run-search");
  dom.remoteList = document.getElementById("remote-list");
  dom.sendFiles = document.getElementById("send-files");
  dom.sendDestination = document.getElementById("send-destination");
  dom.sendRequest = document.getElementById("send-request");
  dom.transferList = document.getElementById("transfer-list");
  dom.uploadJobs = document.getElementById("upload-jobs");
  dom.transferRoleButtons = [...document.querySelectorAll(".transfer-role")];

  const redirectToLogin = () => window.location.assign("/login");
  const api = createApiClient({ onUnauthorized: redirectToLogin });

  const preview = createPreviewController({
    modal: dom.modal,
    modalPreview: dom.modalPreview,
    downloadLink: dom.downloadFile,
    showStatus,
    onNavigateFile: navigateAdjacent,
    onUnauthorized: redirectToLogin,
    api,
  });

  const debouncedSearch = debounce(() => {
    runSearchOrBrowse();
  }, 250);
  const requiredNetworkNodes = [
    dom.coordUrl,
    dom.principalId,
    dom.clientDeviceId,
    dom.deviceSecret,
    dom.coordConnect,
    dom.coordSaveSettings,
    dom.coordClearSettings,
    dom.coordSessionStatus,
    dom.pairDisplayName,
    dom.pairDeviceName,
    dom.pairStart,
    dom.pairConfirm,
    dom.pairPendingId,
    dom.pairCode,
    dom.pairingStatus,
    dom.networkRefresh,
    dom.deviceList,
    dom.shareList,
    dom.sendDevice,
    dom.sendShare,
    dom.remotePath,
    dom.remoteSearch,
    dom.remoteLoad,
    dom.remoteRunSearch,
    dom.remoteList,
    dom.sendFiles,
    dom.sendDestination,
    dom.sendRequest,
    dom.transferList,
    dom.uploadJobs,
  ];
  const hasNetworkDom = requiredNetworkNodes.every(Boolean) && dom.transferRoleButtons.length > 0;
  const network = hasNetworkDom
    ? createNetworkController({
      elements: {
        coordUrl: dom.coordUrl,
        principalId: dom.principalId,
        clientDeviceId: dom.clientDeviceId,
        deviceSecret: dom.deviceSecret,
        connectButton: dom.coordConnect,
        saveSettingsButton: dom.coordSaveSettings,
        clearSettingsButton: dom.coordClearSettings,
        sessionStatus: dom.coordSessionStatus,
        pairDisplayName: dom.pairDisplayName,
        pairDeviceName: dom.pairDeviceName,
        pairStartButton: dom.pairStart,
        pairConfirmButton: dom.pairConfirm,
        pairPendingId: dom.pairPendingId,
        pairCode: dom.pairCode,
        pairingStatus: dom.pairingStatus,
        networkRefresh: dom.networkRefresh,
        deviceList: dom.deviceList,
        shareList: dom.shareList,
        sendDevice: dom.sendDevice,
        sendShare: dom.sendShare,
        remotePath: dom.remotePath,
        remoteSearch: dom.remoteSearch,
        remoteLoadButton: dom.remoteLoad,
        remoteRunSearchButton: dom.remoteRunSearch,
        remoteList: dom.remoteList,
        sendFiles: dom.sendFiles,
        sendDestination: dom.sendDestination,
        sendRequestButton: dom.sendRequest,
        transferRoleButtons: dom.transferRoleButtons,
        transferList: dom.transferList,
        uploadJobs: dom.uploadJobs,
      },
      onStatus: showStatus,
    })
    : null;

  bindEvents();
  restoreTheme();
  loadDirectory("");
  setupScrollTop();

  if (network) {
    network.init();
  }

  function setupScrollTop() {
    let btn = document.getElementById("scroll-to-top");
    if (!btn) {
      btn = document.createElement("button");
      btn.id = "scroll-to-top";
      btn.className = "scroll-top-btn hidden";
      btn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-up"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>`;
      btn.setAttribute("aria-label", "Scroll to top");
      btn.onclick = () => window.scrollTo({ top: 0, behavior: "smooth" });
      document.body.appendChild(btn);
    }
    window.addEventListener("scroll", () => {
      btn.classList.toggle("hidden", window.scrollY < 300);
    });
  }

  function bindEvents() {
    dom.themeToggle.addEventListener("click", toggleTheme);
    dom.closeModal.addEventListener("click", () => preview.closePreview());
    dom.prevButton.addEventListener("click", (e) => { e.stopPropagation(); navigateAdjacent("prev"); });
    dom.nextButton.addEventListener("click", (e) => { e.stopPropagation(); navigateAdjacent("next"); });
    dom.modal.addEventListener("click", preview.handleModalClick);
    dom.modal.addEventListener("touchstart", preview.handleTouchStart, { passive: true });
    dom.modal.addEventListener("touchend", preview.handleTouchEnd, { passive: true });
    window.addEventListener("resize", preview.handleResize);

    document.addEventListener("keydown", (event) => {
      preview.handleKeyDown(event);
    });

    dom.searchInput.addEventListener("input", () => {
      const value = dom.searchInput.value.trim();
      dom.searchClear.classList.toggle("hidden", value.length === 0);
      state.searchQuery = value;
      debouncedSearch();
    });

    dom.searchRecursive.addEventListener("change", () => {
      if (!state.searchQuery) {
        return;
      }
      runSearchOrBrowse();
    });

    dom.searchClear.addEventListener("click", () => {
      dom.searchInput.value = "";
      state.searchQuery = "";
      dom.searchClear.classList.add("hidden");
      runSearchOrBrowse();
    });
  }

  async function runSearchOrBrowse() {
    const query = state.searchQuery.trim();
    if (!query) {
      await loadDirectory(state.currentPath);
      return;
    }
    await runSearch(query);
  }

  function startFileRequest() {
    state.fileRequestId += 1;
    if (state.fileRequestController) {
      state.fileRequestController.abort();
    }
    state.fileRequestController = new AbortController();
    return {
      requestId: state.fileRequestId,
      signal: state.fileRequestController.signal,
    };
  }

  function isAbortError(error) {
    return error instanceof DOMException && error.name === "AbortError";
  }

  async function loadDirectory(path = "", page = 1) {
    const { requestId, signal } = startFileRequest();
    try {
      const data = await api.listFiles(path, { signal, maxResults: 400, page });
      if (!data) {
        return;
      }
      if (requestId !== state.fileRequestId) {
        return;
      }

      state.currentPath = normalizePath(data.current_path || "");
      state.searchMode = false;

      renderBreadcrumb(dom.breadcrumb, state.currentPath, async (targetPath) => {
        await loadDirectory(targetPath);
      });
      renderFileList(dom.fileList, data.items || [], {
        onOpenDirectory: async (targetPath) => {
          await loadDirectory(targetPath);
        },
        onOpenFile: async (item) => {
          await preview.openPreview(item);
        },
      });

      // Pagination setup
      let paginationControls = dom.fileList.nextElementSibling;
      if (paginationControls && paginationControls.classList.contains("pagination-controls")) {
        paginationControls.remove();
      }
      if (data.total_pages > 1) {
        paginationControls = document.createElement("div");
        paginationControls.className = "pagination-controls";

        const prevBtn = document.createElement("button");
        prevBtn.className = "code-btn";
        prevBtn.textContent = "Previous";
        prevBtn.disabled = data.page <= 1;
        prevBtn.onclick = () => loadDirectory(path, data.page - 1).then(() => window.scrollTo({ top: 0, behavior: "smooth" }));

        const pageLabel = document.createElement("span");
        pageLabel.textContent = `Page ${data.page} of ${data.total_pages}`;
        pageLabel.className = "fallback-label";

        const nextBtn = document.createElement("button");
        nextBtn.className = "code-btn";
        nextBtn.textContent = "Next";
        nextBtn.disabled = data.page >= data.total_pages;
        nextBtn.onclick = () => loadDirectory(path, data.page + 1).then(() => window.scrollTo({ top: 0, behavior: "smooth" }));

        paginationControls.append(prevBtn, pageLabel, nextBtn);
        dom.fileList.parentNode.insertBefore(paginationControls, dom.fileList.nextSibling);
      }

      updateEmptyState((data.items || []).length, "browse");
      showStatus(`${(data.items || []).length} item(s)`, false);
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      showStatus(error.message || "Failed to load files", true);
    }
  }

  async function runSearch(query) {
    const { requestId, signal } = startFileRequest();
    try {
      const data = await api.searchFiles({
        path: state.currentPath,
        query,
        recursive: dom.searchRecursive.checked,
        maxResults: 300,
        signal,
      });
      if (!data) {
        return;
      }
      if (requestId !== state.fileRequestId) {
        return;
      }

      state.searchMode = true;
      renderBreadcrumb(dom.breadcrumb, state.currentPath, async (targetPath) => {
        await loadDirectory(targetPath);
      });
      renderFileList(dom.fileList, data.items || [], {
        onOpenDirectory: async (targetPath) => {
          dom.searchInput.value = "";
          state.searchQuery = "";
          dom.searchClear.classList.add("hidden");
          await loadDirectory(targetPath);
        },
        onOpenFile: async (item) => {
          await preview.openPreview(item);
        },
        showParentPath: true,
        basePath: data.base_path || state.currentPath,
      });
      updateEmptyState((data.items || []).length, "search", query);

      const baseText = data.base_path ? ` in ${data.base_path || "Root"}` : "";
      const truncationText = data.truncated ? " (showing top matches)" : "";
      showStatus(`${(data.items || []).length} match(es)${baseText}${truncationText}`, false);
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      showStatus(error.message || "Search failed", true);
    }
  }

  async function navigateAdjacent(direction) {
    const currentFilePath = preview.getCurrentFilePath();
    if (!currentFilePath) {
      return;
    }

    try {
      if (state.adjacentRequestController) {
        state.adjacentRequestController.abort();
      }
      state.adjacentRequestController = new AbortController();
      const data = await api.getAdjacentFile(currentFilePath, direction, {
        signal: state.adjacentRequestController.signal,
      });
      if (!data) {
        return;
      }
      await preview.openPreview(data);
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      showStatus(error.message || "Failed to navigate file", true);
    }
  }

  function showStatus(message, isError) {
    dom.status.classList.remove("hidden");
    dom.status.textContent = message;
    dom.status.classList.toggle("error", Boolean(isError));
  }

  function updateEmptyState(itemCount, mode, query = "") {
    if (!dom.emptyState) {
      return;
    }

    if (itemCount > 0) {
      dom.emptyState.classList.add("hidden");
      return;
    }

    const title = dom.emptyState.querySelector(".empty-title");
    const text = dom.emptyState.querySelector(".empty-text");
    if (title && text) {
      if (mode === "search") {
        title.textContent = "No matching files";
        text.textContent = `No results found for \"${query}\". Try a shorter term or disable recursive filtering.`;
      } else {
        title.textContent = "No files in this folder";
        text.textContent = "This directory is currently empty. Move up one level or switch folders.";
      }
    }
    dom.emptyState.classList.remove("hidden");
  }
});

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") || "light";
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  const themeToggle = document.getElementById("theme-toggle");
  if (themeToggle) {
    themeToggle.textContent = next === "dark" ? "Dark" : "Light";
  }
  localStorage.setItem("theme", next);
}

function restoreTheme() {
  const saved = localStorage.getItem("theme") || "light";
  document.documentElement.setAttribute("data-theme", saved);
  const themeToggle = document.getElementById("theme-toggle");
  if (themeToggle) {
    themeToggle.textContent = saved === "dark" ? "Dark" : "Light";
  }
}
