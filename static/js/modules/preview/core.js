import { getPathBasename } from "../utils.js";
import { getIconSvg } from "../ui.js";
import {
  MAX_TEXT_PREVIEW_BYTES,
  MAX_TEXT_PREVIEW_CHARS,
  MAX_BINARY_PREVIEW_BYTES,
} from "./shared.js";

export function createPreviewCoreApi(ctx) {
  const { state, modal, modalPreview, downloadLink, onNavigateFile, onUnauthorized } = ctx;
  const teardownPdfState = (...args) => ctx.teardownPdfState(...args);
  const schedulePdfRerender = (...args) => ctx.schedulePdfRerender(...args);
  const changePdfPage = (...args) => ctx.changePdfPage(...args);
  const setPdfZoom = (...args) => ctx.setPdfZoom(...args);
  const resetPdfZoom = (...args) => ctx.resetPdfZoom(...args);
  function buildStreamUrl(path, { cacheBust = false } = {}) {
    const params = new URLSearchParams();
    params.set("path", path);
    if (cacheBust) {
      params.set("v", String(Date.now()));
    }
    return `/stream?${params.toString()}`;
  }

  function buildTranscodeUrl(path, { cacheBust = false } = {}) {
    const params = new URLSearchParams();
    params.set("path", path);
    if (cacheBust) {
      params.set("v", String(Date.now()));
    }
    return `/stream_transcode?${params.toString()}`;
  }

  function isModalOpen() {
    return !modal.classList.contains("hidden");
  }

  function getCurrentFilePath() {
    return state.currentFilePath;
  }

  function updateTopbarInfo(item) {
    let infoSpan = modal.querySelector(".preview-modal-info");

    if (!item) {
      downloadLink.classList.add("hidden");
      downloadLink.removeAttribute("href");
      downloadLink.removeAttribute("download");
      if (infoSpan) infoSpan.remove();
      const stitle = modal.querySelector("#preview-modal-title");
      if (stitle) stitle.classList.add("sr-only");
      return;
    }

    const path = item.path;
    downloadLink.classList.remove("hidden");
    downloadLink.href = `/download?path=${encodeURIComponent(path)}`;
    downloadLink.download = getPathBasename(path);

    if (!infoSpan) {
      infoSpan = document.createElement("div");
      infoSpan.className = "preview-modal-info";
      modal.querySelector(".modal-topbar").insertBefore(infoSpan, downloadLink);
    }

    const titleDiv = document.createElement("div");
    titleDiv.className = "preview-info-title";
    titleDiv.textContent = item.name;

    const metaDiv = document.createElement("div");
    metaDiv.className = "preview-info-meta";
    let details = [];
    if (typeof item.size === "number") details.push(formatBytes(item.size));
    if (item.parent_path) details.push("/" + item.parent_path);
    metaDiv.textContent = details.join(" • ") || "File Info";

    infoSpan.replaceChildren(titleDiv, metaDiv);
  }

  function showModal() {
    const active = document.activeElement;
    if (active instanceof HTMLElement && !modal.contains(active)) {
      state.lastFocusedElement = active;
    }
    document.body.style.overflow = "hidden";
    modal.classList.remove("hidden");
    const closeButton = modal.querySelector("#close-modal, .close-btn");
    if (closeButton instanceof HTMLElement) {
      closeButton.focus({ preventScroll: true });
    }
  }

  function closePreview() {
    state.previewToken += 1;
    teardownModalResources();
    modal.classList.add("hidden");
    document.body.style.overflow = "";
    modalPreview.classList.remove("pdf-mode");
    modalPreview.replaceChildren();
    updateTopbarInfo(null);
    if (state.lastFocusedElement && state.lastFocusedElement.isConnected) {
      state.lastFocusedElement.focus({ preventScroll: true });
    }
    state.lastFocusedElement = null;
  }

  function teardownModalResources() {
    teardownPdfState();
  }

  function handleResize() {
    if (!isModalOpen() || !state.pdf.doc) {
      return;
    }
    schedulePdfRerender();
  }

  function handleModalClick(event) {
    if (event.target === modal) {
      closePreview();
    }
  }

  function handleTouchStart(event) {
    if (event.touches.length !== 1) {
      state.touch.active = false;
      return;
    }
    const touch = event.touches[0];
    state.touch.startX = touch.clientX;
    state.touch.startY = touch.clientY;
    state.touch.active = true;
  }

  function handleTouchEnd(event) {
    if (!state.touch.active || event.changedTouches.length !== 1) {
      state.touch.active = false;
      return;
    }
    state.touch.active = false;
    if (state.pdf.doc) {
      return;
    }

    const touch = event.changedTouches[0];
    const dx = touch.clientX - state.touch.startX;
    const dy = touch.clientY - state.touch.startY;

    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.25) {
      return;
    }

    if (dx < 0) {
      onNavigateFile("next");
    } else {
      onNavigateFile("prev");
    }
  }

  function getModalFocusableElements() {
    return [...modal.querySelectorAll(
      "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
    )].filter((node) => node instanceof HTMLElement && !node.classList.contains("hidden"));
  }

  function handleKeyDown(event) {
    if (!isModalOpen()) {
      return false;
    }

    if (event.key === "Tab") {
      const focusable = getModalFocusableElements();
      if (!focusable.length) {
        event.preventDefault();
        return true;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!focusable.includes(active)) {
        event.preventDefault();
        first.focus();
        return true;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
        return true;
      }
      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
        return true;
      }
    }

    if (event.key === "Escape") {
      closePreview();
      return true;
    }

    if (state.pdf.doc) {
      if (event.key === "ArrowRight") {
        event.preventDefault();
        changePdfPage(1);
        return true;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        changePdfPage(-1);
        return true;
      }
      if (event.key === "=" || event.key === "+") {
        event.preventDefault();
        setPdfZoom(state.pdf.zoomFactor + 0.15);
        return true;
      }
      if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        setPdfZoom(state.pdf.zoomFactor - 0.15);
        return true;
      }
      if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        resetPdfZoom();
        return true;
      }
      return false;
    }

    const video = modalPreview.querySelector("video");
    if (video) {
      if (event.key === "ArrowRight") {
        event.preventDefault();
        video.currentTime = Math.min(video.duration, video.currentTime + 10);
        return true;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        video.currentTime = Math.max(0, video.currentTime - 10);
        return true;
      }
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      onNavigateFile("next");
      return true;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onNavigateFile("prev");
      return true;
    }
    return false;
  }

  async function fetchTextForPreview(path, token) {
    const response = await fetch(buildStreamUrl(path), {
      headers: {
        Range: `bytes=0-${MAX_TEXT_PREVIEW_BYTES - 1}`,
      },
    });
    if (token !== state.previewToken) {
      return null;
    }
    if (response.status === 401) {
      onUnauthorized?.();
      return null;
    }
    if (response.status === 409) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(String(payload?.error || "Selected device is locked. Unlock and retry."));
    }
    if (response.status === 204) {
      throw new Error("Server returned no content (204) for this file preview request.");
    }
    if (!response.ok) {
      throw new Error("Failed to load file text");
    }

    const decoder = new TextDecoder("utf-8", { fatal: false });
    const reader = response.body?.getReader();
    let text = "";
    let bytesRead = 0;
    let truncated = false;

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (token !== state.previewToken) {
          return null;
        }
        if (!value) {
          continue;
        }
        let chunk = value;
        if (bytesRead + chunk.byteLength > MAX_TEXT_PREVIEW_BYTES) {
          chunk = chunk.subarray(0, MAX_TEXT_PREVIEW_BYTES - bytesRead);
          truncated = true;
        }
        bytesRead += chunk.byteLength;
        text += decoder.decode(chunk, { stream: true });
        if (bytesRead >= MAX_TEXT_PREVIEW_BYTES) {
          try {
            await reader.cancel();
          } catch {
            // Ignore reader cancellation issues.
          }
          break;
        }
      }
      text += decoder.decode();
    } else {
      const buffer = await response.arrayBuffer();
      if (token !== state.previewToken) {
        return null;
      }
      const sliced = buffer.byteLength > MAX_TEXT_PREVIEW_BYTES ? buffer.slice(0, MAX_TEXT_PREVIEW_BYTES) : buffer;
      truncated = buffer.byteLength > MAX_TEXT_PREVIEW_BYTES;
      text = decoder.decode(sliced);
      bytesRead = sliced.byteLength;
    }

    const contentRange = response.headers.get("content-range") || "";
    const contentLength = Number(response.headers.get("content-length") || "0");
    const totalFromRange = Number(contentRange.split("/")[1] || "0");
    if (Number.isFinite(totalFromRange) && totalFromRange > 0 && bytesRead < totalFromRange) {
      truncated = true;
    }
    if (!truncated && response.status === 206 && contentLength >= MAX_TEXT_PREVIEW_BYTES) {
      truncated = true;
    }

    const totalChars = text.length;
    if (totalChars > MAX_TEXT_PREVIEW_CHARS) {
      return {
        text: text.slice(0, MAX_TEXT_PREVIEW_CHARS),
        truncated: true,
        totalChars,
      };
    }

    return { text, truncated, totalChars };
  }

  async function fetchBinaryForPreview(path, token, { maxBytes = MAX_BINARY_PREVIEW_BYTES, cacheBust = false } = {}) {
    const response = await fetch(buildStreamUrl(path, { cacheBust }));
    if (token !== state.previewToken) {
      return null;
    }
    if (response.status === 401) {
      onUnauthorized?.();
      return null;
    }
    if (response.status === 409) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(String(payload?.error || "Selected device is locked. Unlock and retry."));
    }
    if (response.status === 204) {
      throw new Error("Server returned no content (204) for this file preview request.");
    }
    if (!response.ok) {
      throw new Error("Failed to load file");
    }

    const contentLength = Number(response.headers.get("content-length") || "0");
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error(`File is too large for inline preview (${formatBytes(contentLength)}). Use Download.`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      const arrayBuffer = await response.arrayBuffer();
      if (token !== state.previewToken) {
        return null;
      }
      if (arrayBuffer.byteLength > maxBytes) {
        throw new Error(`File is too large for inline preview (${formatBytes(arrayBuffer.byteLength)}). Use Download.`);
      }
      return arrayBuffer;
    }

    const chunks = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (token !== state.previewToken) {
        try {
          await reader.cancel();
        } catch {
          // Ignore cancellation issues.
        }
        return null;
      }
      if (!value || !value.byteLength) {
        continue;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Ignore cancellation issues.
        }
        throw new Error(`File is too large for inline preview (${formatBytes(totalBytes)}). Use Download.`);
      }
      chunks.push(value);
    }

    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return merged.buffer;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return "0 B";
    }
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }
    const digits = value >= 100 || unitIndex === 0 ? 0 : 1;
    return `${value.toFixed(digits)} ${units[unitIndex]}`;
  }

  function createPreviewNote(message) {
    const note = document.createElement("div");
    note.className = "preview-note";
    note.textContent = message;
    return note;
  }

  function createFallbackUI(item) {
    const wrap = document.createElement("div");
    wrap.className = "fallback-ui";

    const iconBox = document.createElement("div");
    iconBox.className = "fallback-icon";
    iconBox.innerHTML = getIconSvg(item);

    const titleBox = document.createElement("h2");
    titleBox.className = "fallback-title";
    titleBox.textContent = item.name || "Unknown File";

    const detailsBox = document.createElement("div");
    detailsBox.className = "fallback-details";

    function addDetail(label, val) {
      if (!val && val !== 0) return;
      const row = document.createElement("div");
      row.className = "fallback-detail-row";
      const lbl = document.createElement("span");
      lbl.className = "fallback-label";
      lbl.textContent = label;
      const v = document.createElement("span");
      v.className = "fallback-value";
      v.textContent = val;
      row.append(lbl, v);
      detailsBox.appendChild(row);
    }

    addDetail("Format", item.is_dir ? "Directory" : (item.type || "File").toUpperCase());
    addDetail("Location", item.parent_path ? `/${item.parent_path}` : "/Root");
    if (!item.is_dir) {
      addDetail("File Size", formatBytes(item.size));
    }
    if (item.created_at) {
      addDetail("Created", new Date(item.created_at * 1000).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }));
    }
    if (item.modified_at) {
      addDetail("Modified", new Date(item.modified_at * 1000).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }));
    }

    const note = document.createElement("p");
    note.className = "fallback-note";
    note.textContent = "Preview not available for this file type. Use Download.";

    wrap.append(iconBox, titleBox, detailsBox, note);
    return wrap;
  }

  function createTabSystem(tabDefinitions, defaultTabId) {
    const wrapper = document.createElement("section");
    const tabBar = document.createElement("div");
    tabBar.className = "preview-tabs";
    tabBar.setAttribute("role", "tablist");
    const panes = document.createElement("div");
    const buttons = new Map();
    const paneNodes = new Map();
    const tabOrder = tabDefinitions.map((tab) => tab.id);
    const tabGroupId = `preview-tabs-${Math.random().toString(36).slice(2, 9)}`;

    function activate(tabId) {
      for (const [id, button] of buttons.entries()) {
        button.classList.toggle("active", id === tabId);
        button.setAttribute("aria-selected", String(id === tabId));
        button.tabIndex = id === tabId ? 0 : -1;
      }
      for (const [id, pane] of paneNodes.entries()) {
        pane.classList.toggle("hidden", id !== tabId);
        pane.hidden = id !== tabId;
      }
    }

    for (let index = 0; index < tabDefinitions.length; index += 1) {
      const tab = tabDefinitions[index];
      const tabButtonId = `${tabGroupId}-tab-${index}`;
      const tabPanelId = `${tabGroupId}-panel-${index}`;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "preview-tab";
      button.textContent = tab.label;
      button.id = tabButtonId;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-controls", tabPanelId);
      button.addEventListener("click", () => activate(tab.id));
      button.addEventListener("keydown", (event) => {
        const key = event.key;
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) {
          return;
        }
        event.preventDefault();
        const currentIndex = tabOrder.indexOf(tab.id);
        if (currentIndex < 0) {
          return;
        }
        let nextIndex = currentIndex;
        if (key === "ArrowRight") {
          nextIndex = (currentIndex + 1) % tabOrder.length;
        } else if (key === "ArrowLeft") {
          nextIndex = (currentIndex - 1 + tabOrder.length) % tabOrder.length;
        } else if (key === "Home") {
          nextIndex = 0;
        } else if (key === "End") {
          nextIndex = tabOrder.length - 1;
        }
        const nextId = tabOrder[nextIndex];
        const nextButton = buttons.get(nextId);
        if (nextButton) {
          activate(nextId);
          nextButton.focus();
        }
      });
      buttons.set(tab.id, button);
      tabBar.appendChild(button);

      const pane = document.createElement("section");
      pane.className = "preview-pane";
      pane.id = tabPanelId;
      pane.setAttribute("role", "tabpanel");
      pane.setAttribute("aria-labelledby", tabButtonId);
      pane.appendChild(tab.content);
      paneNodes.set(tab.id, pane);
      panes.appendChild(pane);
    }

    wrapper.append(tabBar, panes);
    activate(defaultTabId ?? tabDefinitions[0]?.id);
    return wrapper;
  }

  function escapeHtml(input) {
    return input
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  return {
    buildStreamUrl,
    buildTranscodeUrl,
    isModalOpen,
    getCurrentFilePath,
    updateTopbarInfo,
    showModal,
    closePreview,
    teardownModalResources,
    handleResize,
    handleModalClick,
    handleTouchStart,
    handleTouchEnd,
    getModalFocusableElements,
    handleKeyDown,
    fetchTextForPreview,
    fetchBinaryForPreview,
    formatBytes,
    createPreviewNote,
    createFallbackUI,
    createTabSystem,
    escapeHtml,
  };
}
