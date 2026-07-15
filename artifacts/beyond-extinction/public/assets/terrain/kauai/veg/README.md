# Kauaʻi vegetation / landcover layers

384×384 grayscale PNGs covering the same 56×56 km world square as the height
tiles (~146 m/pixel). Pixel (0,0) is the NW corner; +x pixels run east (+X
world), +y pixels run south (+Z world):

```
worldX = (px / 383 - 0.5) * 56000
worldZ = (py / 383 - 0.5) * 56000
```

| file | contents |
| --- | --- |
| `canopy.png` | tree canopy cover, 0–255 (255 = 100% cover) — density input for procedural tree spawning |
| `landcover.png` | ESA WorldCover class per pixel — see `lcLegend` in `veg.json` (10 tree, 20 shrub, 30 grass, 40 crop, 50 built, 60 bare, 80 water, 90 wetland, 95 mangrove) |
| `water.png` | binary water mask (pixel value 0 or 1) |
| `river.png` | river-corridor intensity 0–255 (wider/larger channels brighter) |

`veg.json` carries the same metadata machine-readably.

Sources: ESA WorldCover 10 m + canopy/river rasters baked in the
kauai-terrain-scout tool; extracted from its embedded base64 layers.
Intended use: procedural vegetation placement (canopy = spawn density,
landcover = species/biome choice, water/river masks = exclusion zones).
Rivers/lakes themselves render from `../hydro.json` (USGS NHDPlus HR), not
from these rasters.
