import { getPathBasename, getPathExtension, normalizePath } from "./utils.js";

const PDF_JS_VERSION = "5.4.624";
const PDF_JS_MAIN_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDF_JS_VERSION}/build/pdf.min.mjs`;
const PDF_JS_WORKER_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDF_JS_VERSION}/build/pdf.worker.min.mjs`;

const MARKDOWN_IT_VERSION = "14.1.1";
const MARKDOWN_IT_URL = `https://cdn.jsdelivr.net/npm/markdown-it@${MARKDOWN_IT_VERSION}/dist/markdown-it.min.js`;
const DOMPURIFY_VERSION = "3.3.1";
const DOMPURIFY_URL = `https://cdn.jsdelivr.net/npm/dompurify@${DOMPURIFY_VERSION}/dist/purify.min.js`;
const HIGHLIGHT_VERSION = "11.11.1";
const HIGHLIGHT_URL = `https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@${HIGHLIGHT_VERSION}/highlight.min.js`;
const HIGHLIGHT_THEME_URL = `https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@${HIGHLIGHT_VERSION}/styles/github-dark.min.css`;
const MAMMOTH_VERSION = "1.11.0";
const MAMMOTH_URL = `https://cdn.jsdelivr.net/npm/mammoth@${MAMMOTH_VERSION}/mammoth.browser.min.js`;
const SHEETJS_VERSION = "0.20.3";
const SHEETJS_URL = `https://cdn.sheetjs.com/xlsx-${SHEETJS_VERSION}/package/dist/xlsx.full.min.js`;

const MAX_TEXT_PREVIEW_CHARS = 1200000;
const MAX_SHEET_ROWS = 500;
const MAX_SHEET_COLS = 80;

