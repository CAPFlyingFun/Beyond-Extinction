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

function clamp01(t: number): number {
  return Math.min(Math.max(t, 0), 1);
}

export function autoFramingScale(aspect: number): number {
  if (aspect < BAND_LO) {
    const t = clamp01((aspect - NARROW) / (BAND_LO - NARROW));
    return PORTRAIT_MIN + (1 - PORTRAIT_MIN) * t;
  }
  if (aspect > BAND_HI) {
    const t = clamp01((aspect - BAND_HI) / (ULTRAWIDE - BAND_HI));
    return 1 - (1 - WIDE_MIN) * t;
  }
  return 1;
}
