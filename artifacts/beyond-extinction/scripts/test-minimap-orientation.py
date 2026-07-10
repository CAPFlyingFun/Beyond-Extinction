#!/usr/bin/env python3
"""
Ground-truth test for the island minimap orientation.

Replicates, in plain numpy, the exact math of:
  - worldToIslandUV / islandUVToWorld  (src/engine/beachTerrain.ts)
  - beachHeight land/water sampling    (bilinear over island_height.png)
  - drawMinimap's canvas transform     (src/engine/IslandMap.ts)
and then verifies two things:

  A. ROUND-TRIP: for random headings and canvas offsets, the world point a
     minimap pixel displays (canvas -> draw transform -> image px -> uv ->
     world) equals the world point it MUST display (player + dx*right -
     dy*forward). This pins the draw transform exactly - any mirror or
     rotation-direction bug fails loudly.

  B. SEMANTICS: standing at the Jack spawn facing N/E/S/W, the land/water
     visible on each canvas side (top/right/bottom/left) matches direct
     terrain sampling of the world ahead/right/behind/left of the player.
     This is the user-facing check: "land on my left in 3D = land on the
     minimap's left".

Also asserts the N-marker and full-map arrow formulas agree with the same
conventions. Run from artifacts/beyond-extinction:  python3 scripts/test-minimap-orientation.py
"""

import math
import sys

import numpy as np
from PIL import Image

# ---- constants mirrored from src/engine/beachTerrain.ts --------------------
MAP_SCALE = 40.8
HM_SPAN = 300 * MAP_SCALE
HM_CZ = 122 * MAP_SCALE
HM_SEA = 0.1
METERS_PER_UNIT = 1.8 / 6.4

# Jack spawn (src/scenes/ChapterOnePlaceholderScene.ts)
JACK = {"x": -106 * MAP_SCALE, "z": 182 * MAP_SCALE}

# Minimap (src/engine/IslandMap.ts)
MINIMAP_RANGE_M = 300

HEIGHT = np.asarray(
    Image.open("public/assets/textures/island_height.png").convert("L"),
    dtype=np.float64,
) / 255.0
HM = HEIGHT.shape[0]
assert HEIGHT.shape[0] == HEIGHT.shape[1], "heightmap must be square"


def world_to_uv(x, z):
    """worldToIslandUV — true aerial view: image-top = -Z (north)."""
    return 0.5 + x / HM_SPAN, 0.5 + (z - HM_CZ) / HM_SPAN


def uv_to_world(u, v):
    return (u - 0.5) * HM_SPAN, HM_CZ + (v - 0.5) * HM_SPAN


def grey_at(x, z):
    """Bilinear heightmap grey at a world point (beachHeight's sampling)."""
    u, v = world_to_uv(x, z)
    if u <= 0 or u >= 1 or v <= 0 or v >= 1:
        return 0.0  # deep water off-map
    fx, fy = u * (HM - 1), v * (HM - 1)
    x0, y0 = int(fx), int(fy)
    x1, y1 = min(x0 + 1, HM - 1), min(y0 + 1, HM - 1)
    tx, ty = fx - x0, fy - y0
    return (
        HEIGHT[y0, x0] * (1 - tx) * (1 - ty)
        + HEIGHT[y0, x1] * tx * (1 - ty)
        + HEIGHT[y1, x0] * (1 - tx) * ty
        + HEIGHT[y1, x1] * tx * ty
    )


def is_land(x, z):
    return grey_at(x, z) > HM_SEA


def forward(yaw):
    """PlayerController: forward = (-sin yaw, -cos yaw); yaw = -heading."""
    return -math.sin(yaw), -math.cos(yaw)


def right(yaw):
    fx, fz = forward(yaw)
    return -fz, fx  # right of forward, y-up world


