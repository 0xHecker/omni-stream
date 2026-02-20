import { createPreviewCoreApi } from "./preview/core.js";
import { createPreviewResourceApi } from "./preview/resources.js";
import { createPreviewRenderApi } from "./preview/renderers.js";
import { createPreviewPdfApi } from "./preview/pdf.js";

export function createPreviewController({
  modal,
  modalPreview,
  downloadLink,
  showStatus,
  onNavigateFile,
  onUnauthorized,
  api,
}) {
  const state = {
    currentFilePath: "",
    previewToken: 0,
    markdownRenderer: null,
    lastFocusedElement: null,
    touch: {
      startX: 0,
      startY: 0,
      active: false,
    },
    pdf: {
      loadingTask: null,
      doc: null,
      renderTask: null,
      pageNumber: 1,
      totalPages: 0,
      zoomFactor: 1,
      rerenderFrame: 0,
      canvas: null,
      canvasWrap: null,
      pageLabel: null,
      zoomLabel: null,
      prevPageButton: null,
      nextPageButton: null,
    },
  };

  const ctx = {
    modal,
    modalPreview,
    downloadLink,
    showStatus,
    onNavigateFile,
    onUnauthorized,
    api,
    state,
    scriptLoadCache: new Map(),
    styleLoadCache: new Map(),
    pdfJsLibPromise: null,
  };

  Object.assign(ctx, createPreviewCoreApi(ctx));
  Object.assign(ctx, createPreviewResourceApi(ctx));
  Object.assign(ctx, createPreviewRenderApi(ctx));
  Object.assign(ctx, createPreviewPdfApi(ctx));

  return {
    openPreview: ctx.openPreview,
    closePreview: ctx.closePreview,
    handleKeyDown: ctx.handleKeyDown,
    handleResize: ctx.handleResize,
    handleModalClick: ctx.handleModalClick,
    handleTouchStart: ctx.handleTouchStart,
    handleTouchEnd: ctx.handleTouchEnd,
    getCurrentFilePath: ctx.getCurrentFilePath,
    isModalOpen: ctx.isModalOpen,
  };
}
