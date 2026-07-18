#!/usr/bin/env python3
"""Bake real NHDPlus HR hydrography into public/assets/terrain/kauai/hydro.json.

Inputs (downloaded from hydro.nationalmap.gov NHDPlus_HR MapServer, EPSG:4326):
  /tmp/hydro_flowlines.json    layer 3 NetworkNHDFlowline (+VAA attrs)
  /tmp/hydro_waterbodies.json  layer 9 NHDWaterbody

The bake:
  * filters to perennial streams / artificial paths (+ big intermittent gulches)
  * merges segments into continuous chains by levelpathi (hydroseq order)
  * projects lat/lon -> world XZ (same linear mapping the height tiles use)
  * resamples + simplifies, assigns width from drainage area (totdasqkm)
  * drapes Y on the RENDERED terrain surface: replicates KauaiTileStreamer's
    97x97 mesh-vertex grid (bilinear over the 513px heightmap) so the water
    follows what the player actually sees, then clamps Y monotonic downstream
  * flags chains that reach the ocean (terminal end near sea level)
  * splits chains into per-tile runs so rivers stream with terrain tiles
  * lakes/reservoirs become flat rings triangulated at runtime

Run from artifacts/beyond-extinction:  python3 tools/bake_hydro.py
Requires ImageMagick (`magick`) for PNG -> raw RGB decode.
"""

import json
import math
import os
import subprocess
import sys
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KAUAI = os.path.join(ROOT, "public/assets/terrain/kauai")
OUT_PATH = os.path.join(KAUAI, "hydro.json")

# --- world mapping (must match manifest.json / KauaiTileStreamer) -----------
man = json.load(open(os.path.join(KAUAI, "manifest.json")))
BBOX = man["bbox"]  # latMin/latMax/lonMin/lonMax
LON0, LON1 = BBOX["lonmin"], BBOX["lonmax"]
LAT0, LAT1 = BBOX["latmin"], BBOX["latmax"]
TILE_M = man["tileSizeM"]          # 7000
P = man["tilePixels"]              # 513
TOTAL_M = TILE_M * 8               # 56000
HALF = TOTAL_M / 2
SEG = 192                          # mesh verts per tile side (193x193 grid; MUST match runtime terrainSampling.SEG)

def to_world(lon: float, lat: float):
    x = (lon - LON0) / (LON1 - LON0) * TOTAL_M - HALF
    z = (LAT1 - lat) / (LAT1 - LAT0) * TOTAL_M - HALF  # north = -Z
    return x, z

# --- load height tiles (lazy, per tile id) -----------------------------------
TILE_FILES = {t["id"]: t["file"] for t in man["tiles"]}
HEIGHTS = {}        # tile id -> 513x513 floats (decoded on demand)
MESHGRID = {}       # tile id -> 97x97 floats (rendered mesh vertex heights)

def heights_of(tid: str):
    h = HEIGHTS.get(tid)
    if h is None:
        png = os.path.join(KAUAI, TILE_FILES[tid])
        raw_dir = "/tmp/hydro_raw"
        os.makedirs(raw_dir, exist_ok=True)
        raw = os.path.join(raw_dir, tid + ".rgb")
        if not os.path.exists(raw) or os.path.getmtime(raw) < os.path.getmtime(png):
            subprocess.run(["magick", png, "-depth", "8", f"rgb:{raw}"], check=True)
        buf = open(raw, "rb").read()
        assert len(buf) == P * P * 3, f"{tid}: {len(buf)}"
        n3 = P * P * 3
        h = [buf[j] * 256.0 + buf[j + 1] + buf[j + 2] / 256.0 - 32768.0
             for j in range(0, n3, 3)]
        HEIGHTS[tid] = h
        print(f"  heights {tid} ({len(HEIGHTS)} tiles decoded)", end="\r")
    return h

def tile_id(col: int, row: int) -> str:
    return chr(65 + col) + str(row + 1)

def col_of(x: float) -> int:
    return min(7, max(0, round(x / TILE_M + 3.5)))

def row_of(z: float) -> int:
    return min(7, max(0, round(z / TILE_M + 3.5)))

def centre_of(col: int, row: int):
    return (col - 3.5) * TILE_M, (row - 3.5) * TILE_M

def bilinear(grid, n, fx, fy):
    fx = min(n - 1, max(0.0, fx))
    fy = min(n - 1, max(0.0, fy))
    x0, y0 = int(fx), int(fy)
    x1, y1 = min(n - 1, x0 + 1), min(n - 1, y0 + 1)
    tx, ty = fx - x0, fy - y0
    return (grid[y0 * n + x0] * (1 - tx) * (1 - ty)
            + grid[y0 * n + x1] * tx * (1 - ty)
            + grid[y1 * n + x0] * (1 - tx) * ty
            + grid[y1 * n + x1] * tx * ty)

def mesh_grid(tid: str):
    """97x97 vertex heights exactly as KauaiTileStreamer.buildMesh samples them."""
    g = MESHGRID.get(tid)
    if g is None:
        h = heights_of(tid)
        n = SEG + 1
        g = [0.0] * (n * n)
        for j in range(n):
            for i in range(n):
                g[j * n + i] = bilinear(h, P, i / SEG * (P - 1), j / SEG * (P - 1))
        MESHGRID[tid] = g
    return g

