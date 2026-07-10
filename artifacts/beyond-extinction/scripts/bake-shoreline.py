#!/usr/bin/env python3
"""
Bake: make the painted island match the walkable (heightmap) island.

The heightmap coast is authoritative - the player walks wherever grey > HM_SEA,
so the satellite image must show land there. The painted island turned out to
be only 80-94% of the walkable radius (the topo island is fatter than the
photo island), which is why standing on the beach showed water on the minimap.

Two passes:
  1. RADIAL COASTLINE MORPH - per angle from the island centroid, stretch the
     painted island's outer band (identity inside 0.6x the coast radius, so
     the volcano and interior never move) until the painted coast lands
     exactly on the heightmap coast. Outside the coast the warp eases back to
     identity at the frame edge so the deep ocean stays put.
  2. RESIDUAL SHELF RECOLOR - any low (grey < 0.2) walkable pixel still
     classified as water is blended toward sand shallows graded by height,
     plus a foam line at the true waterline. Higher terrain is never repainted
     (dark shadowed jungle fools any RGB water classifier - that mistake
     washed out the whole east jungle in early attempts).

Run from artifacts/beyond-extinction (rewrites
public/assets/textures/island_color.jpg in place - keep a backup):
    python3 scripts/bake-shoreline.py
"""
import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter, map_coordinates, binary_dilation, binary_opening

TEX = "public/assets/textures/"
HM_SEA = 0.1

sat = np.asarray(Image.open(TEX + "island_color.jpg").convert("RGB"), dtype=np.float64)
H, W = sat.shape[:2]
hm = np.asarray(Image.open(TEX + "island_height.png").convert("L"), dtype=np.float64) / 255.0
ys = (np.arange(H) + 0.5) / H * hm.shape[0] - 0.5
xs = (np.arange(W) + 0.5) / W * hm.shape[1] - 0.5
gy, gx = np.meshgrid(ys, xs, indexing="ij")
hm_at = map_coordinates(hm, [gy, gx], order=1, mode="nearest")
land_hm = hm_at > HM_SEA


def water_of(img):
    """Turquoise / lagoon / deep-navy water. Blue must rival green: lagoon has
    B close to G, jungle has B well below G - that's what separates them."""
    R, G, B = img[..., 0], img[..., 1], img[..., 2]
    turq = (B > R + 12) & (B > 60) & (B > G - 18)
    lagoon = (G > R + 25) & (B > G - 25) & (B > R + 15) & (R < 110)
    navy = (B > G + 5) & (B > R + 10) & (R < 60)
    return binary_opening(turq | lagoon | navy, iterations=2)


land_sat = ~water_of(sat)

# ---- 1. radial coastline morph ----------------------------------------------
yy, xx = np.where(land_hm)
cy, cx = yy.mean(), xx.mean()
NA = 720
angles = np.linspace(0, 2 * np.pi, NA, endpoint=False)
rmax = min(cx, cy, W - cx, H - cy) - 4
rs = np.arange(0, rmax, 1.0)


def coast_profile(mask):
    prof = np.zeros(NA)
    for i, a in enumerate(angles):
        vals = map_coordinates(
            mask.astype(np.float64), [cy + np.sin(a) * rs, cx + np.cos(a) * rs], order=0
        )
        on = np.where(vals > 0.5)[0]
        prof[i] = rs[on[-1]] if len(on) else 0
    return prof


def csmooth(p, s):
    k = np.exp(-0.5 * (np.arange(-30, 31) / s) ** 2)
    k /= k.sum()
    return np.convolve(np.concatenate([p[-30:], p, p[:30]]), k, mode="same")[30:-30]


r_hm = csmooth(coast_profile(land_hm), 6)
r_sat = csmooth(coast_profile(land_sat), 6)
ratio = np.clip(r_sat / np.maximum(r_hm, 1), 0.75, 1.25)
print("coast ratio (painted/walkable): min %.3f median %.3f max %.3f" % (ratio.min(), np.median(ratio), ratio.max()))

py_g, px_g = np.meshgrid(np.arange(H, dtype=np.float64), np.arange(W, dtype=np.float64), indexing="ij")
dxg, dyg = px_g - cx, py_g - cy
r = np.hypot(dxg, dyg)
th = np.arctan2(dyg, dxg) % (2 * np.pi)
ti = th / (2 * np.pi) * NA
rh = np.interp(ti.ravel(), np.arange(NA), r_hm, period=NA).reshape(r.shape)
rt = np.interp(ti.ravel(), np.arange(NA), ratio, period=NA).reshape(r.shape)
r0 = 0.6 * rh
rin = np.where(
    r <= r0,
    r,
    np.where(
        r <= rh,
        r0 + (r - r0) * (rh * rt - r0) / np.maximum(rh - r0, 1),
        rh * rt + (r - rh) * (rmax - rh * rt) / np.maximum(rmax - rh, 1),
    ),
)
rin = np.where(r >= rmax, r, rin)
warped = np.stack(
    [map_coordinates(sat[..., c], [cy + np.sin(th) * rin, cx + np.cos(th) * rin], order=1, mode="nearest") for c in range(3)],
    axis=-1,
)

# ---- 2. residual shelf recolor (low ground only) -----------------------------
land_sat2 = ~water_of(warped)
shelf = land_hm & (~land_sat2) & (hm_at < 0.2)
print("residual shelf: %.2f%% of image" % (100 * shelf.mean()))


def masked_blur(img, mask, sigma):
    m = mask.astype(np.float64)
    den = gaussian_filter(m, sigma) + 1e-9
    return np.stack([gaussian_filter(img[..., c] * m, sigma) / den for c in range(3)], axis=-1)


land_fill = masked_blur(warped, land_sat2, 30)
above = np.clip((hm_at - HM_SEA) / 0.03, 0, 1)
sand = np.array([228.0, 214.0, 176.0])
shallow = 0.45 * warped + 0.55 * (0.35 * land_fill + 0.65 * sand)
dry = 0.22 * warped + 0.78 * (0.5 * land_fill + 0.5 * sand)
target = shallow * (1 - above[..., None]) + dry * above[..., None]
f = np.clip(gaussian_filter(shelf.astype(np.float64), 2.5) * 1.5, 0, 1)
out = warped * (1 - f[..., None]) + target * f[..., None]

edge = binary_dilation(land_hm, iterations=3) & ~land_hm
fE = (np.clip(gaussian_filter(edge.astype(np.float64), 1.8) * 1.3, 0, 1) * 0.4)[..., None]
out = out * (1 - fE) + np.array([232.0, 236.0, 232.0]) * fE

img = Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))
img.save(TEX + "island_color.jpg", quality=88)
print("wrote", TEX + "island_color.jpg")

w3 = water_of(np.asarray(img, dtype=np.float64))
bad = (land_hm & w3 & (hm_at < 0.2)).sum()
print("final low-shelf walkable-as-water: %.3f%% of walkable land" % (100 * bad / max(1, land_hm.sum())))
