import { normalizePath } from "./utils.js";

const THUMBNAIL_ROOT_MARGIN = "320px";
const THUMBNAIL_MIN_CONCURRENCY = 2;
const THUMBNAIL_MAX_CONCURRENCY = 8;

const thumbnailLoaderState = {
  observer: null,
  queue: [],
  inFlight: 0,
  renderToken: 0,
};

function resolveThumbnailConcurrency() {
  const hardware = Number(window.navigator.hardwareConcurrency || 4);
  if (!Number.isFinite(hardware) || hardware <= 1) {
    return THUMBNAIL_MIN_CONCURRENCY;
  }
  return Math.max(
    THUMBNAIL_MIN_CONCURRENCY,
    Math.min(THUMBNAIL_MAX_CONCURRENCY, Math.floor(hardware / 2)),
  );
}

function resetThumbnailLoaderState() {
  thumbnailLoaderState.renderToken += 1;
  thumbnailLoaderState.queue = [];
  thumbnailLoaderState.inFlight = 0;
  if (thumbnailLoaderState.observer) {
    thumbnailLoaderState.observer.disconnect();
    thumbnailLoaderState.observer = null;
  }
}

function processThumbnailQueue() {
  const maxConcurrency = resolveThumbnailConcurrency();
  while (thumbnailLoaderState.inFlight < maxConcurrency && thumbnailLoaderState.queue.length > 0) {
    const job = thumbnailLoaderState.queue.shift();
    if (!job) {
      continue;
    }
    if (job.token !== thumbnailLoaderState.renderToken || !job.image.isConnected) {
      continue;
    }
    const src = job.image.dataset.thumbSrc;
    if (!src) {
      continue;
    }
    thumbnailLoaderState.inFlight += 1;
    const finalize = () => {
      thumbnailLoaderState.inFlight = Math.max(0, thumbnailLoaderState.inFlight - 1);
      processThumbnailQueue();
    };
    const onLoad = () => finalize();
    const onError = () => finalize();
    job.image.addEventListener("load", onLoad, { once: true });
    job.image.addEventListener("error", onError, { once: true });
    job.image.src = src;
  }
}

function queueThumbnailImage(image, token) {
  if (!image || image.dataset.thumbQueued === "1") {
    return;
  }
  image.dataset.thumbQueued = "1";
  thumbnailLoaderState.queue.push({ image, token });
  processThumbnailQueue();
}

function enableDeferredThumbnailLoading(fileListEl) {
  const token = thumbnailLoaderState.renderToken;
  const images = [...fileListEl.querySelectorAll("img.thumb[data-thumb-src]")];
  if (!images.length) {
    return;
  }

  if (!("IntersectionObserver" in window)) {
    for (const image of images) {
      queueThumbnailImage(image, token);
    }
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) {
          continue;
        }
        const image = entry.target;
        observer.unobserve(image);
        queueThumbnailImage(image, token);
      }
    },
    {
      root: null,
      rootMargin: THUMBNAIL_ROOT_MARGIN,
      threshold: 0.01,
    },
  );
  thumbnailLoaderState.observer = observer;
  for (const image of images) {
    observer.observe(image);
  }
}

export function renderBreadcrumb(breadcrumbEl, path, onNavigate) {
  const safePath = normalizePath(path);
  const segments = safePath ? safePath.split("/") : [];
  const fragment = document.createDocumentFragment();

  fragment.appendChild(createCrumb("Root", "", segments.length === 0, onNavigate));

  let rollingPath = "";
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    rollingPath = rollingPath ? `${rollingPath}/${segment}` : segment;
    fragment.appendChild(createCrumb(segment, rollingPath, index === segments.length - 1, onNavigate));
  }

  breadcrumbEl.replaceChildren(fragment);
}

function createCrumb(label, path, isCurrent, onNavigate) {
  const item = document.createElement("li");
  item.className = "crumb-item";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "crumb-btn";
  button.textContent = label;
  if (isCurrent) {
    button.disabled = true;
  } else {
    button.addEventListener("click", () => onNavigate(path));
  }

  item.appendChild(button);
  return item;
}