def surface_y(x: float, z: float) -> float:
    """Rendered terrain height at world XZ (bilinear over the 97x97 mesh grid)."""
    col, row = col_of(x), row_of(z)
    tid = tile_id(col, row)
    cx, cz = centre_of(col, row)
    u = (x - cx) / TILE_M + 0.5
    v = (z - cz) / TILE_M + 0.5
    return bilinear(mesh_grid(tid), SEG + 1, u * SEG, v * SEG)

# --- geometry helpers ---------------------------------------------------------
def resample(pts, step):
    """Even ~step-m spacing along an XZ polyline (keeps first/last)."""
    if len(pts) < 2:
        return pts
    out = [pts[0]]
    dist_since = 0.0
    for a, b in zip(pts, pts[1:]):
        seg = math.hypot(b[0] - a[0], b[1] - a[1])
        if seg <= 1e-9:
            continue
        pos = 0.0
        while dist_since + (seg - pos) >= step:
            adv = step - dist_since
            pos += adv
            dist_since = 0.0
            t = pos / seg
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
        dist_since += seg - pos
    if out[-1] != pts[-1]:
        out.append(pts[-1])
    return out

def rdp(pts, eps):
    """Douglas-Peucker on XZ."""
    if len(pts) < 3:
        return pts
    ax, az = pts[0]
    bx, bz = pts[-1]
    dx, dz = bx - ax, bz - az
    L2 = dx * dx + dz * dz
    imax, dmax = 0, -1.0
    for i in range(1, len(pts) - 1):
        px, pz = pts[i]
        if L2 == 0:
            d = math.hypot(px - ax, pz - az)
        else:
            t = max(0.0, min(1.0, ((px - ax) * dx + (pz - az) * dz) / L2))
            d = math.hypot(px - (ax + t * dx), pz - (az + t * dz))
        if d > dmax:
            imax, dmax = i, d
    if dmax <= eps:
        return [pts[0], pts[-1]]
    left = rdp(pts[: imax + 1], eps)
    right = rdp(pts[imax:], eps)
    return left[:-1] + right

def width_of(da_sqkm: float) -> float:
    """River width (m) from total drainage area."""
    da = max(0.0, da_sqkm or 0.0)
    return min(58.0, max(2.5, 2.0 + 2.3 * math.sqrt(da)))

IN_MAP = lambda x, z: -HALF <= x <= HALF and -HALF <= z <= HALF

# --- flowlines ----------------------------------------------------------------
def geom_lines(geom):
    if geom["type"] == "LineString":
        return [geom["coordinates"]]
    if geom["type"] == "MultiLineString":
        return geom["coordinates"]
    return []

