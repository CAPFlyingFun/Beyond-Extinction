/**
 * Auto camera-distance multiplier that keeps the subject readable across very
 * different viewport shapes. Returns 1 in the comfortable desktop/tablet band
 * and dollies the camera closer toward both extremes — narrow portrait phones
 * and very wide, short landscape phones — where the default fixed-FOV framing
 * otherwise leaves the subject tiny or marooned in empty space.
 *
 * Because the perspective camera's FOV is vertical and fixed, the subject's
 * on-screen *height* is aspect-independent; the only lever for "bigger subject
 * on an awkward viewport" is to physically move the camera in, which is what
 * this multiplier drives. Apply it to any gameplay/cutscene camera offset.
 */
const NARROW = 0.45; // tall portrait phone
const BAND_LO = 1.25; // comfortable band lower edge (desktop/tablet)
const BAND_HI = 2.0; // comfortable band upper edge
const ULTRAWIDE = 2.6; // wide, short landscape phone
const PORTRAIT_MIN = 0.55;
const WIDE_MIN = 0.8;

// A phone rotated sideways often reports an aspect ratio that falls inside
// the "comfortable desktop/tablet" band above (browser chrome eats vertical
// space, landing around 1.7-2.0), even though it has just as little vertical
// room as a desktop window would never have. Aspect alone can't tell a phone
// landscape view apart from a desktop one, so fall back to viewport height:
// below this, dolly in the same way portrait does, scaled by how cramped it
// is, so "max zoom" feels equally close after rotating either way.
const PHONE_LANDSCAPE_HEIGHT_LO = 320; // very short (e.g. a phone in landscape)
const PHONE_LANDSCAPE_HEIGHT_HI = 500; // taller phones / small tablets in landscape
const PHONE_LANDSCAPE_MIN = 0.6;

function clamp01(t: number): number {
  return Math.min(Math.max(t, 0), 1);
}

export function autoFramingScale(aspect: number, viewportHeight = Infinity): number {
  if (aspect < BAND_LO) {
    const t = clamp01((aspect - NARROW) / (BAND_LO - NARROW));
    return PORTRAIT_MIN + (1 - PORTRAIT_MIN) * t;
  }

  let scale = 1;
  if (aspect > BAND_HI) {
    const t = clamp01((aspect - BAND_HI) / (ULTRAWIDE - BAND_HI));
    scale = 1 - (1 - WIDE_MIN) * t;
  }

  // Whatever the aspect-only curve above produced, a short viewport (any
  // landscape phone, "comfortable" aspect or ultrawide) needs at least as
  // much dolly-in — take whichever compensation is stronger.
  if (viewportHeight < PHONE_LANDSCAPE_HEIGHT_HI) {
    const t = clamp01(
      (viewportHeight - PHONE_LANDSCAPE_HEIGHT_LO) /
        (PHONE_LANDSCAPE_HEIGHT_HI - PHONE_LANDSCAPE_HEIGHT_LO),
    );
    const heightScale = PHONE_LANDSCAPE_MIN + (1 - PHONE_LANDSCAPE_MIN) * t;
    scale = Math.min(scale, heightScale);
  }
  return scale;
}
