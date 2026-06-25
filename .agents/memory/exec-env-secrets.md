---
name: Project secrets are NOT in the code_execution sandbox
description: where Replit project secrets/env vars are visible across execution environments
---

The `code_execution` JS sandbox does NOT receive the project's Secrets in `process.env` (only generic `REPL_*` vars). The **bash tool** and **workflows** DO have project secrets injected.

**How to apply:** to use a secret (e.g. an API key) without exposing it, run a Node script via the bash tool that reads `process.env.<KEY>` and prints only results — never echo the key. `viewEnvVars` confirms existence only, never values. Never set secrets directly; always request them via `requestEnvVar`.

**Why:** discovered when `process.env.MESHY_AI_API_KEY` was undefined in the sandbox but present to `node` launched from bash.