def bake_rivers():
    fl = json.load(open("/tmp/hydro_flowlines.json"))["features"]
    keep = []
    for f in fl:
        p = f["properties"]
        fc = p.get("fcode")
        so = p.get("streamorde") or 0
        if fc == 46006 or fc == 55800 or (fc == 46003 and so >= 3):
            keep.append(f)
    print(f"flowlines kept: {len(keep)} / {len(fl)}")

    # chains by levelpathi, downstream order = descending hydroseq
    chains = defaultdict(list)
    for f in keep:
        chains[f["properties"].get("levelpathi")].append(f)
    rivers = []
    for lp, feats in chains.items():
        feats.sort(key=lambda f: -(f["properties"].get("hydroseq") or 0))
        pts = []       # world XZ, upstream -> downstream
        widths = []    # per-point
        name = None
        to_ocean = False
        min_elev = 1e9
        for f in feats:
            p = f["properties"]
            if p.get("gnis_name"):
                name = name or p["gnis_name"]
            w = width_of(p.get("totdasqkm"))
            me = p.get("minelevsmo")
            if me is not None and me > -9999:
                min_elev = min(min_elev, me / 100.0)  # cm -> m
            for line in geom_lines(f["geometry"]):
                for lon, lat in line:
                    x, z = to_world(lon, lat)
                    if pts and abs(pts[-1][0] - x) < 0.01 and abs(pts[-1][1] - z) < 0.01:
                        continue
                    pts.append((x, z))
                    widths.append(w)
        if len(pts) < 2:
            continue
        # clip: drop chains fully outside the map
        if not any(IN_MAP(x, z) for x, z in pts):
            continue
        # terminal end near sea level -> reaches the ocean
        if min_elev <= 1.0:
            to_ocean = True
        # simplify then resample; widths follow arc length (original chain is a
        # step function of width per feature, so arclength lookup is exact
        # enough after simplification)
        cum = [0.0]
        for a, b in zip(pts, pts[1:]):
            cum.append(cum[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
        total = cum[-1] or 1.0
        simp = rdp(pts, 6.0)
        simp = resample(simp, 35.0)
        scum = [0.0]
        for a, b in zip(simp, simp[1:]):
            scum.append(scum[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
        stotal = scum[-1] or 1.0
        import bisect
        rw = []
        for s in scum:
            d = s / stotal * total
            i = min(len(widths) - 1, bisect.bisect_left(cum, d))
            rw.append(widths[i])
        # smooth widths (moving average, 3-wide)
        sw = [rw[max(0, i - 1):i + 2] for i in range(len(rw))]
        rw = [sum(v) / len(v) for v in sw]
        # drape on rendered surface, then monotonic downstream
        run = []
        for (x, z), w in zip(simp, rw):
            xx = min(HALF - 1, max(-HALF + 1, x))
            zz = min(HALF - 1, max(-HALF + 1, z))
            # never below just-under-sea-level: coastal ends otherwise drape
            # onto the seafloor (terrain goes to -2500 offshore)
            y = max(-1.2, surface_y(xx, zz))
            run.append([x, y, z, w])
        for i in range(1, len(run)):
            run[i][1] = min(run[i][1], run[i - 1][1])   # water never flows uphill
        rivers.append({
            "name": name,
            "toOcean": to_ocean,
            "order": max((f["properties"].get("streamorde") or 0) for f in feats),
            "pts": run,
        })
    print(f"river chains: {len(rivers)}")
    return rivers

# --- waterbodies ----------------------------------------------------------------
def bake_lakes():
    wb = json.load(open("/tmp/hydro_waterbodies.json"))["features"]
    lakes = []
    for f in wb:
        p = f["properties"]
        fc = p.get("fcode") or 0
        if not (39000 <= fc < 39999 or 43600 <= fc <= 43699):
            continue  # lakes/ponds + reservoirs only (no swamps/estuary)
        area = p.get("areasqkm") or 0.0
        if area < 0.008 and not p.get("gnis_name"):
            continue
        geom = f["geometry"]
        polys = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
        for rings in polys:
            outer = [to_world(lon, lat) for lon, lat in rings[0]]
            if not any(IN_MAP(x, z) for x, z in outer):
                continue
            outer = rdp(outer, 4.0)
            if len(outer) < 4:
                continue
            # waterline: low percentile of rendered heights around the ring
            hs = sorted(surface_y(min(HALF - 1, max(-HALF + 1, x)),
                                  min(HALF - 1, max(-HALF + 1, z))) for x, z in outer)
            y = hs[max(0, int(len(hs) * 0.12))] + 0.25
            holes = []
            for ring in rings[1:]:
                hr = rdp([to_world(lon, lat) for lon, lat in ring], 4.0)
                if len(hr) >= 4:
                    holes.append([[round(x, 2), round(z, 2)] for x, z in hr])
            lakes.append({
                "name": p.get("gnis_name"),
                "y": round(y, 2),
                "ring": [[round(x, 2), round(z, 2)] for x, z in outer],
                "holes": holes,
            })
    print(f"lakes/reservoirs: {len(lakes)}")
    return lakes

# --- per-tile chunking ------------------------------------------------------------
def split_by_tile(rivers):
    """Split each chain into runs whose midpoints share a tile; duplicate the
    boundary point so ribbons stay continuous across the cut."""
    out = []
    for r in rivers:
        pts = r["pts"]
        cur = [pts[0]]
        cur_tile = None
        for a, b in zip(pts, pts[1:]):
            mx, mz = (a[0] + b[0]) / 2, (a[2] + b[2]) / 2
            t = tile_id(col_of(mx), row_of(mz))
            if cur_tile is None:
                cur_tile = t
            if t != cur_tile:
                out.append({**r, "tile": cur_tile, "pts": cur + [a]}) if len(cur) >= 1 else None
                cur = [a]
                cur_tile = t
            cur.append(b)
        if len(cur) >= 2:
            out.append({**r, "tile": cur_tile or tile_id(col_of(cur[0][0]), row_of(cur[0][2])), "pts": cur})
    # drop degenerate runs
    out = [r for r in out if len(r["pts"]) >= 2]
    return out

def main():
    rivers = bake_rivers()
    runs = split_by_tile(rivers)
    for r in runs:
        r["pts"] = [[round(x, 2), round(y, 2), round(z, 2), round(w, 1)] for x, y, z, w in r["pts"]]
    lakes = bake_lakes()
    for l in lakes:
        l["tile"] = tile_id(col_of(sum(p[0] for p in l["ring"]) / len(l["ring"])),
                            row_of(sum(p[1] for p in l["ring"]) / len(l["ring"])))
    doc = {
        "version": 1,
        "source": "USGS NHDPlus HR (hydro.nationalmap.gov), EPSG:4326, baked to world metres",
        "rivers": runs,
        "lakes": lakes,
    }
    with open(OUT_PATH, "w") as f:
        json.dump(doc, f, separators=(",", ":"))
    kb = os.path.getsize(OUT_PATH) / 1024
    named = sorted({r["name"] for r in runs if r["name"]})
    print(f"wrote {OUT_PATH} ({kb:.0f} KB) — {len(runs)} river runs, {len(lakes)} lakes")
    print(f"named rivers ({len(named)}): {', '.join(named[:12])}…")

if __name__ == "__main__":
    sys.setrecursionlimit(100000)
    main()
