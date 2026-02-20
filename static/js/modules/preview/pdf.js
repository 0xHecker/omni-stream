import {
  PDF_JS_VERSION,
  PDF_JS_MAIN_URL,
  PDF_JS_WORKER_URL,
  MAX_PDF_PREVIEW_BYTES,
} from "./shared.js";

export function createPreviewPdfApi(ctx) {
  const { state, modalPreview, showStatus } = ctx;
  const buildStreamUrl = (...args) => ctx.buildStreamUrl(...args);
  const fetchBinaryForPreview = (...args) => ctx.fetchBinaryForPreview(...args);
  const createPreviewNote = (...args) => ctx.createPreviewNote(...args);
  async function getPdfJsLib() {
    if (!ctx.pdfJsLibPromise) {
      ctx.pdfJsLibPromise = import(PDF_JS_MAIN_URL)
        .then((lib) => {
          lib.GlobalWorkerOptions.workerSrc = PDF_JS_WORKER_URL;
          return lib;
        })
        .catch((error) => {
          ctx.pdfJsLibPromise = null;
          throw error;
        });
    }
    return ctx.pdfJsLibPromise;
  }

  function createPdfButton(label, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pdf-btn";
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  }

  async function renderPdfPreview(path, token) {
    const loading = document.createElement("div");
    loading.className = "pdf-loading";
    loading.textContent = `Loading PDF viewer (PDF.js ${PDF_JS_VERSION})...`;
    modalPreview.appendChild(loading);

    let pdfjsLib = null;
    try {
      pdfjsLib = await getPdfJsLib();
    } catch {
      const fallbackFrame = document.createElement("iframe");
      fallbackFrame.className = "html-preview-frame";
      fallbackFrame.src = buildStreamUrl(path, { cacheBust: true });
      fallbackFrame.title = "PDF preview";
      modalPreview.replaceChildren(
        createPreviewNote("PDF.js is unavailable offline. Using browser PDF preview fallback."),
        fallbackFrame,
      );
      return;
    }
    if (token !== state.previewToken) {
      return;
    }

    modalPreview.replaceChildren();
    modalPreview.classList.add("pdf-mode");

    const shell = document.createElement("section");
    shell.className = "pdf-shell";

    const toolbar = document.createElement("div");
    toolbar.className = "pdf-toolbar";

    const pageGroup = document.createElement("div");
    pageGroup.className = "pdf-group";
    const prevPageButton = createPdfButton("Prev Page", () => changePdfPage(-1));
    const pageLabel = document.createElement("span");
    pageLabel.className = "pdf-page-label";
    const nextPageButton = createPdfButton("Next Page", () => changePdfPage(1));
    pageGroup.append(prevPageButton, pageLabel, nextPageButton);

    const zoomGroup = document.createElement("div");
    zoomGroup.className = "pdf-group";
    const zoomOutButton = createPdfButton("Zoom -", () => setPdfZoom(state.pdf.zoomFactor - 0.15));
    const zoomLabel = document.createElement("span");
    zoomLabel.className = "pdf-zoom-label";
    const zoomInButton = createPdfButton("Zoom +", () => setPdfZoom(state.pdf.zoomFactor + 0.15));
    const fitButton = createPdfButton("Fit", () => resetPdfZoom());
    const openButton = createPdfButton("Open Tab", () => {
      window.open(buildStreamUrl(path, { cacheBust: true }), "_blank", "noopener");
    });
    zoomGroup.append(zoomOutButton, zoomLabel, zoomInButton, fitButton, openButton);

    toolbar.append(pageGroup, zoomGroup);

    const canvasWrap = document.createElement("div");
    canvasWrap.className = "pdf-canvas-wrap";
    const canvas = document.createElement("canvas");
    canvas.className = "pdf-canvas";
    canvasWrap.appendChild(canvas);

    shell.append(toolbar, canvasWrap);
    modalPreview.appendChild(shell);

    const primaryUrl = buildStreamUrl(path, { cacheBust: true });
    let pdfDoc = null;
    let primaryError = null;

    try {
      const loadingTask = pdfjsLib.getDocument({ url: primaryUrl });
      state.pdf.loadingTask = loadingTask;
      pdfDoc = await loadingTask.promise;
    } catch (error) {
      primaryError = error;
      state.pdf.loadingTask = null;
    }

    if (!pdfDoc) {
      const arrayBuffer = await fetchBinaryForPreview(path, token, {
        maxBytes: MAX_PDF_PREVIEW_BYTES,
        cacheBust: true,
      });
      if (!arrayBuffer || token !== state.previewToken) {
        return;
      }
      try {
        const fallbackTask = pdfjsLib.getDocument({
          data: arrayBuffer,
          disableAutoFetch: true,
        });
        state.pdf.loadingTask = fallbackTask;
        pdfDoc = await fallbackTask.promise;
      } catch (error) {
        const primaryText = primaryError?.message || "Unknown error";
        const fallbackText = error?.message || "Unknown error";
        throw new Error(`PDF load failed (URL mode: ${primaryText}; binary mode: ${fallbackText})`);
      }
    }

    if (!pdfDoc) {
      throw new Error("PDF load failed.");
    }

    if (token !== state.previewToken) {
      const destroyResult = pdfDoc.destroy();
      if (destroyResult && typeof destroyResult.catch === "function") {
        destroyResult.catch(() => {
          // Ignore destroy errors.
        });
      }
      return;
    }

    state.pdf.doc = pdfDoc;
    state.pdf.pageNumber = 1;
    state.pdf.totalPages = pdfDoc.numPages;
    state.pdf.zoomFactor = 1;
    state.pdf.canvas = canvas;
    state.pdf.canvasWrap = canvasWrap;
    state.pdf.pageLabel = pageLabel;
    state.pdf.zoomLabel = zoomLabel;
    state.pdf.prevPageButton = prevPageButton;
    state.pdf.nextPageButton = nextPageButton;
    state.pdf.loadingTask = null;

    updatePdfToolbar();
    await renderPdfPage(token);
  }

  function updatePdfToolbar() {
    if (!state.pdf.pageLabel || !state.pdf.zoomLabel) {
      return;
    }

    state.pdf.pageLabel.textContent = `${state.pdf.pageNumber} / ${Math.max(state.pdf.totalPages, 1)}`;
    state.pdf.zoomLabel.textContent = `${Math.round(state.pdf.zoomFactor * 100)}%`;

    if (state.pdf.prevPageButton) {
      state.pdf.prevPageButton.disabled = state.pdf.pageNumber <= 1;
    }
    if (state.pdf.nextPageButton) {
      state.pdf.nextPageButton.disabled = state.pdf.pageNumber >= state.pdf.totalPages;
    }
  }

  async function renderPdfPage(token = state.previewToken) {
    if (!state.pdf.doc || !state.pdf.canvas || !state.pdf.canvasWrap) {
      return;
    }

    if (state.pdf.renderTask) {
      try {
        state.pdf.renderTask.cancel();
      } catch {
        // Ignore cancel errors.
      }
      state.pdf.renderTask = null;
    }

    const page = await state.pdf.doc.getPage(state.pdf.pageNumber);
    if (token !== state.previewToken) {
      return;
    }

    const baseViewport = page.getViewport({ scale: 1 });
    const availableWidth = Math.max(240, state.pdf.canvasWrap.clientWidth - 24);
    const fitScale = availableWidth / baseViewport.width;
    const viewport = page.getViewport({ scale: fitScale * state.pdf.zoomFactor });
    const outputScale = window.devicePixelRatio || 1;

    const context = state.pdf.canvas.getContext("2d", { alpha: false });
    if (!context) {
      throw new Error("Unable to initialize PDF canvas context");
    }

    state.pdf.canvas.width = Math.floor(viewport.width * outputScale);
    state.pdf.canvas.height = Math.floor(viewport.height * outputScale);
    state.pdf.canvas.style.width = `${Math.floor(viewport.width)}px`;
    state.pdf.canvas.style.height = `${Math.floor(viewport.height)}px`;

    const renderTask = page.render({
      canvasContext: context,
      viewport,
      transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0],
      background: "rgb(255,255,255)",
    });

    state.pdf.renderTask = renderTask;
    updatePdfToolbar();

    try {
      await renderTask.promise;
    } catch (error) {
      if (error?.name !== "RenderingCancelledException") {
        throw error;
      }
    } finally {
      if (state.pdf.renderTask === renderTask) {
        state.pdf.renderTask = null;
      }
    }
  }

  function schedulePdfRerender() {
    if (!state.pdf.doc) {
      return;
    }

    if (state.pdf.rerenderFrame) {
      window.cancelAnimationFrame(state.pdf.rerenderFrame);
    }

    state.pdf.rerenderFrame = window.requestAnimationFrame(async () => {
      state.pdf.rerenderFrame = 0;
      try {
        await renderPdfPage(state.previewToken);
      } catch (error) {
        showStatus(error?.message || "Unable to rerender PDF", true);
      }
    });
  }

  async function changePdfPage(delta) {
    if (!state.pdf.doc) {
      return;
    }
    const nextPage = state.pdf.pageNumber + delta;
    if (nextPage < 1 || nextPage > state.pdf.totalPages) {
      return;
    }

    state.pdf.pageNumber = nextPage;
    try {
      await renderPdfPage(state.previewToken);
    } catch (error) {
      showStatus(error?.message || "Unable to change PDF page", true);
    }
  }

  function setPdfZoom(nextZoomFactor) {
    if (!state.pdf.doc) {
      return;
    }
    const clamped = Math.min(3, Math.max(0.5, nextZoomFactor));
    state.pdf.zoomFactor = clamped;
    updatePdfToolbar();
    schedulePdfRerender();
  }

  function resetPdfZoom() {
    if (!state.pdf.doc) {
      return;
    }
    state.pdf.zoomFactor = 1;
    updatePdfToolbar();
    schedulePdfRerender();
  }

  function teardownPdfState() {
    if (state.pdf.rerenderFrame) {
      window.cancelAnimationFrame(state.pdf.rerenderFrame);
      state.pdf.rerenderFrame = 0;
    }

    if (state.pdf.renderTask) {
      try {
        state.pdf.renderTask.cancel();
      } catch {
        // Ignore cancel errors.
      }
      state.pdf.renderTask = null;
    }

    if (state.pdf.loadingTask) {
      try {
        state.pdf.loadingTask.destroy();
      } catch {
        // Ignore destroy errors.
      }
      state.pdf.loadingTask = null;
    }

    if (state.pdf.doc) {
      const destroyResult = state.pdf.doc.destroy();
      if (destroyResult && typeof destroyResult.catch === "function") {
        destroyResult.catch(() => {
          // Ignore destroy errors.
        });
      }
    }

    state.pdf.doc = null;
    state.pdf.pageNumber = 1;
    state.pdf.totalPages = 0;
    state.pdf.zoomFactor = 1;
    state.pdf.canvas = null;
    state.pdf.canvasWrap = null;
    state.pdf.pageLabel = null;
    state.pdf.zoomLabel = null;
    state.pdf.prevPageButton = null;
    state.pdf.nextPageButton = null;
  }
  return {
    getPdfJsLib,
    createPdfButton,
    renderPdfPreview,
    updatePdfToolbar,
    renderPdfPage,
    schedulePdfRerender,
    changePdfPage,
    setPdfZoom,
    resetPdfZoom,
    teardownPdfState,
  };
}
