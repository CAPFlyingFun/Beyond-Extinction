import type { LevelData } from "../state/types";

// Root-relative on purpose: the workspace proxy routes the top-level `/api`
// path to the shared api-server, regardless of which artifact page is open.
// Do NOT prefix this with import.meta.env.BASE_URL — that would resolve under
// /level-editor/ and hit the wrong route.
const BASE = "/api/levels";

// Optional write token. The save endpoint commits to GitHub, so the server can
// require a shared secret (env `LEVELS_API_TOKEN`). We keep the token in
// localStorage (never in source / the bundle) and attach it to write requests.
const TOKEN_KEY = "levels.apiToken";

export function getApiToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

export function setApiToken(token: string): void {
  const trimmed = token.trim();
  if (trimmed) localStorage.setItem(TOKEN_KEY, trimmed);
  else localStorage.removeItem(TOKEN_KEY);
}

function writeHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const token = getApiToken();
  if (token) headers["x-levels-token"] = token;
  return headers;
}

export async function listLevels(): Promise<string[]> {
  const res = await fetch(BASE);
  if (!res.ok) throw new Error(`List failed (${res.status})`);
  const json = (await res.json()) as { levels?: string[] };
  return json.levels ?? [];
}

export interface GitHubPushStatus {
  pushed: boolean;
  commitSha?: string;
  htmlUrl?: string;
  error?: string;
}

export interface SaveResult {
  path?: string;
  github?: GitHubPushStatus;
}

export async function saveLevel(
  name: string,
  data: LevelData,
): Promise<SaveResult> {
  const res = await fetch(`${BASE}/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: writeHeaders(),
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const j = (await res.json()) as { error?: string };
      detail = j.error ?? "";
    } catch {
      /* ignore */
    }
    throw new Error(`Save failed (${res.status})${detail ? `: ${detail}` : ""}`);
  }
  try {
    return (await res.json()) as SaveResult;
  } catch {
    return {};
  }
}

export async function loadLevel(name: string): Promise<LevelData> {
  const res = await fetch(`${BASE}/${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`Load failed (${res.status})`);
  return (await res.json()) as LevelData;
}

/** Convenience client-side download, independent of the api-server. */
export function downloadLevel(name: string, data: LevelData): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