export function createPreviewController({
  modal,
  modalPreview,
  downloadLink,
  showStatus,
  onNavigateFile,
  onUnauthorized,
}) {
  const state = {
    currentFilePath: "",
    previewToken: 0,
    markdownRenderer: null,
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

  const scriptLoadCache = new Map();
  const styleLoadCache = new Set();
  let pdfJsLibPromise = null;

  function isModalOpen() {
    return !modal.classList.contains("hidden");
  }

  function getCurrentFilePath() {
    return state.currentFilePath;
  }

  function updateDownloadLink(path) {
    if (!path) {
      downloadLink.classList.add("hidden");
      downloadLink.removeAttribute("href");
      downloadLink.removeAttribute("download");
      return;
    }

    downloadLink.classList.remove("hidden");
    downloadLink.href = `/download?path=${encodeURIComponent(path)}`;
    downloadLink.download = getPathBasename(path);
  }

  function showModal() {
    modal.classList.remove("hidden");
  }

  function closePreview() {
    state.previewToken += 1;
    teardownModalResources();
    modal.classList.add("hidden");
    modalPreview.classList.remove("pdf-mode");
    modalPreview.replaceChildren();
    updateDownloadLink(null);
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

  function handleKeyDown(event) {
    if (!isModalOpen()) {
      return false;
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
    const response = await fetch(`/stream?path=${encodeURIComponent(path)}`);
    if (token !== state.previewToken) {
      return null;
    }
    if (response.status === 401) {
      onUnauthorized?.();
      return null;
    }
    if (!response.ok) {
      throw new Error("Failed to load file text");
    }

    const text = await response.text();
    if (token !== state.previewToken) {
      return null;
    }

    if (text.length <= MAX_TEXT_PREVIEW_CHARS) {
      return { text, truncated: false, totalChars: text.length };
    }

    return {
      text: text.slice(0, MAX_TEXT_PREVIEW_CHARS),
      truncated: true,
      totalChars: text.length,
    };
  }

  async function fetchBinaryForPreview(path, token) {
    const response = await fetch(`/stream?path=${encodeURIComponent(path)}`);
    if (token !== state.previewToken) {
      return null;
    }
    if (response.status === 401) {
      onUnauthorized?.();
      return null;
    }
    if (!response.ok) {
      throw new Error("Failed to load file");
    }

    const arrayBuffer = await response.arrayBuffer();
    if (token !== state.previewToken) {
      return null;
    }
    return arrayBuffer;
  }

  function createPreviewNote(message) {
    const note = document.createElement("div");
    note.className = "preview-note";
    note.textContent = message;
    return note;
  }

  function createTabSystem(tabDefinitions, defaultTabId) {
    const wrapper = document.createElement("section");
    const tabBar = document.createElement("div");
    tabBar.className = "preview-tabs";
    const panes = document.createElement("div");
    const buttons = new Map();
    const paneNodes = new Map();

    function activate(tabId) {
      for (const [id, button] of buttons.entries()) {
        button.classList.toggle("active", id === tabId);
      }
      for (const [id, pane] of paneNodes.entries()) {
        pane.classList.toggle("hidden", id !== tabId);
      }
    }

    for (const tab of tabDefinitions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "preview-tab";
      button.textContent = tab.label;
      button.addEventListener("click", () => activate(tab.id));
      buttons.set(tab.id, button);
      tabBar.appendChild(button);

      const pane = document.createElement("section");
      pane.className = "preview-pane";
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

  async function loadExternalScript(url, globalName) {
    if (globalName && window[globalName]) {
      return window[globalName];
    }
    if (scriptLoadCache.has(url)) {
      return scriptLoadCache.get(url);
    }

    const promise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = url;
      script.async = true;
      script.crossOrigin = "anonymous";
      script.onload = () => {
        if (globalName && !window[globalName]) {
          reject(new Error(`Library loaded but global ${globalName} was not found`));
          return;
        }
        resolve(globalName ? window[globalName] : true);
      };
      script.onerror = () => reject(new Error(`Failed to load script: ${url}`));
      document.head.appendChild(script);
    });

    scriptLoadCache.set(url, promise);
    return promise;
  }

  async function loadExternalStyle(url) {
    if (styleLoadCache.has(url)) {
      return;
    }
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = url;
    document.head.appendChild(link);
    styleLoadCache.add(url);
  }

  async function ensureHighlightLibrary() {
    await Promise.all([loadExternalScript(HIGHLIGHT_URL, "hljs"), loadExternalStyle(HIGHLIGHT_THEME_URL)]);
  }

  async function ensureMarkdownLibraries() {
    await Promise.all([
      ensureHighlightLibrary(),
      loadExternalScript(MARKDOWN_IT_URL, "markdownit"),
      loadExternalScript(DOMPURIFY_URL, "DOMPurify"),
    ]);
  }

  async function ensureWordLibraries() {
    await Promise.all([
      ensureHighlightLibrary(),
      loadExternalScript(DOMPURIFY_URL, "DOMPurify"),
      loadExternalScript(MAMMOTH_URL, "mammoth"),
    ]);
  }

  async function ensureSpreadsheetLibraries() {
    await Promise.all([loadExternalScript(SHEETJS_URL, "XLSX")]);
  }

  function getMarkdownRenderer() {
    if (state.markdownRenderer) {
      return state.markdownRenderer;
    }

    state.markdownRenderer = window.markdownit({
      html: false,
      linkify: true,
      typographer: true,
      breaks: false,
      highlight(code, language) {
        if (window.hljs && language && window.hljs.getLanguage(language)) {
          return `<pre><code class="hljs language-${language}">${window.hljs.highlight(code, { language, ignoreIllegals: true }).value}</code></pre>`;
        }
        if (window.hljs) {
          return `<pre><code class="hljs">${window.hljs.highlightAuto(code).value}</code></pre>`;
        }
        return `<pre><code>${escapeHtml(code)}</code></pre>`;
      },
    });
    return state.markdownRenderer;
  }

  function guessCodeLanguage(path) {
    const extension = getPathExtension(path);
    const name = getPathBasename(path).toLowerCase();
    const map = {
      ".py": "python",
      ".js": "javascript",
      ".mjs": "javascript",
      ".cjs": "javascript",
      ".ts": "typescript",
      ".tsx": "typescript",
      ".jsx": "javascript",
      ".java": "java",
      ".kt": "kotlin",
      ".go": "go",
      ".rs": "rust",
      ".rb": "ruby",
      ".php": "php",
      ".cs": "csharp",
      ".cpp": "cpp",
      ".cxx": "cpp",
      ".cc": "cpp",
      ".c": "c",
      ".h": "c",
      ".hpp": "cpp",
      ".css": "css",
      ".scss": "scss",
      ".sass": "scss",
      ".less": "less",
      ".html": "xml",
      ".htm": "xml",
      ".xml": "xml",
      ".svg": "xml",
      ".json": "json",
      ".yaml": "yaml",
      ".yml": "yaml",
      ".toml": "toml",
      ".ini": "ini",
      ".md": "markdown",
      ".sql": "sql",
      ".sh": "bash",
      ".bash": "bash",
      ".zsh": "bash",
      ".ps1": "powershell",
      ".bat": "dos",
      ".vue": "vue",
      ".svelte": "svelte",
    };

    if (name === "dockerfile") {
      return "dockerfile";
    }
    if (name === "makefile") {
      return "makefile";
    }
    return map[extension] || "plaintext";
  }

  async function createCodePanel(sourceText, options = {}) {
    const { title = "Source", language = "plaintext", defaultWrap = false } = options;

    await ensureHighlightLibrary().catch(() => {
      // Fallback to plain text when formatter is unavailable.
    });

    const shell = document.createElement("section");
    shell.className = "code-shell";

    const toolbar = document.createElement("div");
    toolbar.className = "code-toolbar";

    const titleNode = document.createElement("span");
    titleNode.className = "code-title";
    titleNode.textContent = `${title} (${language})`;

    const actions = document.createElement("div");
    actions.className = "code-toolbar-actions";

    const wrapButton = document.createElement("button");
    wrapButton.type = "button";
    wrapButton.className = "code-btn";
    wrapButton.textContent = defaultWrap ? "No Wrap" : "Wrap";

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "code-btn";
    copyButton.textContent = "Copy";

    actions.append(wrapButton, copyButton);
    toolbar.append(titleNode, actions);

    const pre = document.createElement("pre");
    pre.className = "code-surface";
    if (defaultWrap) {
      pre.classList.add("wrap");
    }

    const code = document.createElement("code");
    code.className = `language-${language}`;

    if (window.hljs) {
      if (language && window.hljs.getLanguage(language)) {
        code.classList.add("hljs");
        code.innerHTML = window.hljs.highlight(sourceText, { language, ignoreIllegals: true }).value;
      } else {
        code.classList.add("hljs");
        code.innerHTML = window.hljs.highlightAuto(sourceText).value;
      }
    } else {
      code.textContent = sourceText;
    }

    pre.appendChild(code);
    shell.append(toolbar, pre);

    wrapButton.addEventListener("click", () => {
      pre.classList.toggle("wrap");
      wrapButton.textContent = pre.classList.contains("wrap") ? "No Wrap" : "Wrap";
    });

    copyButton.addEventListener("click", async () => {
      const previous = copyButton.textContent;
      try {
        await navigator.clipboard.writeText(sourceText);
        copyButton.textContent = "Copied";
      } catch {
        copyButton.textContent = "Copy Failed";
      }
      window.setTimeout(() => {
        copyButton.textContent = previous;
      }, 1200);
    });

    return shell;
  }
  function renderVideoPreview(path) {
    const video = document.createElement("video");
    video.controls = true;
    video.preload = "metadata";
    video.src = `/stream?path=${encodeURIComponent(path)}`;
    video.playsInline = true;
    video.setAttribute("playsinline", "");

    const storageKey = `video-time:${path}`;
    const savedTime = Number(sessionStorage.getItem(storageKey) || "0");
    if (savedTime > 0) {
      video.addEventListener("loadedmetadata", () => {
        if (Number.isFinite(savedTime) && savedTime < video.duration) {
          video.currentTime = savedTime;
        }
      });
    }

    video.addEventListener("timeupdate", () => {
      sessionStorage.setItem(storageKey, String(video.currentTime));
    });

    video.addEventListener("error", () => {
      modalPreview.replaceChildren(
        createPreviewNote("Video preview failed on this device/browser. Use Download or an external player."),
      );
    });

    modalPreview.appendChild(video);
  }

  function renderImagePreview(path) {
    const image = document.createElement("img");
    image.src = `/stream?path=${encodeURIComponent(path)}`;
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
    previewImage.src = `/stream?path=${encodeURIComponent(path)}`;
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

  async function openPreview(path, type) {
    const safePath = normalizePath(path);
    const token = state.previewToken + 1;
    state.previewToken = token;
    state.currentFilePath = safePath;

    teardownModalResources();
    modalPreview.classList.remove("pdf-mode");
    modalPreview.replaceChildren();
    updateDownloadLink(safePath);
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

      modalPreview.replaceChildren(
        createPreviewNote("Preview not available for this file type. Use Download."),
      );
    } catch (error) {
      if (token !== state.previewToken) {
        return;
      }
      const text = error?.message || "Unknown error";
      modalPreview.replaceChildren(createPreviewNote(`Preview failed: ${text}`));
    }
  }
  async function getPdfJsLib() {
    if (!pdfJsLibPromise) {
      pdfJsLibPromise = import(PDF_JS_MAIN_URL)
        .then((lib) => {
          lib.GlobalWorkerOptions.workerSrc = PDF_JS_WORKER_URL;
          return lib;
        })
        .catch((error) => {
          pdfJsLibPromise = null;
          throw error;
        });
    }
    return pdfJsLibPromise;
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

    const pdfjsLib = await getPdfJsLib();
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
      window.open(`/stream?path=${encodeURIComponent(path)}`, "_blank", "noopener");
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

    const loadingTask = pdfjsLib.getDocument({
      url: `/stream?path=${encodeURIComponent(path)}`,
    });

    state.pdf.loadingTask = loadingTask;
    const pdfDoc = await loadingTask.promise;

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
    openPreview,
    closePreview,
    handleKeyDown,
    handleResize,
    handleModalClick,
    handleTouchStart,
    handleTouchEnd,
    getCurrentFilePath,
    isModalOpen,
  };
}
