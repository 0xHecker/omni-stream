export function normalizePath(path = "") {
  return String(path)
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .join("/");
}

export function getPathBasename(path = "") {
  const normalized = normalizePath(path);
  const parts = normalized.split("/");
  return parts[parts.length - 1] || "file";
}

export function getPathExtension(path = "") {
  const name = getPathBasename(path);
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex < 0) {
    return "";
  }
  return name.slice(dotIndex).toLowerCase();
}

export function debounce(fn, waitMs = 250) {
  let timeoutId = 0;
  return (...args) => {
    window.clearTimeout(timeoutId);
    timeoutId = window.setTimeout(() => fn(...args), waitMs);
  };
}
