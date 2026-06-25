---
name: Download large Google Drive files into a repl (no gdown/wget)
description: curl/node recipe for fetching big public Drive files server-side, handling the confirm-token and Restricted-sharing cases
---

Only `curl` and Node `fetch` are available here (no `gdown`, `wget`, python/pip). To pull a large public Drive file straight into the project (bypasses the browser uploader's size limit):

1. Request `https://drive.usercontent.google.com/download?id=<FILE_ID>&export=download&confirm=t`.
2. If the response is binary, done. If it's HTML (content-type `text/html`, or body starts with `<!DOCTYPE`/`<html`), it's the virus-scan/confirm form: parse hidden inputs `id`, `confirm`, `uuid` from the HTML and re-request `…/download?id=&export=download&confirm=&uuid=`.
3. FILE_ID comes from the share URL `https://drive.google.com/file/d/<FILE_ID>/view`.

**Restricted-file tell:** a ~0.9MB HTML page titled "Google Drive: Sign-in" means the file is NOT public — Google served a login wall, not the file. Ask the user to set General access → "Anyone with the link" (Viewer is enough; Editor also works). Never use the user's own credentials.

**Validate a GLB after download:** magic bytes @0 == `glTF` (hex `67746c46`); version = uint32LE @4; first chunk JSON @20 (len uint32LE @12, type ascii @16). Parse the JSON chunk to report meshes/materials/textures/animations.

**Why:** the in-browser uploader chokes on large files; server-side fetch has no such limit. The sign-in-page case cost a round trip — check the HTML title before assuming a confirm-token problem.
