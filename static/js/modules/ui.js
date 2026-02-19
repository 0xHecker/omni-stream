import { normalizePath } from "./utils.js";

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
  const safeBasePath = normalizePath(basePath);
  const fragment = document.createDocumentFragment();

  for (const item of items) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "file-item";

    if (item.type === "image" && !item.is_dir) {
      const image = document.createElement("img");
      image.className = "thumb";
      image.loading = "lazy";
      image.alt = item.name;
      image.src = `/thumbnail?path=${encodeURIComponent(item.path)}`;
      card.appendChild(image);
    } else if (item.type === "svg" && !item.is_dir) {
      const image = document.createElement("img");
      image.className = "thumb";
      image.loading = "lazy";
      image.alt = item.name;
      image.src = `/stream?path=${encodeURIComponent(item.path)}`;
      card.appendChild(image);
    } else {
      const badge = document.createElement("div");
      badge.className = "type-badge";
      badge.textContent = item.is_dir ? "DIR" : labelForType(item.type);
      card.appendChild(badge);
    }

    const name = document.createElement("div");
    name.className = "file-name";
    name.textContent = item.name;
    card.appendChild(name);

    if (showParentPath) {
      const parentPath = normalizePath(item.parent_path || "");
      if (parentPath && parentPath !== safeBasePath) {
        const meta = document.createElement("div");
        meta.className = "file-meta";
        meta.textContent = parentPath;
        card.appendChild(meta);
      }
    }

    if (item.is_dir) {
      card.addEventListener("click", () => onOpenDirectory(item.path));
    } else {
      card.addEventListener("click", () => onOpenFile(item.path, item.type));
    }

    fragment.appendChild(card);
  }

  fileListEl.replaceChildren(fragment);
}

function labelForType(type) {
  switch (type) {
    case "video":
      return "VIDEO";
    case "image":
      return "IMAGE";
    case "svg":
      return "SVG";
    case "pdf":
      return "PDF";
    case "word":
      return "WORD";
    case "excel":
      return "SHEET";
    case "markdown":
      return "MD";
    case "html":
      return "HTML";
    case "code":
      return "CODE";
    case "text":
      return "TEXT";
    default:
      return "FILE";
  }
}