export function renderFileList(
  fileListEl,
  items,
  {
    onOpenDirectory,
    onOpenFile,
    showParentPath = false,
    basePath = "",
  },
) {
  resetThumbnailLoaderState();
  const safeBasePath = normalizePath(basePath);
  const fragment = document.createDocumentFragment();

  for (const item of items) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "file-item";
    card.dataset.kind = item.is_dir ? "directory" : String(item.type || "other");

    if (shouldUseThumbnail(item)) {
      const image = document.createElement("img");
      image.className = "thumb";
      image.loading = "lazy";
      image.decoding = "async";
      image.alt = item.name;
      image.dataset.thumbSrc = `/thumbnail?path=${encodeURIComponent(item.path)}&v=4`;
      image.addEventListener("error", () => {
        if (!image.isConnected) {
          return;
        }
        image.replaceWith(createTypeBadge(item));
      });
      card.appendChild(image);
    } else {
      card.appendChild(createTypeBadge(item));
    }

    const name = document.createElement("div");
    name.className = "file-name";
    name.textContent = item.name;
    name.title = item.name;
    card.appendChild(name);

    const kind = document.createElement("div");
    kind.className = "file-kind";
    kind.textContent = item.is_dir ? "Folder" : (item.type || "FILE").toUpperCase();
    card.appendChild(kind);

    let details = [];
    if (!item.is_dir && typeof item.size === "number") {
      details.push(formatBytes(item.size));
    }
    if (item.modified_at) {
      details.push(new Date(item.modified_at * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }));
    }

    if (showParentPath) {
      const parentPath = normalizePath(item.parent_path || "");
      if (parentPath && parentPath !== safeBasePath) {
        details.push(`/${parentPath}`);
      }
    }

    if (details.length > 0) {
      const meta = document.createElement("div");
      meta.className = "file-meta";
      meta.textContent = details.join(" • ");
      card.appendChild(meta);
    }

    if (item.is_dir) {
      card.addEventListener("click", () => onOpenDirectory(item.path));
    } else {
      card.addEventListener("click", () => onOpenFile(item));
    }

    fragment.appendChild(card);
  }

  fileListEl.replaceChildren(fragment);
  enableDeferredThumbnailLoading(fileListEl);
}

function shouldUseThumbnail(item) {
  if (!item || !item.path) {
    return false;
  }
  const supportedThumbnailTypes = ["image", "video", "pdf", "text", "code", "markdown", "html"];
  return supportedThumbnailTypes.includes(item.type);
}

function createTypeBadge(item) {
  const badge = document.createElement("div");
  badge.className = "type-badge";
  badge.innerHTML = getIconSvg(item);
  return badge;
}

export function getIconSvg(item) {
  if (item.is_dir) {
    return `<svg width="56" height="56" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M40 12H22.5858L19.7574 9.17157C18.9763 8.39052 17.9172 8 16.8137 8H8C5.79086 8 4 9.79086 4 12V36C4 38.2091 5.79086 40 8 40H40C42.2091 40 44 38.2091 44 36V16C44 13.7909 42.2091 12 40 12Z" fill="#3B82F6"/>
      <path d="M4 16C4 14.8954 4.89543 14 6 14H42C43.1046 14 44 14.8954 44 16V36C44 38.2091 42.2091 40 40 40H8C5.79086 40 4 38.2091 4 36V16Z" fill="#60A5FA"/>
    </svg>`;
  }
  let ext = (item.name || "").includes(".") ? (item.name || "").split('.').pop().toLowerCase() : "";
  let typeLabel = ext ? ext.substring(0, 4).toUpperCase() : "FILE";

  const colors = ["#EF5350", "#EC407A", "#AB47BC", "#7E57C2", "#5C6BC0", "#42A5F5", "#29B6F6", "#26C6DA", "#26A69A", "#66BB6A", "#9CCC65", "#FFA726", "#FF7043", "#8D6E63", "#78909C"];
  let hash = 0;
  for (let i = 0; i < ext.length; i++) hash = ext.charCodeAt(i) + ((hash << 5) - hash);
  let color = ext ? colors[Math.abs(hash) % colors.length] : "#78909C";

  switch (item.type) {
    case "video": color = "#EC407A"; typeLabel = "VID"; break;
    case "image": color = "#26A69A"; typeLabel = "IMG"; break;
    case "pdf": color = "#EF5350"; typeLabel = "PDF"; break;
    case "word": color = "#42A5F5"; typeLabel = "DOC"; break;
    case "excel": color = "#66BB6A"; typeLabel = "XLS"; break;
    case "code": color = "#26C6DA"; typeLabel = "DEV"; break;
    case "markdown": color = "#7E57C2"; typeLabel = "MD"; break;
    case "text": color = "#90A4AE"; typeLabel = "TXT"; break;
    case "archive": color = "#FFA726"; typeLabel = "ZIP"; break;
  }

  return `<svg width="46" height="56" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M10 6C10 4.89543 10.8954 4 12 4H26L38 16V42C38 43.1046 37.1046 44 36 44H12C10.8954 44 10 43.1046 10 42V6Z" fill="${color}"/>
    <path d="M26 4V12C26 13.1046 26.8954 14 28 14H38L26 4Z" fill="white" fill-opacity="0.3"/>
    <text x="24" y="32" font-family="sans-serif" font-size="9" font-weight="bold" fill="white" text-anchor="middle">${typeLabel}</text>
  </svg>`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** unitIndex);
  const digits = unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}
