import * as THREE from "three";

/** Tints a highlight by what kind of thing it's pointing at. */
export type FocusColor = "story" | "friendly" | "info" | "tech" | "danger";

const FOCUS_COLORS: Record<FocusColor, number> = {
  story: 0xffd54a,
  friendly: 0x4ade80,
  info: 0x60a5fa,
  tech: 0xa78bfa,
  danger: 0xff5c5c,
};

export interface ObjectiveHighlightOptions {
  color: FocusColor;
  /** Single glyph (emoji or short text) shown on the floating marker. */
  icon: string;
  /** Ground-ring radius, in world units. */
  radius?: number;
  /** Marker height above the anchor's world position. */
  markerHeight?: number;
}

/**
 * A cinematic "this matters" cue for a single world object: a soft pulsing
 * ring on the ground plus a floating icon marker, color-coded by what kind
 * of thing it's pointing at (see FocusColor). Tracks the anchor's *world*
 * position each update() rather than parenting under it, so it stays a
 * correct size/orientation even if the anchor is scaled or nested deep in a
 * model hierarchy.
 *
 * Built deliberately subtle — a gentle breathing glow, not an arcade marker —
 * per the project's "the player learns through the story, not a tutorial"
 * design philosophy. setVisible() hides it the moment the player has
 * selected the object and Jack starts walking toward it, and restores it if
 * the interaction is cancelled.
 */
export class ObjectiveHighlight {
  readonly group: THREE.Group;
  private ring: THREE.Mesh;
  private marker: THREE.Sprite;
  private visible = true;
  // Offset so multiple highlights don't pulse in lockstep.
  private elapsed = Math.random() * Math.PI * 2;
  private markerHeight: number;
  private worldPos = new THREE.Vector3();
  private currentIcon: string;
  private currentColor: FocusColor;

  constructor(
    scene: THREE.Scene,
    private readonly anchor: THREE.Object3D,
    opts: ObjectiveHighlightOptions,
  ) {
    const colorHex = FOCUS_COLORS[opts.color];
    const radius = opts.radius ?? 1.4;
    this.markerHeight = opts.markerHeight ?? 3.2;
    this.currentIcon = opts.icon;
    this.currentColor = opts.color;

    this.group = new THREE.Group();

    const ringGeo = new THREE.RingGeometry(radius * 0.75, radius, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color: colorHex,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.ring = new THREE.Mesh(ringGeo, ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.05;
    this.group.add(this.ring);

    const markerMat = new THREE.SpriteMaterial({
      map: makeMarkerTexture(colorHex, opts.icon),
      transparent: true,
      depthWrite: false,
      depthTest: false, // show through terrain/trees so it reads as a quest beacon
    });
    this.marker = new THREE.Sprite(markerMat);
    this.marker.scale.setScalar(1.6);
    this.marker.renderOrder = 999;
    this.group.add(this.marker);

    anchor.getWorldPosition(this.worldPos);
    this.group.position.copy(this.worldPos);
    scene.add(this.group);
  }

  /** Pulses the ring, bobs the marker, and re-anchors to the target's current world position. */
  update(dt: number): void {
    this.anchor.getWorldPosition(this.worldPos);
    this.group.position.copy(this.worldPos);

    this.elapsed += dt;
    const breathe = 0.5 + 0.5 * Math.sin(this.elapsed * 1.6);

    this.ring.visible = this.visible;
    this.marker.visible = this.visible;
    if (!this.visible) return;

    const ringMat = this.ring.material as THREE.MeshBasicMaterial;
    ringMat.opacity = 0.25 + breathe * 0.3;
    this.ring.scale.setScalar(1 + breathe * 0.06);

    const markerMat = this.marker.material as THREE.SpriteMaterial;
    markerMat.opacity = 0.7 + breathe * 0.3;
    this.marker.scale.setScalar(1.6 * (1 + breathe * 0.04));
    this.marker.position.y = this.markerHeight + breathe * 0.25;
  }

  /** Hide once selected/walking, restore on cancel. */
  setVisible(visible: boolean): void {
    this.visible = visible;
  }

  /** Re-skins the marker/ring (e.g. an objective turning urgent) — a no-op if unchanged. */
  setIcon(icon: string, color: FocusColor): void {
    if (icon === this.currentIcon && color === this.currentColor) return;
    this.currentIcon = icon;
    this.currentColor = color;
    const colorHex = FOCUS_COLORS[color];

    const markerMat = this.marker.material as THREE.SpriteMaterial;
    markerMat.map?.dispose();
    markerMat.map = makeMarkerTexture(colorHex, icon);
    markerMat.needsUpdate = true;

    (this.ring.material as THREE.MeshBasicMaterial).color.setHex(colorHex);
  }

  dispose(): void {
    this.group.parent?.remove(this.group);
    this.ring.geometry.dispose();
    (this.ring.material as THREE.Material).dispose();
    (this.marker.material as THREE.SpriteMaterial).map?.dispose();
    (this.marker.material as THREE.Material).dispose();
  }
}

function makeMarkerTexture(colorHex: number, icon: string): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const color = new THREE.Color(colorHex);
  const cssColor = `rgb(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)})`;

  const cx = size / 2;
  const cy = size / 2;
  const glow = ctx.createRadialGradient(cx, cy, size * 0.08, cx, cy, size * 0.5);
  glow.addColorStop(0, cssColor);
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, size, size);
  ctx.globalAlpha = 1;

  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.27, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(8, 14, 24, 0.55)";
  ctx.fill();
  ctx.lineWidth = size * 0.025;
  ctx.strokeStyle = cssColor;
  ctx.stroke();

  ctx.font = `${size * 0.34}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#fff";
  ctx.fillText(icon, cx, cy + size * 0.02);

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}
