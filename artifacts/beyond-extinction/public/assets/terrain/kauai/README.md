# Kauaʻi terrain grid (real DEM)

8×8 chessboard of heightmap tiles covering Kauaʻi at ~1:1 scale, for the
streaming terrain system (TS mobile build + Godot PC build share this folder).

- **Source:** AWS Terrarium DEM (z14, ~9 m/px), peak 1598.6 m (real Kawaikini).
- **Grid:** columns A–H = west→east, rows 1–8 = north→south. A1 = north-west.
- **Tile:** 7000 m square, 513² px here (~13.7 m base; regenerate at 1025²/2049²
  for finer PC detail). Near-player 1 m detail comes from the sculpt patch layer.
- **Edge overlap:** tiles share a 1-px border with their east/south neighbours —
  tile (c,r) = master mosaic `[512r..512r+512][512c..512c+512]` (clamped at the
  map edge). Adjacent tiles are byte-identical along shared edges, so tile
  meshes weld watertight (no seam gaps). Keep this overlap when regenerating.
- **Encoding (each PNG):** terrarium RGB — `elev_m = R*256 + G + B/256 - 32768`.
- **World mapping + per-tile bounds/elevation:** see `manifest.json`.
