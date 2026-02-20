import { getPathBasename, getPathExtension, normalizePath } from "../utils.js";
import {
  MAX_TEXT_PREVIEW_CHARS,
  MAX_WORD_PREVIEW_BYTES,
  MAX_EXCEL_PREVIEW_BYTES,
  MAX_SHEET_ROWS,
  MAX_SHEET_COLS,
  MAMMOTH_VERSION,
  SHEETJS_VERSION,
} from "./shared.js";

export function createPreviewRenderApi(ctx) {
  const { state, modalPreview, api } = ctx;
  const buildStreamUrl = (...args) => ctx.buildStreamUrl(...args);
  const buildTranscodeUrl = (...args) => ctx.buildTranscodeUrl(...args);
  const createPreviewNote = (...args) => ctx.createPreviewNote(...args);
  const fetchTextForPreview = (...args) => ctx.fetchTextForPreview(...args);
  const fetchBinaryForPreview = (...args) => ctx.fetchBinaryForPreview(...args);
  const guessCodeLanguage = (...args) => ctx.guessCodeLanguage(...args);
  const createCodePanel = (...args) => ctx.createCodePanel(...args);
  const ensureMarkdownLibraries = (...args) => ctx.ensureMarkdownLibraries(...args);
  const getMarkdownRenderer = (...args) => ctx.getMarkdownRenderer(...args);
  const createTabSystem = (...args) => ctx.createTabSystem(...args);
  const ensureWordLibraries = (...args) => ctx.ensureWordLibraries(...args);
  const ensureSpreadsheetLibraries = (...args) => ctx.ensureSpreadsheetLibraries(...args);
  const formatBytes = (...args) => ctx.formatBytes(...args);
  const updateTopbarInfo = (...args) => ctx.updateTopbarInfo(...args);
  const showModal = (...args) => ctx.showModal(...args);
  const teardownModalResources = (...args) => ctx.teardownModalResources(...args);
  const createFallbackUI = (...args) => ctx.createFallbackUI(...args);
  const renderPdfPreview = (...args) => ctx.renderPdfPreview(...args);
  function renderVideoPreview(path) {
    const extension = getPathExtension(path).toLowerCase();
    const preferCompatStream = [".mkv", ".avi", ".flv", ".wmv"].includes(extension);
    const directUrl = buildStreamUrl(path, { cacheBust: true });

    // We will append start parameter manually
    const compatUrlBase = buildTranscodeUrl(path, { cacheBust: true });

    let usingCompat = preferCompatStream;
    let triedDirectFallback = false;
    let triedCompatFallback = false;
    let videoDuration = 0;
    let activeCompatOffset = 0;

    const wrap = document.createElement("div");
    wrap.className = "video-preview-wrap";

    const controls = document.createElement("div");
    controls.className = "video-preview-actions";
    const compatButton = document.createElement("button");
    compatButton.type = "button";
    compatButton.className = "code-btn";
    compatButton.textContent = "Compatibility Audio";

    const video = document.createElement("video");
    video.controls = true;
    video.preload = "metadata";
    const storageKey = `video-time:${path}`;
    const savedTime = Number(sessionStorage.getItem(storageKey) || "0");
    if (savedTime > 0) {
      if (usingCompat) {
        activeCompatOffset = savedTime;
      } else {
        video.addEventListener("loadedmetadata", () => {
          if (Number.isFinite(savedTime) && savedTime < video.duration) {
            video.currentTime = savedTime;
          }
        });
      }
    }

    // Compat Custom Seek UI
    const seekWrap = document.createElement("div");
    seekWrap.className = "compat-seek-wrap hidden";
    const seekLabel = document.createElement("span");
    seekLabel.className = "fallback-label";
    seekLabel.textContent = "Seek: ";
    const seekSlider = document.createElement("input");
    seekSlider.type = "range";
    seekSlider.className = "compat-seek-slider";
    seekSlider.min = 0;
    seekSlider.max = 100;
    seekSlider.value = activeCompatOffset;
    seekWrap.append(seekLabel, seekSlider);

    const updateSeekUI = () => {
      if (usingCompat && videoDuration > 0) {
        seekWrap.classList.remove("hidden");
        seekSlider.max = videoDuration;
      } else {
        seekWrap.classList.add("hidden");
      }
    };

    seekSlider.addEventListener("change", (e) => {
      const newTime = Number(e.target.value);
      activeCompatOffset = newTime;
      sessionStorage.setItem(storageKey, String(newTime));
      video.src = compatUrlBase + "&start=" + newTime;
      video.play().catch(() => { });
    });

    if (api && api.getVideoInfo) {
      api.getVideoInfo(path).then(res => {
        if (res && res.duration > 0) {
          videoDuration = res.duration;
          updateSeekUI();
        }
      }).catch(() => { });
    }

    video.src = usingCompat ? (compatUrlBase + "&start=" + activeCompatOffset) : directUrl;
    video.playsInline = true;
    video.setAttribute("playsinline", "");

    video.addEventListener("timeupdate", () => {
      const realTime = usingCompat ? (activeCompatOffset + video.currentTime) : video.currentTime;
      sessionStorage.setItem(storageKey, String(realTime));
      if (usingCompat && videoDuration > 0) {
        seekSlider.value = realTime;
      }
    });

    const switchToSource = (nextSource) => {
      const previousTime = usingCompat ? (activeCompatOffset + video.currentTime) : (video.currentTime || 0);
      const wasPaused = video.paused;
      usingCompat = nextSource === "compat";
      updateSeekUI();

      if (usingCompat) {
        activeCompatOffset = previousTime;
        video.src = compatUrlBase + "&start=" + activeCompatOffset;
      } else {
        video.src = directUrl;
      }
      video.addEventListener("loadedmetadata", () => {
        if (previousTime > 0 && Number.isFinite(video.duration) && previousTime < video.duration) {
          video.currentTime = previousTime;
        }
        if (!wasPaused) {
          video.play().catch(() => {
            // Browser can block autoplay after source switches.
          });
        }
      }, { once: true });
      video.load();
    };

    video.addEventListener("error", () => {
      if (!usingCompat) {
        if (triedCompatFallback) {
          modalPreview.replaceChildren(
            createPreviewNote("Video preview failed on this device/browser. Use Download."),
          );
          return;
        }
        triedCompatFallback = true;
        switchToSource("compat");
        return;
      }
      if (!triedDirectFallback) {
        triedDirectFallback = true;
        switchToSource("direct");
        return;
      }
      if (!triedCompatFallback) {
        triedCompatFallback = true;
        switchToSource("compat");
        return;
      }
      modalPreview.replaceChildren(
        createPreviewNote("Video preview failed (compat mode unavailable). Install ffmpeg on server or use Download."),
      );
    });

    compatButton.addEventListener("click", () => {
      if (usingCompat) {
        return;
      }
      triedCompatFallback = true;
      switchToSource("compat");
    });

    if (preferCompatStream) {
      triedCompatFallback = true;
    } else {
      triedDirectFallback = true;
    }

    if (preferCompatStream) {
      const note = createPreviewNote("Compatibility mode is enabled for this video format to preserve audio.");
      wrap.appendChild(note);
    }

    controls.appendChild(compatButton);
    wrap.append(controls, video);
    modalPreview.appendChild(wrap);
  }

  function renderImagePreview(path) {
    const image = document.createElement("img");
    image.src = buildStreamUrl(path, { cacheBust: true });
    image.alt = "Image preview";
    image.addEventListener("error", () => {
      modalPreview.replaceChildren(
        createPreviewNote("Image preview is unavailable on this device/browser for this format. Use Download."),
      );
    });
    modalPreview.appendChild(image);
  }

  async function renderCodeFilePreview(path, token, type) {
    const textData = await fetchTextForPreview(path, token);
    if (!textData || token !== state.previewToken) {
      return;
    }

    const language = type === "text" ? "plaintext" : guessCodeLanguage(path);
    const codePanel = await createCodePanel(textData.text, {
      title: getPathBasename(path),
      language,
      defaultWrap: type === "text",
    });

    modalPreview.replaceChildren(codePanel);
    if (textData.truncated) {
      modalPreview.prepend(
        createPreviewNote(`Showing first ${MAX_TEXT_PREVIEW_CHARS.toLocaleString()} characters for performance.`),
      );
    }
  }

  async function renderMarkdownPreview(path, token) {
    const textData = await fetchTextForPreview(path, token);
    if (!textData || token !== state.previewToken) {
      return;
    }

    try {
      await ensureMarkdownLibraries();
    } catch {
      const fallbackPanel = await createCodePanel(textData.text, {
        title: `${getPathBasename(path)} (Markdown Fallback)`,
        language: "markdown",
        defaultWrap: true,
      });
      modalPreview.replaceChildren(
        createPreviewNote("Markdown renderer failed to load. Showing source view."),
        fallbackPanel,
      );
      return;
    }

    if (token !== state.previewToken) {
      return;
    }

    const markdownRenderer = getMarkdownRenderer();
    const renderContainer = document.createElement("article");
    renderContainer.className = "markdown-render";
    renderContainer.innerHTML = window.DOMPurify.sanitize(markdownRenderer.render(textData.text), {
      USE_PROFILES: { html: true },
    });

    const sourcePanel = await createCodePanel(textData.text, {
      title: getPathBasename(path),
      language: "markdown",
      defaultWrap: true,
    });

    const tabs = createTabSystem(
      [
        { id: "render", label: "Render", content: renderContainer },
        { id: "source", label: "Source", content: sourcePanel },
      ],
      "render",
    );

    modalPreview.replaceChildren(tabs);
    if (textData.truncated) {
      modalPreview.prepend(
        createPreviewNote(`Markdown preview truncated to ${MAX_TEXT_PREVIEW_CHARS.toLocaleString()} characters.`),
      );
    }
  }

  async function renderHtmlPreview(path, token) {
    const textData = await fetchTextForPreview(path, token);
    if (!textData || token !== state.previewToken) {
      return;
    }

    const iframe = document.createElement("iframe");
    iframe.className = "html-preview-frame";
    iframe.setAttribute("sandbox", "");
    iframe.srcdoc = textData.text;

    const sourcePanel = await createCodePanel(textData.text, {
      title: getPathBasename(path),
      language: "xml",
      defaultWrap: true,
    });

    const tabs = createTabSystem(
      [
        { id: "source", label: "Code", content: sourcePanel },
        { id: "render", label: "Render", content: iframe },
      ],
      "source",
    );
    modalPreview.replaceChildren(tabs);

    if (textData.truncated) {
      modalPreview.prepend(
        createPreviewNote(`HTML preview truncated to ${MAX_TEXT_PREVIEW_CHARS.toLocaleString()} characters.`),
      );
    }
  }

  async function renderSvgPreview(path, token) {
    const textData = await fetchTextForPreview(path, token);
    if (!textData || token !== state.previewToken) {
      return;
    }

    const previewWrap = document.createElement("div");
    previewWrap.className = "svg-preview-wrap";

    const previewImage = document.createElement("img");
    previewImage.src = buildStreamUrl(path, { cacheBust: true });
    previewImage.alt = "SVG preview";
    previewImage.addEventListener("error", () => {
      previewWrap.replaceChildren(
        createPreviewNote("SVG preview failed in this browser. Source is still available."),
      );
    });
    previewWrap.appendChild(previewImage);

    const sourcePanel = await createCodePanel(textData.text, {
      title: getPathBasename(path),
      language: "xml",
      defaultWrap: true,
    });

    const tabs = createTabSystem(
      [
        { id: "preview", label: "Preview", content: previewWrap },
        { id: "source", label: "Code", content: sourcePanel },
      ],
      "preview",
    );

    modalPreview.replaceChildren(tabs);
    if (textData.truncated) {
      modalPreview.prepend(
        createPreviewNote(`SVG source truncated to ${MAX_TEXT_PREVIEW_CHARS.toLocaleString()} characters.`),
      );
    }
  }

  async function renderWordPreview(path, token) {
    const extension = getPathExtension(path);
    if (extension === ".doc") {
      modalPreview.replaceChildren(
        createPreviewNote("Legacy .doc files are not fully supported in-browser. Use Download or convert to .docx."),
      );
      return;
    }

    modalPreview.replaceChildren(createPreviewNote(`Loading Word renderer (Mammoth ${MAMMOTH_VERSION})...`));

    try {
      await ensureWordLibraries();
    } catch {
      modalPreview.replaceChildren(createPreviewNote("Word renderer could not load. Use Download."));
      return;
    }

    if (token !== state.previewToken) {
      return;
    }

    const arrayBuffer = await fetchBinaryForPreview(path, token);
    if (!arrayBuffer || token !== state.previewToken) {
      return;
    }
    if (arrayBuffer.byteLength > MAX_WORD_PREVIEW_BYTES) {
      throw new Error(`Word preview is limited to ${formatBytes(MAX_WORD_PREVIEW_BYTES)}. Use Download.`);
    }

    let result;
    try {
      result = await window.mammoth.convertToHtml({ arrayBuffer });
    } catch {
      throw new Error("Word preview failed. File may be protected or unsupported.");
    }

    if (token !== state.previewToken) {
      return;
    }

    const article = document.createElement("article");
    article.className = "word-render";
    article.innerHTML = window.DOMPurify.sanitize(result.value, { USE_PROFILES: { html: true } });

    const nodes = [];
    if (result.messages?.length) {
      nodes.push(createPreviewNote("Some document formatting could not be fully rendered."));
    }
    nodes.push(article);
    modalPreview.replaceChildren(...nodes);
  }

  async function renderExcelPreview(path, token) {
    modalPreview.replaceChildren(
      createPreviewNote(`Loading Spreadsheet renderer (SheetJS ${SHEETJS_VERSION})...`),
    );

    try {
      await ensureSpreadsheetLibraries();
    } catch {
      const extension = getPathExtension(path);
      if (extension === ".csv" || extension === ".tsv") {
        await renderCodeFilePreview(path, token, "text");
        return;
      }
      modalPreview.replaceChildren(createPreviewNote("Spreadsheet renderer could not load. Use Download."));
      return;
    }

    if (token !== state.previewToken) {
      return;
    }

    const arrayBuffer = await fetchBinaryForPreview(path, token);
    if (!arrayBuffer || token !== state.previewToken) {
      return;
    }
    if (arrayBuffer.byteLength > MAX_EXCEL_PREVIEW_BYTES) {
      throw new Error(`Spreadsheet preview is limited to ${formatBytes(MAX_EXCEL_PREVIEW_BYTES)}. Use Download.`);
    }

    let workbook;
    try {
      workbook = window.XLSX.read(arrayBuffer, { type: "array" });
    } catch {
      throw new Error("Spreadsheet preview failed. File may be malformed or unsupported.");
    }

    const sheetNames = workbook.SheetNames || [];
    if (!sheetNames.length) {
      modalPreview.replaceChildren(createPreviewNote("This spreadsheet has no readable sheets."));
      return;
    }

    const shell = document.createElement("section");
    shell.className = "sheet-shell";
    const tabs = document.createElement("div");
    tabs.className = "sheet-tabs";
    const tableWrap = document.createElement("div");
    tableWrap.className = "sheet-table-wrap";

    function renderSheet(sheetName) {
      const worksheet = workbook.Sheets[sheetName];
      const rows = window.XLSX.utils.sheet_to_json(worksheet, {
        header: 1,
        raw: false,
        blankrows: false,
        defval: "",
      });

      tableWrap.replaceChildren();
      if (!rows.length) {
        tableWrap.appendChild(createPreviewNote("Selected sheet is empty."));
        return;
      }

      const totalRows = rows.length;
      let totalCols = 0;
      for (const row of rows) {
        totalCols = Math.max(totalCols, Array.isArray(row) ? row.length : 0);
      }

      const croppedRows = rows.slice(0, MAX_SHEET_ROWS).map((row) => row.slice(0, MAX_SHEET_COLS));
      const table = document.createElement("table");
      table.className = "sheet-table";

      const firstRow = croppedRows[0] || [];
      const columnCount = Math.max(firstRow.length, 1);

      const thead = document.createElement("thead");
      const headerTr = document.createElement("tr");
      for (let col = 0; col < columnCount; col += 1) {
        const th = document.createElement("th");
        th.textContent = String(firstRow[col] ?? `Column ${col + 1}`);
        headerTr.appendChild(th);
      }
      thead.appendChild(headerTr);
      table.appendChild(thead);

      const tbody = document.createElement("tbody");
      for (let rowIndex = 1; rowIndex < croppedRows.length; rowIndex += 1) {
        const row = croppedRows[rowIndex];
        const tr = document.createElement("tr");
        const cellCount = Math.max(row.length, columnCount);
        for (let col = 0; col < cellCount; col += 1) {
          const td = document.createElement("td");
          td.textContent = String(row[col] ?? "");
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);

      if (totalRows > MAX_SHEET_ROWS || totalCols > MAX_SHEET_COLS) {
        tableWrap.appendChild(
          createPreviewNote(
            `Showing first ${MAX_SHEET_ROWS} rows x ${MAX_SHEET_COLS} columns for performance (full data is in Download).`,
          ),
        );
      }
      tableWrap.appendChild(table);
    }

    const buttons = [];
    for (const sheetName of sheetNames) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "sheet-tab";
      button.textContent = sheetName;
      button.addEventListener("click", () => {
        for (const item of buttons) {
          item.classList.remove("active");
        }
        button.classList.add("active");
        renderSheet(sheetName);
      });
      buttons.push(button);
      tabs.appendChild(button);
    }

    shell.append(tabs, tableWrap);
    modalPreview.replaceChildren(shell);

    buttons[0].classList.add("active");
    renderSheet(sheetNames[0]);
  }

  async function openPreview(item) {
    const safePath = normalizePath(item.path);
    const type = item.type;
    const token = state.previewToken + 1;
    state.previewToken = token;
    state.currentFilePath = safePath;

    teardownModalResources();
    modalPreview.classList.remove("pdf-mode");
    modalPreview.replaceChildren();
    updateTopbarInfo(item);
    showModal();

    try {
      if (type === "video") {
        renderVideoPreview(safePath);
        return;
      }
      if (type === "image") {
        renderImagePreview(safePath);
        return;
      }
      if (type === "pdf") {
        await renderPdfPreview(safePath, token);
        return;
      }
      if (type === "svg") {
        await renderSvgPreview(safePath, token);
        return;
      }
      if (type === "markdown") {
        await renderMarkdownPreview(safePath, token);
        return;
      }
      if (type === "html") {
        await renderHtmlPreview(safePath, token);
        return;
      }
      if (type === "word") {
        await renderWordPreview(safePath, token);
        return;
      }
      if (type === "excel") {
        await renderExcelPreview(safePath, token);
        return;
      }
      if (type === "code" || type === "text") {
        await renderCodeFilePreview(safePath, token, type);
        return;
      }

      modalPreview.replaceChildren(createFallbackUI(item));
    } catch (error) {
      if (token !== state.previewToken) {
        return;
      }
      const text = error?.message || "Unknown error";
      modalPreview.replaceChildren(createPreviewNote(`Preview failed: ${text}`));
    }
  }
  return {
    renderVideoPreview,
    renderImagePreview,
    renderCodeFilePreview,
    renderMarkdownPreview,
    renderHtmlPreview,
    renderSvgPreview,
    renderWordPreview,
    renderExcelPreview,
    openPreview,
  };
}
