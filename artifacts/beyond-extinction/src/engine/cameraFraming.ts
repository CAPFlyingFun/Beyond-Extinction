/**
 * Auto camera-distance multiplier that keeps the subject readable across very
 * different viewport shapes. Returns 1 in the comfortable desktop/tablet band.
 *
 * Narrow portrait phones dolly the camera *back* (scale > 1) rather than in:
 * a tall, narrow frame already crops the sides tightly, so moving the camera
 * closer (the old behaviour) made the subject loom and cut off surrounding
 * context. Pair this with portraitFovBoost() below, which widens the FOV over
 * the same range, so the player sees more of the room instead of a tighter
 * crop on a bigger subject.
 *
 * Very wide, short landscape phones still dolly *in* (scale < 1) — that band
 * is unaffected by the portrait change above and keeps its original behaviour,
 * where the default fixed-FOV framing otherwise leaves the subject tiny or
 * marooned in empty space.
 */
const NARROW = 0.45; // tall portrait phone
const BAND_LO = 1.25; // comfortable band lower edge (desktop/tablet)
const BAND_HI = 2.0; // comfortable band upper edge
const ULTRAWIDE = 2.6; // wide, short landscape phone
const PORTRAIT_MAX = 1.4; // dolly back this much at the narrowest portrait
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
    return PORTRAIT_MAX - (PORTRAIT_MAX - 1) * t;
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

/**
 * Extra vertical FOV (degrees) to add on top of the player's FOV preference
 * in narrow portrait, paired with the dolly-back above so a wider view opens
 * up rather than just pushing the same crop further away. Zero through the
 * comfortable desktop/tablet band and beyond — landscape framing is FOV-
 * neutral and untouched by this.
 */
const PORTRAIT_FOV_BOOST_MAX = 18;

export function portraitFovBoost(aspect: number): number {
  if (aspect >= BAND_LO) return 0;
  const t = clamp01((aspect - NARROW) / (BAND_LO - NARROW));
  return PORTRAIT_FOV_BOOST_MAX * (1 - t);
}
