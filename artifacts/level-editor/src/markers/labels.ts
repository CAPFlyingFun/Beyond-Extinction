import * as THREE from "three";

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** A camera-facing text label that always renders on top of geometry. */
export function makeLabel(text: string, color = "#dbe7ff"): THREE.Sprite {
  const label = text.trim() || "(untagged)";
  const pad = 14;
  const fontSize = 42;
  const font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`;

  const measure = document.createElement("canvas").getContext("2d")!;
  measure.font = font;
  const textW = Math.ceil(measure.measureText(label).width);

  const w = textW + pad * 2;
  const h = fontSize + pad * 2;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;

  ctx.fillStyle = "rgba(8,12,20,0.78)";
  roundRect(ctx, 0, 0, w, h, 12);
  ctx.fill();
  ctx.strokeStyle = "rgba(120,150,200,0.35)";
  ctx.lineWidth = 2;
  roundRect(ctx, 1, 1, w - 2, h - 2, 11);
  ctx.stroke();

  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(label, pad, h / 2 + 1);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;

  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(mat);
  const pxToWorld = 0.006;
  sprite.scale.set(w * pxToWorld, h * pxToWorld, 1);
  sprite.renderOrder = 999;
  return sprite;
}
