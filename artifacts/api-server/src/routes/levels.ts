import { Router, type IRouter } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  existsSync,
  promises as fs,
} from "node:fs";
import { pushFileToGitHub } from "../github";

const router: IRouter = Router();

/**
 * Level layouts are written into `<repoRoot>/levels/<name>.json` so the agent
 * (and later the game) can read exact coordinates straight from the repo.
 *
 * The server is bundled by esbuild and runs from `dist/`, so neither
 * `process.cwd()` nor source paths are reliable. We resolve the repo root by
 * walking upward from this module's runtime location until we find the
 * `pnpm-workspace.yaml` marker.
 */
function resolveRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  // Walk up until we hit the workspace marker or the filesystem root.
  for (let i = 0; i < 30; i += 1) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "Could not locate repo root (pnpm-workspace.yaml) from api-server runtime path.",
  );
}

const REPO_ROOT = resolveRepoRoot();
const LEVELS_DIR = path.join(REPO_ROOT, "levels");

// Slug-safe level names only. This both keeps filenames tidy and prevents any
// path traversal via `..`, slashes, or absolute paths.
const NAME_RE = /^[a-z0-9][a-z0-9-_]{0,63}$/i;

function levelPath(name: string): string {
  const file = path.join(LEVELS_DIR, `${name}.json`);
  // Defense in depth: ensure the resolved path stays inside LEVELS_DIR.
  const rel = path.relative(LEVELS_DIR, file);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Resolved level path escapes the levels directory.");
  }
  return file;
}

function paramName(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return null;
  return raw;
}

// Optional write protection. Saving now also commits to GitHub, so an open
// endpoint would let anyone reaching the API URL push to the repo. When
// `LEVELS_API_TOKEN` is set, writes must carry a matching `x-levels-token`
// header; when it is unset the endpoint stays open (back-compat with the
// existing dev workflow), and we warn once so it is not silently unprotected.
let warnedOpen = false;
function checkWriteAuth(
  req: { headers: Record<string, unknown>; log: { warn: (msg: string) => void } },
): boolean {
  const expected = process.env.LEVELS_API_TOKEN;
  if (!expected) {
    if (!warnedOpen) {
      warnedOpen = true;
      req.log.warn(
        "LEVELS_API_TOKEN is not set — level save/GitHub-push endpoint is unauthenticated.",
      );
    }
    return true;
  }
  const header = req.headers["x-levels-token"];
  const provided = Array.isArray(header) ? header[0] : header;
  return provided === expected;
}

// GET /api/levels — list saved level names.
router.get("/levels", async (req, res): Promise<void> => {
  try {
    if (!existsSync(LEVELS_DIR)) {
      res.json({ levels: [] });
      return;
    }
    const entries = await fs.readdir(LEVELS_DIR);
    const levels = entries
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length))
      .sort();
    res.json({ levels });
  } catch (err) {
    req.log.error({ err }, "Failed to list levels");
    res.status(500).json({ error: "Failed to list levels" });
  }
});

// GET /api/levels/:name — load one level layout.
router.get("/levels/:name", async (req, res): Promise<void> => {
  const name = paramName(req.params.name);
  if (name == null || !NAME_RE.test(name)) {
    res.status(400).json({ error: "Invalid level name" });
    return;
  }

  const file = levelPath(name);
  if (!existsSync(file)) {
    res.status(404).json({ error: "Level not found" });
    return;
  }

  try {
    const raw = await fs.readFile(file, "utf8");
    res.type("application/json").send(raw);
  } catch (err) {
    req.log.error({ err, name }, "Failed to read level");
    res.status(500).json({ error: "Failed to read level" });
  }
});

// POST /api/levels/:name — save (overwrite) one level layout as pretty JSON.
router.post("/levels/:name", async (req, res): Promise<void> => {
  if (!checkWriteAuth(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const name = paramName(req.params.name);
  if (name == null || !NAME_RE.test(name)) {
    res.status(400).json({ error: "Invalid level name" });
    return;
  }

  const body = req.body;
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    res.status(400).json({ error: "Request body must be a JSON object" });
    return;
  }

  // Persist the name inside the payload so the file is self-describing.
  const payload = { ...body, name };

  try {
    await fs.mkdir(LEVELS_DIR, { recursive: true });
    const file = levelPath(name);
    const contents = `${JSON.stringify(payload, null, 2)}\n`;
    await fs.writeFile(file, contents, "utf8");
    req.log.info({ name, file }, "Saved level layout");

    const relPath = path.relative(REPO_ROOT, file).split(path.sep).join("/");

    // Auto-push to GitHub so the remote copy stays in sync for the agent /
    // collaborators. Non-fatal: a failed push must not fail the local save.
    let github: {
      pushed: boolean;
      commitSha?: string;
      htmlUrl?: string;
      error?: string;
    };
    try {
      const result = await pushFileToGitHub({
        repoRoot: REPO_ROOT,
        repoRelPath: relPath,
        content: contents,
        message: `level(${name}): update via level editor`,
      });
      github = {
        pushed: result.committed,
        commitSha: result.commitSha,
        htmlUrl: result.htmlUrl,
      };
      req.log.info({ name, commitSha: result.commitSha }, "Pushed level to GitHub");
    } catch (err) {
      github = { pushed: false, error: (err as Error).message };
      req.log.error({ err, name }, "GitHub push failed (local save kept)");
    }

    res.status(200).json({ ok: true, name, path: relPath, github });
  } catch (err) {
    req.log.error({ err, name }, "Failed to write level");
    res.status(500).json({ error: "Failed to write level" });
  }
});

export default router;
