# Kauaʻi terrain grid (real DEM)

8×8 chessboard of heightmap tiles covering Kauaʻi at ~1:1 scale, for the
streaming terrain system (TS mobile build + Godot PC build share this folder).

- **Source:** AWS Terrarium DEM (z14, ~9 m/px), peak 1598.6 m (real Kawaikini).
- **Grid:** columns A–H = west→east, rows 1–8 = north→south. A1 = north-west.
- **Tile:** 7000 m square, 512² px here (~13.7 m base; regenerate at 1024²/2048²
  for finer PC detail). Near-player 1 m detail comes from the sculpt patch layer.
- **Encoding (each PNG):** terrarium RGB — `elev_m = R*256 + G + B/256 - 32768`.
- **World mapping + per-tile bounds/elevation:** see `manifest.json`.
