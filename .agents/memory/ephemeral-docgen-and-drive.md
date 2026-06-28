---
name: Ephemeral doc generation + Google Drive upload
description: How to generate one-off documents (PDF/etc) without polluting this JS monorepo, and how to upload files to the user's Google Drive.
---

# One-off document generation without repo pollution

This is a pnpm/JS monorepo; adding Python deps (or npm doc libs) to the root would commit a stray `requirements.txt`/lockfile/`.pythonlibs`. Avoid that for one-off deliverables.

Recipe used (PDF via reportlab):
- `PIP_USER=0 python3 -m pip install --quiet --target=/tmp/pylibs <pkg>` then run with `PYTHONPATH=/tmp/pylibs`.
- **Why the `PIP_USER=0`:** the environment's global pip config forces `--user`, and pip refuses to combine `--user` with `--target` ("Can not combine '--user' and '--target'"). Overriding the env var lets `--target` win, so the lib lands in `/tmp` (never touches the repo).
- Write the generator script to `/tmp` too, output the file under `exports/`, deliver, then `rm -rf exports` so nothing is committed.
- reportlab built-in fonts (Helvetica/Courier) only cover Latin-1 — sanitize content to ASCII (`->`, `~`, `-`, `x` for `×`) or you get notdef boxes.

# Uploading to the user's Google Drive

A **Google Drive connection is already authorized** for this project (search `searchIntegrations("Google Drive")` → a `connection`, not a `connector`). Token via `listConnections('google-drive')` (hyphen; "google drive" with a space 401s) at `settings.access_token` or `settings.oauth.credentials.access_token`.

- Scope includes `drive.file`, so the app can create files. Upload via `POST https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart` with a `multipart/related` body (JSON metadata part + file bytes). Returns `id`/`webViewLink`.
- **Never print the token.** Upload is a connector write — the user explicitly requested it here, which is the consent. The `confirm_connector_operation` tool is not exposed to the main agent in this environment.
