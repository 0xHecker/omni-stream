import { createApiClient } from "./modules/api.js";
import { createPreviewController } from "./modules/preview.js";
import { renderBreadcrumb, renderFileList } from "./modules/ui.js";
import { debounce, normalizePath } from "./modules/utils.js";

const state = {
  currentPath: "",
  searchQuery: "",
  searchMode: false,
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

  const redirectToLogin = () => window.location.assign("/login");
  const api = createApiClient({ onUnauthorized: redirectToLogin });

  const preview = createPreviewController({
    modal: dom.modal,
    modalPreview: dom.modalPreview,
    downloadLink: dom.downloadFile,
    showStatus,
    onNavigateFile: navigateAdjacent,
    onUnauthorized: redirectToLogin,
  });

  const debouncedSearch = debounce(() => {
    runSearchOrBrowse();
  }, 250);

  bindEvents();
  restoreTheme();
  loadDirectory("");

  function bindEvents() {
    dom.themeToggle.addEventListener("click", toggleTheme);
    dom.closeModal.addEventListener("click", () => preview.closePreview());
    dom.prevButton.addEventListener("click", () => navigateAdjacent("prev"));
    dom.nextButton.addEventListener("click", () => navigateAdjacent("next"));
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

  async function loadDirectory(path = "") {
    try {
      const data = await api.listFiles(path);
      if (!data) {
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
        onOpenFile: async (targetPath, type) => {
          await preview.openPreview(targetPath, type);
        },
      });
      showStatus(`${(data.items || []).length} item(s)`, false);
    } catch (error) {
      showStatus(error.message || "Failed to load files", true);
    }
  }

  async function runSearch(query) {
    try {
      const data = await api.searchFiles({
        path: state.currentPath,
        query,
        recursive: dom.searchRecursive.checked,
        maxResults: 300,
      });
      if (!data) {
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
        onOpenFile: async (targetPath, type) => {
          await preview.openPreview(targetPath, type);
        },
        showParentPath: true,
        basePath: data.base_path || state.currentPath,
      });

      const baseText = data.base_path ? ` in ${data.base_path || "Root"}` : "";
      const truncationText = data.truncated ? " (showing top matches)" : "";
      showStatus(`${(data.items || []).length} match(es)${baseText}${truncationText}`, false);
    } catch (error) {
      showStatus(error.message || "Search failed", true);
    }
  }

  async function navigateAdjacent(direction) {
    const currentFilePath = preview.getCurrentFilePath();
    if (!currentFilePath) {
      return;
    }

    try {
      const data = await api.getAdjacentFile(currentFilePath, direction);
      if (!data) {
        return;
      }
      await preview.openPreview(data.path, data.type);
    } catch (error) {
      showStatus(error.message || "Failed to navigate file", true);
    }
  }

  function showStatus(message, isError) {
    dom.status.classList.remove("hidden");
    dom.status.textContent = message;
    dom.status.classList.toggle("error", Boolean(isError));
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
