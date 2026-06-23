import * as THREE from "three";

/**
 * Hand-drawn (canvas, no asset pipeline) tileable textures for Lab Seven's
 * floor and walls. World-space size each texture covers before repeating —
 * callers set `.repeat` based on the surface's actual dimensions divided by
 * these constants so seams land on whole tiles.
 */
export const FLOOR_TEXTURE_WORLD_SIZE = 10;
export const WALL_TEXTURE_WORLD_SIZE = { width: 8, height: 8 };

function makeCanvas(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  return { canvas, ctx };
}

function finish(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * Two-by-two block of slightly-varied dark floor tiles with seams and faint
 * scuff noise, so a large flat floor reads as built from panels rather than
 * one flat color.
 */
export function createFloorTexture(): THREE.CanvasTexture {
  const tile = 128;
  const { canvas, ctx } = makeCanvas(tile * 2, tile * 2);
  const shades = ["#1b2738", "#1d2a3c", "#192536", "#1c2940"];
  for (let ty = 0; ty < 2; ty++) {
    for (let tx = 0; tx < 2; tx++) {
      ctx.fillStyle = shades[(tx + ty * 2) % shades.length];
      ctx.fillRect(tx * tile, ty * tile, tile, tile);
    }
  }
  ctx.strokeStyle = "#0e1825";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(tile, 0);
  ctx.lineTo(tile, tile * 2);
  ctx.moveTo(0, tile);
  ctx.lineTo(tile * 2, tile);
  ctx.stroke();
  ctx.strokeRect(2, 2, tile * 2 - 4, tile * 2 - 4);

  ctx.globalAlpha = 0.06;
  for (let i = 0; i < 260; i++) {
    ctx.fillStyle = Math.random() > 0.5 ? "#ffffff" : "#000000";
    const r = Math.random() * 3 + 0.5;
    ctx.beginPath();
    ctx.arc(Math.random() * tile * 2, Math.random() * tile * 2, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  return finish(canvas);
}

/**
 * Paneled wall texture: a vertical seam, corner/midpoint rivets, and a faint
 * grime gradient toward the floor.
 */
export function createWallTexture(): THREE.CanvasTexture {
  const w = 256;
  const h = 256;
  const { canvas, ctx } = makeCanvas(w, h);
  ctx.fillStyle = "#202d40";
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = "#141b29";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(w / 2, 0);
  ctx.lineTo(w / 2, h);
  ctx.stroke();
  ctx.strokeRect(2, 2, w - 4, h - 4);

  ctx.fillStyle = "#0e1420";
  const rivetR = 3;
  for (const [x, y] of [
    [10, 10],
    [w - 10, 10],
    [10, h - 10],
    [w - 10, h - 10],
    [w / 2 - 10, 10],
    [w / 2 + 10, 10],
    [w / 2 - 10, h - 10],
    [w / 2 + 10, h - 10],
  ]) {
    ctx.beginPath();
    ctx.arc(x, y, rivetR, 0, Math.PI * 2);
    ctx.fill();
  }

  const grad = ctx.createLinearGradient(0, h * 0.78, 0, h);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(1, "rgba(0,0,0,0.28)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, h * 0.78, w, h * 0.22);
  return finish(canvas);
}

/**
 * Diagonal yellow/black hazard stripe decal — a single tile, stretched by
 * the caller's plane geometry rather than repeated.
 */
export function createHazardStripeTexture(): THREE.CanvasTexture {
  const size = 128;
  const { canvas, ctx } = makeCanvas(size, size);
  ctx.fillStyle = "#1a1a1a";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#e8b400";
  const stripeW = size / 4;
  for (let i = -1; i < 5; i++) {
    ctx.save();
    ctx.translate(i * stripeW * 2, 0);
    ctx.beginPath();
    ctx.moveTo(0, size);
    ctx.lineTo(stripeW, size);
    ctx.lineTo(stripeW * 2, 0);
    ctx.lineTo(stripeW, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  const tex = finish(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/** Small blinking-equipment panel texture: dark fascia with a grid of LEDs. */
export function createEquipmentPanelTexture(): THREE.CanvasTexture {
  const w = 128;
  const h = 96;
  const { canvas, ctx } = makeCanvas(w, h);
  ctx.fillStyle = "#0b1018";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "#1c2940";
  ctx.lineWidth = 3;
  ctx.strokeRect(2, 2, w - 4, h - 4);
  const cols = 8;
  const rows = 4;
  const ledColors = ["#39c5ff", "#39c5ff", "#39c5ff", "#ff8a3a", "#3df27a"];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (Math.random() < 0.35) continue;
      ctx.fillStyle = ledColors[Math.floor(Math.random() * ledColors.length)];
      const x = 12 + c * ((w - 24) / (cols - 1));
      const y = 16 + r * ((h - 32) / (rows - 1));
      ctx.beginPath();
      ctx.arc(x, y, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return finish(canvas);
}
