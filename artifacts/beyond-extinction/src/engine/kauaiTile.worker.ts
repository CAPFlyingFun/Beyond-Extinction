/// <reference lib="webworker" />
/**
 * kauaiTile.worker.ts — Terrarium tile decode OFF the main thread.
 *
 * Godot-parity perf tip #1: the Image → canvas → getImageData decode of a
 * 513² tile is a ~100 ms-class main-thread hitch every time the player crosses
 * a tile boundary (the same 165 ms stutter the Godot build measured before it
 * moved bakes to a thread). Here the whole fetch → createImageBitmap →
 * OffscreenCanvas → Float32Array pipeline runs in a worker and the heights
 * come back as a transferred ArrayBuffer — the main thread only ever touches
 * the finished array.
 *
 * KEEP IN SYNC: the elevation formula duplicates decodeElev() in
 * KauaiTileStreamer.ts (Terrarium r*256 + g + b/256 − 32768, nodata floored
 * at −6000) — the worker can't import the streamer without dragging THREE in.
 */
interface TileReq {
  id: number;
  url: string;
  P: number;
}
self.onmessage = async (e: MessageEvent<TileReq>) => {
  const { id, url, P } = e.data;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const bmp = await createImageBitmap(await r.blob());
    const cv = new OffscreenCanvas(P, P);
    const g = cv.getContext("2d", { willReadFrequently: true });
    if (!g) throw new Error("no 2d ctx in worker");
    g.drawImage(bmp, 0, 0, P, P);
    bmp.close();
    const d = g.getImageData(0, 0, P, P).data;
    const out = new Float32Array(P * P);
    for (let i = 0; i < P * P; i++) {
      const j = i * 4;
      const e2 = d[j] * 256 + d[j + 1] + d[j + 2] / 256 - 32768;
      out[i] = e2 < -6000 ? -6000 : e2;
    }
    (self as unknown as Worker).postMessage({ id, heights: out }, [out.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({
      id,
      error: String((err as Error)?.message ?? err),
    });
  }
};