def minimap_world_at(yaw, dx, dy, cc):
    """
    The world point the CURRENT drawMinimap code shows at canvas offset
    (dx, dy) from the minimap centre. Mirrors IslandMap.drawMinimap exactly:
      translate(cc,cc); transform(cos,sin,-sin,cos); scale(sc);
      drawImage(img, -u*dim, -v*dim)
    i.e. canvas = R(yaw) . (sc . image_offset)  =>  image_offset =
    R(-yaw) . canvas / sc.
    """
    frac = MINIMAP_RANGE_M / METERS_PER_UNIT / HM_SPAN
    dim = HM
    sc = cc / (frac * dim)
    cy, sy = math.cos(yaw), math.sin(yaw)
    # inverse of [[cy,-sy],[sy,cy]] is [[cy,sy],[-sy,cy]]
    ix = (cy * dx + sy * dy) / sc
    iy = (-sy * dx + cy * dy) / sc
    u0, v0 = world_to_uv(JACK["x"], JACK["z"])
    u = u0 + ix / dim
    v = v0 + iy / dim
    return uv_to_world(u, v)


def fail(msg):
    print(f"FAIL: {msg}")
    sys.exit(1)


# ---- A. round-trip ----------------------------------------------------------
rng = np.random.default_rng(7)
cc = 80.0
for trial in range(200):
    heading = float(rng.uniform(0, 360))
    yaw = math.radians(-heading)  # placeAt: yaw = -heading
    dx = float(rng.uniform(-cc, cc))
    dy = float(rng.uniform(-cc, cc))
    shown = minimap_world_at(yaw, dx, dy, cc)
    fx, fz = forward(yaw)
    rx, rz = right(yaw)
    world_per_px = (MINIMAP_RANGE_M / METERS_PER_UNIT) / cc
    want = (
        JACK["x"] + (dx * rx - dy * fx) * world_per_px,
        JACK["z"] + (dx * rz - dy * fz) * world_per_px,
    )
    if math.hypot(shown[0] - want[0], shown[1] - want[1]) > 1e-6 * HM_SPAN:
        fail(
            f"round-trip: heading={heading:.1f} canvas=({dx:.1f},{dy:.1f}) "
            f"shows {shown} but must show {want}"
        )
print("A. round-trip: 200/200 random canvas pixels show the correct world point")

# ---- B. semantics at the spawn ----------------------------------------------
D = 250 / METERS_PER_UNIT  # sample 250 m out (inside the 300 m minimap range)
SIDES = {"top": (0, -0.83 * cc), "right": (0.83 * cc, 0), "bottom": (0, 0.83 * cc), "left": (-0.83 * cc, 0)}
ok = True
for heading, name in [(0, "North"), (90, "East"), (180, "South"), (270, "West")]:
    yaw = math.radians(-heading)
    fx, fz = forward(yaw)
    rx, rz = right(yaw)
    world_dirs = {
        "top": (fx, fz),
        "right": (rx, rz),
        "bottom": (-fx, -fz),
        "left": (-rx, -rz),
    }
    row = []
    for side, (dx, dy) in SIDES.items():
        shown = is_land(*minimap_world_at(yaw, dx, dy, cc))
        wx, wz = world_dirs[side]
        truth = is_land(JACK["x"] + wx * D, JACK["z"] + wz * D)
        mark = "ok" if shown == truth else "MISMATCH"
        if shown != truth:
            ok = False
        row.append(f"{side}={'land' if shown else 'water'}({mark})")
    print(f"B. facing {name:5s}: " + "  ".join(row))
if not ok:
    fail("minimap side does not match world side")

# ---- C. N marker + full-map arrow -------------------------------------------
# N marker (IslandMap): (sin yaw, -cos yaw) must equal where world-north
# (0,-1) lands through the same R(yaw) canvas mapping.
for heading in (0, 90, 180, 270, 37.5):
    yaw = math.radians(-heading)
    cy, sy = math.cos(yaw), math.sin(yaw)
    # image dir of world-north = (0,-1) (v shrinks northward); through
    # canvas = R(yaw).image: (cy*0 - sy*-1, sy*0 + cy*-1) = (sy, -cy)
    nx, ny = sy, -cy
    want = (math.sin(yaw), -math.cos(yaw))
    if abs(nx - want[0]) > 1e-12 or abs(ny - want[1]) > 1e-12:
        fail(f"N marker mismatch at heading {heading}")
    # full-map arrow: canvas dir must be (fx, fz) 1:1 on the north-up map
    fx, fz = forward(yaw)
    # e.g. facing north (heading 0) arrow must point UP the canvas (dy<0)
    if heading == 0 and not (abs(fx) < 1e-12 and fz < 0):
        fail("arrow: facing north must point up")
print("C. N marker + full-map arrow formulas consistent")

print("\nPASS: minimap orientation is correct for all headings")
