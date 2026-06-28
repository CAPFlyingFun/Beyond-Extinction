// Display units. Storage is ALWAYS meters (the game reads meters); these only
// affect how lengths are shown in the HUD readout / marker list / status.

export type Unit = "m" | "cm" | "km" | "in" | "ft" | "mi";

export const UNITS: Unit[] = ["m", "cm", "km", "in", "ft", "mi"];

export const UNIT_LABEL: Record<Unit, string> = {
  m: "meters (m)",
  cm: "centimeters (cm)",
  km: "kilometers (km)",
  in: "inches (in)",
  ft: "feet (ft)",
  mi: "miles (mi)",
};

const PER_METER: Record<Unit, number> = {
  m: 1,
  cm: 100,
  km: 0.001,
  in: 39.37007874015748,
  ft: 3.280839895013123,
  mi: 0.0006213711922373339,
};

const DECIMALS: Record<Unit, number> = {
  m: 2,
  cm: 1,
  km: 4,
  in: 1,
  ft: 2,
  mi: 6,
};

export function isUnit(value: string): value is Unit {
  return (UNITS as string[]).includes(value);
}

/** Convert meters to `unit` and format as a number string (no suffix). */
export function fmtLen(meters: number, unit: Unit): string {
  return (meters * PER_METER[unit]).toFixed(DECIMALS[unit]);
}

/** "x 1.50 , z -2.00 m" style readout. */
export function fmtXZ(x: number, z: number, unit: Unit): string {
  return `x ${fmtLen(x, unit)} , z ${fmtLen(z, unit)} ${unit}`;
}
