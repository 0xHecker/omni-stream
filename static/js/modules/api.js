import { normalizePath } from "./utils.js";

export function createApiClient({ onUnauthorized }) {
  async function fetchJson(url, {
    signal,
    method = "GET",
    body,
    headers = {},
  } = {}) {
    const requestHeaders = { ...headers };
    let requestBody = body;
    if (body !== undefined && body !== null && typeof body === "object" && !(body instanceof FormData)) {
      requestBody = JSON.stringify(body);
      if (!requestHeaders["Content-Type"]) {
        requestHeaders["Content-Type"] = "application/json";
      }
    }

    const response = await fetch(url, {
      signal,
      method,
      headers: requestHeaders,
      body: requestBody,
    });

    const contentType = response.headers.get("content-type") || "";
    const isJson = contentType.includes("application/json");
    const payload = isJson ? await response.json() : null;

    if (response.status === 401) {
      const message = String(payload?.error || payload?.detail || "").trim().toLowerCase();
      const shouldRedirect = message.includes("authentication required") || message.includes("setup required");
      if (shouldRedirect) {
        onUnauthorized?.();
        return null;
      }
      throw new Error(String(payload?.error || payload?.detail || `Request failed (${response.status})`));
    }

    if (!response.ok) {
      if (isJson) {
        throw new Error(payload.error || payload.detail || `Request failed (${response.status})`);
      }
      throw new Error(`Request failed (${response.status})`);
    }

    if (!isJson) {
      throw new Error("Unexpected response from server");
    }
    return payload;
  }

  async function listFiles(path = "", { signal, maxResults = 400, page = 1 } = {}) {
    const safePath = normalizePath(path);
    return fetchJson(
      `/list?path=${encodeURIComponent(safePath)}&max=${encodeURIComponent(String(maxResults))}&page=${encodeURIComponent(String(page))}`,
      { signal },
    );
  }

  async function searchFiles({
    path = "",
    query = "",
    recursive = true,
    maxResults = 200,
    signal,
  }) {
    const safePath = normalizePath(path);
    const safeQuery = String(query ?? "").trim();
    return fetchJson(
      `/search?path=${encodeURIComponent(safePath)}&q=${encodeURIComponent(safeQuery)}&recursive=${recursive ? "1" : "0"}&max=${encodeURIComponent(String(maxResults))}`,
      { signal },
    );
  }

  async function getAdjacentFile(path, direction, { signal } = {}) {
    const safePath = normalizePath(path);
    const safeDirection = direction === "prev" ? "prev" : "next";
    return fetchJson(
      `/get_adjacent_file?path=${encodeURIComponent(safePath)}&direction=${encodeURIComponent(safeDirection)}`,
      { signal },
    );
  }

  async function getVideoInfo(path, { signal } = {}) {
    const safePath = normalizePath(path);
    return fetchJson(`/video_info?path=${encodeURIComponent(safePath)}`, { signal });
  }

  async function listHubs({ refresh = false, signal } = {}) {
    const query = refresh ? "?refresh=1" : "";
    return fetchJson(`/api/hubs${query}`, { signal });
  }

  async function selectHub(hubId, { signal } = {}) {
    return fetchJson("/api/hubs/select", {
      signal,
      method: "POST",
      body: { hub_id: String(hubId || "") },
    });
  }

  async function unlockHub(hubId, pin, { signal } = {}) {
    return fetchJson("/api/hubs/unlock", {
      signal,
      method: "POST",
      body: {
        hub_id: String(hubId || ""),
        pin: String(pin || ""),
      },
    });
  }

  async function lockHub(hubId, { signal } = {}) {
    return fetchJson("/api/hubs/lock", {
      signal,
      method: "POST",
      body: { hub_id: String(hubId || "") },
    });
  }

  return {
    listFiles,
    searchFiles,
    getAdjacentFile,
    getVideoInfo,
    listHubs,
    selectHub,
    unlockHub,
    lockHub,
  };
}
