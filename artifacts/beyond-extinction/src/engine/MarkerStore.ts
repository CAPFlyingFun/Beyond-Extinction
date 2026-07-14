import { assetUrl } from "./assets";

/**
 * MarkerStore — the persistence layer for the in-game Marker Editor (the
 * ARK-style "lay down spawn points / objects" dev tool). It holds the placed
 * markers for each scene and recalls them in the game.
 *
 * Two layers, merged per-scene:
 *  - BAKED defaults committed to the repo at `public/editor/markers.json` (the
 *    "Editor" folder the design calls for). This is what every player sees.
 *  - LOCAL edits the dev makes live, kept in localStorage so they survive a
 *    reload without a commit. A scene present in the local layer overrides the
 *    baked layer for that scene.
 *
 * To make local edits global, the dev exports the merged JSON (see
 * {@link exportJson}) and commits it to `public/editor/markers.json`; a
 * Cloudflare-backed store can replace the export step later. Personal-progress
 * saves live in SaveManager — this is the shared world content, deliberately
 * separate.
 */

const LOCAL_KEY = "beyond-extinction.editor.markers.v1";
const BAKED_URL = assetUrl("editor/markers.json");

export interface MarkerDef {
  /** Stable id within its scene (used to select/remove a placed marker). */
  id: string;
  /** Catalogue type key (see markerCatalog) — decides the mesh + meaning. */
  type: string;
  /** Author-given name, e.g. "sarah_body" or "jump over ravine". Optional, but
   *  this is the key the game wires behaviour to (cinematic markers, quests). */
  name?: string;
  x: number;
  y: number;
  z: number;
  /** Y rotation in radians (default 0). */
  rotY?: number;
  /** Uniform scale multiplier (default 1). */
  scale?: number;
}

type MarkerBook = Record<string, MarkerDef[]>;

class MarkerStoreImpl {
  private baked: MarkerBook = {};
  private local: MarkerBook = {};
  private loaded = false;

  /** Fetch the baked markers and read any local edits. Safe to call repeatedly. */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    this.local = this.readLocal();
    try {
      const res = await fetch(BAKED_URL, { cache: "no-cache" });
      if (res.ok) {
        const json = (await res.json()) as MarkerBook;
        if (json && typeof json === "object") this.baked = json;
      }
    } catch {
      // No baked file yet (or offline) — the local layer alone still works.
    }
  }

  /** The effective markers for a scene: local edits win over baked defaults. */
  forScene(sceneId: string): MarkerDef[] {
    const list = this.local[sceneId] ?? this.baked[sceneId] ?? [];
    // Hand back clones so callers can't mutate the stored defs in place.
    return list.map((m) => ({ ...m }));
  }

  /** True once this scene has been edited locally (drives "unsaved" hints). */
  hasLocalEdits(sceneId: string): boolean {
    return Array.isArray(this.local[sceneId]);
  }

  /** First marker in a scene with the given author name (for wiring by name). */
  byName(sceneId: string, name: string): MarkerDef | undefined {
    const m = this.forScene(sceneId).find((d) => d.name === name);
    return m ? { ...m } : undefined;
  }

  /** Replace a scene's markers in the local layer and persist to localStorage. */
  setScene(sceneId: string, defs: MarkerDef[]): void {
    this.local[sceneId] = defs.map((m) => ({ ...m }));
    this.persist();
  }

  /** Drop local edits for a scene, reverting to the baked defaults. */
  revertScene(sceneId: string): void {
    delete this.local[sceneId];
    this.persist();
  }

  /**
   * The merged book (baked overlaid with local edits) as pretty JSON — what the
   * dev commits to `public/editor/markers.json` to publish the layout globally.
   */
  exportJson(): string {
    const merged: MarkerBook = {};
    for (const [k, v] of Object.entries(this.baked)) merged[k] = v;
    for (const [k, v] of Object.entries(this.local)) merged[k] = v;
    return JSON.stringify(merged, null, 2);
  }

  /** Short unique id for a freshly placed marker. */
  newId(): string {
    // Time + counter, both monotonic in the browser (no Math.random needed).
    this.seq += 1;
    return `m${Date.now().toString(36)}${this.seq.toString(36)}`;
  }
  private seq = 0;

  private readLocal(): MarkerBook {
    try {
      const raw = localStorage.getItem(LOCAL_KEY);
      if (!raw) return {};
      const book = JSON.parse(raw) as MarkerBook;
      return book && typeof book === "object" ? book : {};
    } catch {
      return {};
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(this.local));
    } catch {
      // Storage unavailable — edits stay in memory for this session only.
    }
  }
}

/** Shared singleton (autoload-equivalent). */
export const MarkerStore = new MarkerStoreImpl();
