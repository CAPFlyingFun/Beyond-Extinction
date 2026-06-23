# Beyond Extinction PWA and GitHub Pages Notes

Beyond Extinction is still a website at its core: index.html loads JavaScript, JavaScript loads Three.js, and Three.js renders the game into a canvas using WebGL.

That means the project can be:

- hosted by Replit during development,
- hosted by GitHub Pages for easy public testing,
- installed to a phone home screen as a PWA,
- cached for offline play after the first successful load.

## Development

Run the Beyond Extinction artifact with Vite:

pnpm install
pnpm --filter @workspace/beyond-extinction dev

## Build for GitHub Pages

pnpm --filter @workspace/beyond-extinction build:github

The GitHub Pages build uses /Beyond-Extinction/ as its base path so Vite assets load correctly from a project page.

## Model uploads

Upload optimized GLB models manually to:

artifacts/beyond-extinction/public/assets/models/Jack.glb
artifacts/beyond-extinction/public/assets/models/Sarah.glb

The engine will automatically use them when present.
