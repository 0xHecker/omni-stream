import { normalizePath } from "./utils.js";

export function createApiClient({ onUnauthorized }) {
  async function fetchJson(url, { signal } = {}) {
    const response = await fetch(url, { signal });
    if (response.status === 401) {
      onUnauthorized?.();
      return null;
    }

    if (!response.ok) {
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const payload = await response.json();
        throw new Error(payload.error || `Request failed (${response.status})`);
      }
      throw new Error(`Request failed (${response.status})`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      throw new Error("Unexpected response from server");
    }
    return response.json();
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

  return {
    listFiles,
    searchFiles,
    getAdjacentFile,
    getVideoInfo,
  };
}
