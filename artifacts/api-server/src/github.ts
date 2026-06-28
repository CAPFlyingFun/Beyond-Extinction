import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

/**
 * Pushes level JSON to GitHub so the agent / collaborators can read exact
 * coordinates from the remote repo (local files only live in this workspace).
 *
 * Auth uses the Replit GitHub connector: we fetch a FRESH access token from the
 * connectors proxy on every call (never cache it — tokens rotate), then talk to
 * the GitHub Contents REST API directly. This relies on the GitHub integration
 * being connected (connection:conn_github_...).
 */

interface GitHubTarget {
  owner: string;
  repo: string;
  branch: string;
}

export interface GitHubPushResult {
  committed: boolean;
  commitSha?: string;
  htmlUrl?: string;
}

async function fetchAccessToken(): Promise<string> {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? `repl ${process.env.REPL_IDENTITY}`
    : process.env.WEB_REPL_RENEWAL
      ? `depl ${process.env.WEB_REPL_RENEWAL}`
      : null;

  if (!hostname || !xReplitToken) {
    throw new Error(
      "Replit connector environment not available (REPLIT_CONNECTORS_HOSTNAME / REPL_IDENTITY).",
    );
  }

  const url = `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=github`;
  const resp = await fetch(url, {
    headers: { Accept: "application/json", X_REPLIT_TOKEN: xReplitToken },
  });
  if (!resp.ok) {
    throw new Error(`Connector token fetch failed (${resp.status}).`);
  }
  const data = (await resp.json()) as {
    items?: Array<{
      settings?: {
        access_token?: string;
        oauth?: { credentials?: { access_token?: string } };
      };
    }>;
  };
  const settings = data.items?.[0]?.settings;
  const token =
    settings?.access_token ?? settings?.oauth?.credentials?.access_token;
  if (!token) {
    throw new Error("GitHub is not connected (no access token available).");
  }
  return token;
}

/** Parse `owner/repo` out of the origin remote in a .git/config file. */
function parseOriginRemote(
  configText: string,
): { owner: string; repo: string } | null {
  const block = configText.match(/\[remote "origin"\][^[]*/);
  if (!block) return null;
  const urlMatch = block[0].match(/url\s*=\s*(\S+)/);
  if (!urlMatch) return null;
  // Handles https://github.com/OWNER/REPO(.git) and git@github.com:OWNER/REPO(.git)
  const m = urlMatch[1].match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

async function resolveTarget(repoRoot: string): Promise<GitHubTarget> {
  const branch = process.env.GITHUB_BRANCH ?? "main";

  const envRepo = process.env.GITHUB_REPO; // optional override: "owner/repo"
  if (envRepo && envRepo.includes("/")) {
    const [owner, repo] = envRepo.split("/");
    return { owner, repo, branch };
  }

  const cfgPath = path.join(repoRoot, ".git", "config");
  if (existsSync(cfgPath)) {
    const parsed = parseOriginRemote(await fs.readFile(cfgPath, "utf8"));
    if (parsed) return { ...parsed, branch };
  }

  throw new Error(
    "Could not determine GitHub repo (set GITHUB_REPO=owner/repo).",
  );
}

/**
 * Create or update a file on the remote default branch via the Contents API.
 * Returns the resulting commit info. Throws on any failure so the caller can
 * decide whether to treat it as fatal (we treat it as non-fatal on save).
 */
export async function pushFileToGitHub(opts: {
  repoRoot: string;
  repoRelPath: string; // POSIX-style, e.g. "levels/room.json"
  content: string;
  message: string;
}): Promise<GitHubPushResult> {
  const token = await fetchAccessToken();
  const target = await resolveTarget(opts.repoRoot);

  const encodedPath = opts.repoRelPath
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  const apiUrl = `https://api.github.com/repos/${target.owner}/${target.repo}/contents/${encodedPath}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "beyond-extinction-level-editor",
  };
  const base64 = Buffer.from(opts.content, "utf8").toString("base64");

  // Look up the current blob sha (required when updating an existing file).
  const getSha = async (): Promise<string | undefined> => {
    const resp = await fetch(
      `${apiUrl}?ref=${encodeURIComponent(target.branch)}`,
      { headers },
    );
    if (resp.status === 200) {
      const existing = (await resp.json()) as { sha?: string };
      return existing.sha;
    }
    if (resp.status === 404) return undefined;
    throw new Error(`GitHub read failed (${resp.status}).`);
  };

  // Create / update the file at the given sha.
  const put = (sha: string | undefined): Promise<Response> =>
    fetch(apiUrl, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: opts.message,
        content: base64,
        branch: target.branch,
        ...(sha ? { sha } : {}),
      }),
    });

  let putResp = await put(await getSha());
  // A concurrent save (or replica lag) can make our sha stale → 409/422.
  // Re-read the live sha once and retry before giving up.
  if (putResp.status === 409 || putResp.status === 422) {
    putResp = await put(await getSha());
  }
  if (!putResp.ok) {
    const detail = (await putResp.text()).slice(0, 200);
    throw new Error(`GitHub write failed (${putResp.status}): ${detail}`);
  }

  const out = (await putResp.json()) as {
    commit?: { sha?: string };
    content?: { html_url?: string };
  };
  return {
    committed: true,
    commitSha: out.commit?.sha,
    htmlUrl: out.content?.html_url,
  };
}
