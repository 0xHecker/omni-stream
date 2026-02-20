export const PERSISTED_PROFILE_KEY = "network_coordinator_profile_v2";
export const RUNTIME_SESSION_KEY = "network_runtime_session_v2";
export const UNKNOWN_SHA256 = "0".repeat(64);
export const UPLOAD_CHUNK_BYTES = 1024 * 1024;
export const MAX_TRANSFER_ITEMS_PER_REQUEST = 200;
export const DEVICE_REFRESH_INTERVAL_MS = 10000;
export const HIDDEN_DEVICE_REFRESH_INTERVAL_MS = 60000;
export const TRANSFER_BACKUP_REFRESH_INTERVAL_MS = 10000;
export const WS_PING_INTERVAL_MS = 20000;
export const WS_RECONNECT_MAX_DELAY_MS = 12000;
export const REMOTE_LIST_MAX_RESULTS = 300;
export const REMOTE_SEARCH_MAX_RESULTS = 300;
export const COORDINATOR_PROBE_TIMEOUT_MS = 1200;
export const COORDINATOR_REQUEST_TIMEOUT_MS = 12000;
export const AGENT_REQUEST_TIMEOUT_MS = 15000;
export const DISCOVERY_CACHE_TTL_MS = 15000;
export const RECOVERY_MIN_INTERVAL_MS = 10000;
export const MAX_COORDINATOR_CANDIDATES = 16;
export const MAX_REFRESH_FAILURES = 3;
export const MAX_WS_RECONNECT_ATTEMPTS_BEFORE_RECOVERY = 4;

export function sleep(milliseconds) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

export function normalizeBaseUrl(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) {
    return "";
  }
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const url = new URL(withProtocol);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "";
  }
}

export function escapeHtml(input) {
  return String(input ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function sanitizeRemoteUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) {
    return "#";
  }
  try {
    const parsed = new URL(value, window.location.origin);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
  } catch {
    // Fall through to default.
  }
  return "#";
}

export function fileFingerprint({ filename, size, sha256 }) {
  return `${filename}::${size}::${String(sha256 || "").toLowerCase()}`;
}

export function bytesToLabel(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let index = 0;
  let value = bytes;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
}

export function randomPasscode() {
  return String(Math.floor(Math.random() * 9000) + 1000);
}

export function parseTransferPreferences(transfer) {
  const fallback = {
    destinationPath: "",
    autoPasscode: "",
  };
  const raw = String(transfer?.reason || "").trim();
  if (!raw) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return fallback;
    }
    if (String(parsed.kind || "") !== "receiver_preferences") {
      return fallback;
    }
    return {
      destinationPath: String(parsed.destination_path || "").trim(),
      autoPasscode: String(parsed.auto_passcode || "").trim(),
    };
  } catch {
    return fallback;
  }
}

export function normalizeFsPath(pathValue) {
  return String(pathValue || "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/\/+$/, "");
}

export function toShareRelativePath(shareRootPath, selectedPath) {
  const rootRaw = normalizeFsPath(shareRootPath);
  const targetRaw = normalizeFsPath(selectedPath);
  if (!rootRaw || !targetRaw) {
    return null;
  }

  const rootLower = rootRaw.toLowerCase();
  const targetLower = targetRaw.toLowerCase();
  if (targetLower === rootLower) {
    return "";
  }
  if (!targetLower.startsWith(`${rootLower}/`)) {
    return null;
  }
  return targetRaw.slice(rootRaw.length + 1);
}

export function defaultSession() {
  return {
    baseUrl: "",
    principalId: "",
    clientDeviceId: "",
    deviceSecret: "",
    accessToken: "",
  };
}
