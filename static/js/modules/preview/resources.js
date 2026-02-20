import { getPathBasename, getPathExtension } from "../utils.js";
import {
  HIGHLIGHT_URL,
  HIGHLIGHT_THEME_URL,
  MARKDOWN_IT_URL,
  DOMPURIFY_URL,
  MAMMOTH_URL,
  SHEETJS_URL,
} from "./shared.js";

export function createPreviewResourceApi(ctx) {
  const { state } = ctx;
  const scriptLoadCache = ctx.scriptLoadCache;
  const styleLoadCache = ctx.styleLoadCache;
  const escapeHtml = (...args) => ctx.escapeHtml(...args);
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
      script.onerror = () => {
        script.remove();
        reject(new Error(`Failed to load script: ${url}`));
      };
      document.head.appendChild(script);
    });

    scriptLoadCache.set(url, promise);
    promise.catch(() => {
      scriptLoadCache.delete(url);
    });
    return promise;
  }

  async function loadExternalStyle(url) {
    if (styleLoadCache.has(url)) {
      return styleLoadCache.get(url);
    }
    const promise = new Promise((resolve, reject) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = url;
      link.onload = () => resolve(true);
      link.onerror = () => {
        link.remove();
        reject(new Error(`Failed to load stylesheet: ${url}`));
      };
      document.head.appendChild(link);
    });
    styleLoadCache.set(url, promise);
    promise.catch(() => {
      styleLoadCache.delete(url);
    });
    return promise;
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
  return {
    loadExternalScript,
    loadExternalStyle,
    ensureHighlightLibrary,
    ensureMarkdownLibraries,
    ensureWordLibraries,
    ensureSpreadsheetLibraries,
    getMarkdownRenderer,
    guessCodeLanguage,
    createCodePanel,
  };
}
