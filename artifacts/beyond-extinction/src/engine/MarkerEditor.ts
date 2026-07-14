import * as THREE from "three";
import { MarkerStore, type MarkerDef } from "./MarkerStore";
import { MARKER_TYPES, buildMarkerObject, markerLabel } from "./markerCatalog";
import { CH0203_MARKER_IDS } from "./cinematic/markers";

/** Suggested marker names offered as autocomplete (story-critical ids first).
 *  Naming a marker one of these is what lets the game wire behaviour to it. */
const SUGGESTED_NAMES: string[] = [
  ...CH0203_MARKER_IDS,
  // Ch02–03 beat checkpoints (see the build spec's coordinate table).
  "beat_2.2.A",
  "beat_2.2.C",
  "beat_2.5.A",
  "beat_2.6.A",
  "beat_2.6.C",
  "beat_3.2.A",
  "beat_3.3.B",
  "beat_3.4.A",
  "beat_3.3.C",
  "beat_3.5.A",
  "beat_3.5.B",
];

/**
 * In-game Marker Editor — the ARK-style "lay down spawn points and objects"
 * dev tool, reached only through the PIN gate (see DevPortal). While it is open
 * the scene's own camera/movement is frozen and the editor drives its OWN fly
 * camera (so the game keeps rendering the live scene, but the dev can roam it
 * freely). Tap the ground to drop the selected marker; tap a marker to select
 * it, then rotate / scale / delete it. Save writes the layout to localStorage;
 * Export produces the JSON committed to `public/editor/markers.json` so the
 * layout is recalled for every player.
 */

export interface EditorSceneRef {
  scene: THREE.Scene;
  camera: THREE.Camera;
  name: string;
}

export interface MarkerEditorDeps {
  /** The live scene the editor operates on (null when none is active). */
  getActive: () => EditorSceneRef | null;
  domElement: HTMLCanvasElement;
  uiLayer: HTMLElement;
  input: {
    setEnabled: (b: boolean) => void;
    /** Suspend the first-person HUD/look layer so it stops covering the canvas. */
    enableFpControls: (b: boolean) => void;
    fpControlsActive: boolean;
  };
  /** Called on open/close so the host can suspend other gestures (dev portal). */
  onOpenChange?: (open: boolean) => void;
  playSfx?: (n: string) => void;
  showToast?: (msg: string) => void;
}

const MOVE_SPEED = 26; // world units / second for the fly camera
const DRAG_LOOK = 0.0032; // radians per pixel
const TAP_SLOP = 6; // px of pointer travel still counted as a tap (not a drag)

export class MarkerEditor {
  private open = false;
  private sceneRef: EditorSceneRef | null = null;
  private sceneId = "";
  private cam = new THREE.PerspectiveCamera(70, 1, 0.1, 4000);

  private working: MarkerDef[] = [];
  private objById = new Map<string, THREE.Object3D>();
  private selectedId: string | null = null;
  private selectedType = MARKER_TYPES[0].key;
  private boxHelper?: THREE.BoxHelper;
  private dirty = false;
  private wasFp = false; // whether FP controls were active before opening

  // Fly camera orientation + movement key state.
  private yaw = 0;
  private pitch = 0;
  private readonly keys = new Set<string>();

  // Pointer drag tracking (distinguishes a look-drag from a tap-to-place).
  private pointerId: number | null = null;
  private downX = 0;
  private downY = 0;
  private lastX = 0;
  private lastY = 0;
  private dragged = false;

  private root?: HTMLDivElement;
  private countEl?: HTMLSpanElement;
  private selEl?: HTMLDivElement;
  private listEl?: HTMLDivElement;
  private raycaster = new THREE.Raycaster();

  constructor(private deps: MarkerEditorDeps) {}

  isOpen(): boolean {
    return this.open;
  }

  /** Camera the game should render while editing (null = use the scene's own). */
  overrideCamera(): THREE.Camera | null {
    return this.open ? this.cam : null;
  }

  /** Toggle the editor for the currently-active scene. */
  toggle(): void {
    if (this.open) this.close();
    else this.openEditor();
  }

  private openEditor(): void {
    const active = this.deps.getActive();
    if (!active) {
      this.deps.showToast?.("No scene to edit");
      return;
    }
    this.open = true;
    this.sceneRef = active;
    this.sceneId = active.name;
    this.deps.onOpenChange?.(true);
    // Suspend gameplay input AND the first-person HUD layer — otherwise the FP
    // look/joystick overlay sits over the canvas and swallows the drag-to-look.
    this.wasFp = this.deps.input.fpControlsActive;
    if (this.wasFp) this.deps.input.enableFpControls(false);
    this.deps.input.setEnabled(false);

    // Fly camera starts where the scene camera is looking.
    active.camera.updateMatrixWorld();
    this.cam.position.setFromMatrixPosition(active.camera.matrixWorld);
    const e = new THREE.Euler().setFromQuaternion(active.camera.quaternion, "YXZ");
    this.yaw = e.y;
    this.pitch = e.x;
    this.cam.aspect = this.deps.domElement.clientWidth / Math.max(1, this.deps.domElement.clientHeight);
    this.cam.updateProjectionMatrix();

    // Take ownership of any markers already spawned in the scene: rebuild the
    // live objects from the store so their ids line up with the working copy.
    this.working = MarkerStore.forScene(this.sceneId);
    this.clearLiveMarkers();
    for (const def of this.working) this.spawnLive(def);
    this.selectedId = null;
    this.dirty = false;

    this.buildHud();
    this.attachListeners();
    this.deps.playSfx?.("ui-confirm");
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.detachListeners();
    this.clearSelectionHelper();
    this.root?.remove();
    this.root = undefined;
    this.keys.clear();
    this.deps.input.setEnabled(true);
    if (this.wasFp) this.deps.input.enableFpControls(true);
    this.deps.onOpenChange?.(false);
    this.deps.playSfx?.("ui-select");
    this.sceneRef = null;
  }

  /** Per-frame fly-camera integration (called from the game loop). */
  update(dt: number): void {
    if (!this.open) return;
    // Orientation from yaw/pitch.
    const euler = new THREE.Euler(this.pitch, this.yaw, 0, "YXZ");
    this.cam.quaternion.setFromEuler(euler);
    // WASD + vertical fly relative to facing.
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.cam.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.cam.quaternion);
    const move = new THREE.Vector3();
    if (this.keys.has("w")) move.add(forward);
    if (this.keys.has("s")) move.sub(forward);
    if (this.keys.has("d")) move.add(right);
    if (this.keys.has("a")) move.sub(right);
    if (this.keys.has("e")) move.y += 1;
    if (this.keys.has("q")) move.y -= 1;
    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(MOVE_SPEED * dt * (this.keys.has("shift") ? 2.5 : 1));
      this.cam.position.add(move);
    }
    this.boxHelper?.update();
  }

  resize(w: number, h: number): void {
    this.cam.aspect = w / Math.max(1, h);
    this.cam.updateProjectionMatrix();
  }

  // ── Live scene objects ──────────────────────────────────────────────────────
  private spawnLive(def: MarkerDef): void {
    if (!this.sceneRef) return;
    const obj = buildMarkerObject(def);
    this.sceneRef.scene.add(obj);
    this.objById.set(def.id, obj);
  }

  private clearLiveMarkers(): void {
    if (!this.sceneRef) return;
    const existing: THREE.Object3D[] = [];
    this.sceneRef.scene.traverse((o) => {
      if (o.userData?.marker) existing.push(o);
    });
    for (const o of existing) {
      o.parent?.remove(o);
      disposeObject(o);
    }
    this.objById.clear();
  }

  // ── Placement / selection ────────────────────────────────────────────────────
  private placeAt(point: THREE.Vector3): void {
    const def: MarkerDef = {
      id: MarkerStore.newId(),
      type: this.selectedType,
      name: "",
      x: round(point.x),
      y: round(point.y),
      z: round(point.z),
      rotY: 0,
      scale: 1,
    };
    this.working.push(def);
    this.spawnLive(def);
    this.select(def.id);
    this.markDirty();
  }

  /** Rename the selected marker (the key the game wires behaviour to). */
  private renameSelected(name: string): void {
    const def = this.working.find((m) => m.id === this.selectedId);
    if (!def) return;
    def.name = name.trim();
    this.markDirty();
    this.refreshList();
  }

  /** Set one world-axis of the selected marker from a numeric field, live. */
  private setAxis(axis: "x" | "y" | "z", value: number): void {
    if (!this.selectedId || !Number.isFinite(value)) return;
    const def = this.working.find((m) => m.id === this.selectedId);
    const obj = this.objById.get(this.selectedId);
    if (!def || !obj) return;
    def[axis] = round(value);
    obj.position.set(def.x, def.y, def.z);
    this.boxHelper?.update();
    this.markDirty();
    this.refreshList();
  }

  /** Select a marker AND fly the editor camera to look at it (list-click). */
  private focusMarker(id: string): void {
    this.select(id);
    const def = this.working.find((m) => m.id === id);
    if (!def) return;
    // Sit back-and-up from the marker, looking at it.
    this.cam.position.set(def.x, def.y + 6, def.z + 12);
    this.yaw = 0;
    this.pitch = -0.35;
  }

  private select(id: string | null): void {
    this.selectedId = id;
    this.clearSelectionHelper();
    if (id) {
      const obj = this.objById.get(id);
      if (obj && this.sceneRef) {
        this.boxHelper = new THREE.BoxHelper(obj, 0xffe14a);
        this.sceneRef.scene.add(this.boxHelper);
      }
    }
    this.refreshSelPanel();
    this.refreshList();
  }

  private deleteSelected(): void {
    if (!this.selectedId) return;
    const id = this.selectedId;
    const obj = this.objById.get(id);
    if (obj) {
      obj.parent?.remove(obj);
      disposeObject(obj);
      this.objById.delete(id);
    }
    this.working = this.working.filter((m) => m.id !== id);
    this.select(null);
    this.markDirty();
  }

  private nudgeSelected(kind: "rotL" | "rotR" | "up" | "down"): void {
    if (!this.selectedId) return;
    const def = this.working.find((m) => m.id === this.selectedId);
    const obj = this.objById.get(this.selectedId);
    if (!def || !obj) return;
    if (kind === "rotL" || kind === "rotR") {
      def.rotY = (def.rotY ?? 0) + (kind === "rotL" ? -1 : 1) * (Math.PI / 12);
      obj.rotation.y = def.rotY;
    } else {
      const factor = kind === "up" ? 1.15 : 1 / 1.15;
      def.scale = round((def.scale ?? 1) * factor);
      // Reset then re-apply scale (objects are built at scale 1 * def.scale).
      const base = buildMarkerObject({ ...def, scale: 1 });
      obj.scale.copy(base.scale.multiplyScalar(def.scale));
    }
    this.boxHelper?.update();
    this.markDirty();
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.countEl) this.countEl.textContent = `${this.working.length} marker(s) · unsaved`;
    this.refreshList();
  }

  private saveScene(): void {
    MarkerStore.setScene(this.sceneId, this.working);
    this.dirty = false;
    if (this.countEl) this.countEl.textContent = `${this.working.length} marker(s) · saved`;
    this.deps.showToast?.("Markers saved");
    this.deps.playSfx?.("ui-confirm");
  }

  private async exportScene(): Promise<void> {
    // Persist first so the export reflects the latest edits.
    MarkerStore.setScene(this.sceneId, this.working);
    this.dirty = false;
    const json = MarkerStore.exportJson();
    // Offer both a download and a clipboard copy — whichever the dev prefers to
    // paste into public/editor/markers.json.
    try {
      await navigator.clipboard.writeText(json);
    } catch {
      /* clipboard blocked — the download still works */
    }
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "markers.json";
    a.click();
    URL.revokeObjectURL(url);
    this.deps.showToast?.("Exported markers.json (also copied)");
  }

  // ── Pointer + keyboard ───────────────────────────────────────────────────────
  private prevTouchAction = "";
  private attachListeners(): void {
    const el = this.deps.domElement;
    // The game's InputManager is disabled while editing, so it no longer holds
    // the canvas's touch-action; set it here so a touch drag produces pointermove
    // (look) events instead of being eaten as a browser scroll/zoom gesture.
    this.prevTouchAction = el.style.touchAction;
    el.style.touchAction = "none";
    el.addEventListener("pointerdown", this.onPointerDown);
    el.addEventListener("pointermove", this.onPointerMove);
    el.addEventListener("pointerup", this.onPointerUp);
    el.addEventListener("pointercancel", this.onPointerUp);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
  }

  private detachListeners(): void {
    const el = this.deps.domElement;
    el.style.touchAction = this.prevTouchAction;
    el.removeEventListener("pointerdown", this.onPointerDown);
    el.removeEventListener("pointermove", this.onPointerMove);
    el.removeEventListener("pointerup", this.onPointerUp);
    el.removeEventListener("pointercancel", this.onPointerUp);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (this.pointerId !== null) return;
    this.pointerId = e.pointerId;
    this.deps.domElement.setPointerCapture?.(e.pointerId);
    this.downX = this.lastX = e.clientX;
    this.downY = this.lastY = e.clientY;
    this.dragged = false;
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    if (Math.hypot(e.clientX - this.downX, e.clientY - this.downY) > TAP_SLOP) this.dragged = true;
    if (this.dragged) {
      // Drag = look around.
      this.yaw -= dx * DRAG_LOOK;
      this.pitch -= dy * DRAG_LOOK;
      const lim = Math.PI / 2 - 0.05;
      this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    this.pointerId = null;
    if (this.dragged) return; // was a look-drag, not a placement tap
    this.handleTap(e.clientX, e.clientY);
  };

  private handleTap(clientX: number, clientY: number): void {
    if (!this.sceneRef) return;
    const rect = this.deps.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.cam);
    const hits = this.raycaster.intersectObjects(this.sceneRef.scene.children, true);
    for (const hit of hits) {
      const markerRoot = findMarkerRoot(hit.object);
      if (markerRoot) {
        this.select(markerRoot.userData.markerId as string);
        return;
      }
    }
    // No marker tapped → drop a new one at the first solid hit (or the y=0 plane).
    const ground = hits.find((h) => !findMarkerRoot(h.object));
    if (ground) {
      this.placeAt(ground.point);
    } else {
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      const p = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(plane, p)) this.placeAt(p);
    }
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    const k = e.key.toLowerCase();
    if (k === "escape") {
      this.close();
      return;
    }
    if ((k === "delete" || k === "backspace") && this.selectedId) {
      e.preventDefault();
      this.deleteSelected();
      return;
    }
    if ("wasdqe".includes(k) || k === "shift") this.keys.add(k);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.key.toLowerCase());
  };

  private clearSelectionHelper(): void {
    if (this.boxHelper) {
      this.boxHelper.parent?.remove(this.boxHelper);
      this.boxHelper.geometry.dispose();
      (this.boxHelper.material as THREE.Material).dispose();
      this.boxHelper = undefined;
    }
  }

  // ── HUD ──────────────────────────────────────────────────────────────────────
  private buildHud(): void {
    const el = document.createElement("div");
    el.className = "be-med";
    const palette = MARKER_TYPES.map(
      (t) =>
        `<button class="be-med__type${t.key === this.selectedType ? " on" : ""}" data-type="${t.key}" title="${t.label}"><span>${t.icon}</span>${t.label}</button>`,
    ).join("");
    el.innerHTML = `
      <div class="be-med__bar">
        <span class="be-med__title">MARKER EDITOR</span>
        <span class="be-med__scene">${this.sceneId}</span>
        <span class="be-med__count"></span>
        <button class="be-med__x" data-act="close">Exit ✕</button>
      </div>
      <div class="be-med__palette">${palette}</div>
      <div class="be-med__move">
        <button data-move="e">▲ up</button>
        <button data-move="w">▲</button>
        <button data-move="q">▼ dn</button>
        <button data-move="a">◀</button>
        <button data-move="s">▼</button>
        <button data-move="d">▶</button>
      </div>
      <div class="be-med__sel"></div>
      <div class="be-med__list"></div>
      <div class="be-med__actions">
        <button data-act="save">Save</button>
        <button data-act="export">Export JSON</button>
        <button data-act="revert">Revert</button>
      </div>
      <div class="be-med__hint">Drag to look · WASD/Q/E to fly · tap ground to place · tap a marker or list row to select · name markers to wire them</div>
      <datalist id="be-med-names">${SUGGESTED_NAMES.map((n) => `<option value="${n}"></option>`).join("")}</datalist>`;
    this.deps.uiLayer.appendChild(el);
    this.root = el;
    this.countEl = el.querySelector<HTMLSpanElement>(".be-med__count") ?? undefined;
    this.selEl = el.querySelector<HTMLDivElement>(".be-med__sel") ?? undefined;
    this.listEl = el.querySelector<HTMLDivElement>(".be-med__list") ?? undefined;
    if (this.countEl) this.countEl.textContent = `${this.working.length} marker(s)`;

    el.querySelectorAll<HTMLButtonElement>(".be-med__type").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.selectedType = btn.dataset.type!;
        el.querySelectorAll(".be-med__type").forEach((b) => b.classList.remove("on"));
        btn.classList.add("on");
      });
    });

    // Fly move buttons — hold to move (touch-friendly).
    el.querySelectorAll<HTMLButtonElement>("[data-move]").forEach((btn) => {
      const key = btn.dataset.move!;
      const down = (ev: Event) => {
        ev.preventDefault();
        this.keys.add(key);
      };
      const up = () => this.keys.delete(key);
      btn.addEventListener("pointerdown", down);
      btn.addEventListener("pointerup", up);
      btn.addEventListener("pointerleave", up);
      btn.addEventListener("pointercancel", up);
    });

    el.querySelector('[data-act="close"]')?.addEventListener("click", () => this.close());
    el.querySelector('[data-act="save"]')?.addEventListener("click", () => this.saveScene());
    el.querySelector('[data-act="export"]')?.addEventListener("click", () => void this.exportScene());
    el.querySelector('[data-act="revert"]')?.addEventListener("click", () => this.revert());
    this.refreshSelPanel();
    this.refreshList();
  }

  /** The browsable list of all placed markers: name/type + coords, sorted by
   *  name (named first). Click a row to select + fly to it; ✕ removes it. */
  private refreshList(): void {
    if (!this.listEl) return;
    const rows = [...this.working].sort((a, b) => {
      const an = a.name || "";
      const bn = b.name || "";
      if (an && !bn) return -1;
      if (!an && bn) return 1;
      return an.localeCompare(bn) || a.id.localeCompare(b.id);
    });
    if (!rows.length) {
      this.listEl.innerHTML = `<span class="be-med__selnone">No markers yet — tap the ground to place one</span>`;
      return;
    }
    this.listEl.innerHTML = rows
      .map((m) => {
        const nm = m.name ? escapeHtml(m.name) : `<i>(${markerLabel(m.type)})</i>`;
        const sel = m.id === this.selectedId ? " on" : "";
        return `<div class="be-med__row${sel}" data-id="${m.id}">
          <span class="be-med__rowname">${nm}</span>
          <span class="be-med__rowxyz">${m.x.toFixed(0)}, ${m.y.toFixed(0)}, ${m.z.toFixed(0)}</span>
          <button class="be-med__rowdel" data-del="${m.id}" title="Remove">✕</button>
        </div>`;
      })
      .join("");
    this.listEl.querySelectorAll<HTMLElement>(".be-med__row").forEach((row) => {
      row.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).dataset.del) return; // handled below
        this.focusMarker(row.dataset.id!);
      });
    });
    this.listEl.querySelectorAll<HTMLButtonElement>(".be-med__rowdel").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.select(btn.dataset.del!);
        this.deleteSelected();
      });
    });
  }

  private refreshSelPanel(): void {
    if (!this.selEl) return;
    if (!this.selectedId) {
      this.selEl.innerHTML = `<span class="be-med__selnone">No marker selected</span>`;
      return;
    }
    const def = this.working.find((m) => m.id === this.selectedId);
    if (!def) return;
    this.selEl.innerHTML = `
      <div class="be-med__selrow">
        <span class="be-med__selname">${markerLabel(def.type)}</span>
        <input class="be-med__name" list="be-med-names" placeholder="name (e.g. sarah_body)"
               value="${escapeHtml(def.name ?? "")}" spellcheck="false" autocapitalize="off" />
      </div>
      <div class="be-med__xyz">
        <label>X<input type="number" step="0.5" data-axis="x" value="${def.x}" /></label>
        <label>Y<input type="number" step="0.5" data-axis="y" value="${def.y}" /></label>
        <label>Z<input type="number" step="0.5" data-axis="z" value="${def.z}" /></label>
      </div>
      <div class="be-med__selbtns">
        <button data-sel="rotL" title="Rotate">⟲</button>
        <button data-sel="rotR" title="Rotate">⟳</button>
        <button data-sel="up" title="Scale up">＋</button>
        <button data-sel="down" title="Scale down">－</button>
        <button data-sel="del" class="be-med__del">Delete</button>
      </div>`;
    const nameInput = this.selEl.querySelector<HTMLInputElement>(".be-med__name");
    nameInput?.addEventListener("change", () => this.renameSelected(nameInput.value));
    this.selEl.querySelectorAll<HTMLInputElement>("[data-axis]").forEach((inp) => {
      inp.addEventListener("change", () =>
        this.setAxis(inp.dataset.axis as "x" | "y" | "z", parseFloat(inp.value)),
      );
    });
    this.selEl.querySelector('[data-sel="rotL"]')?.addEventListener("click", () => this.nudgeSelected("rotL"));
    this.selEl.querySelector('[data-sel="rotR"]')?.addEventListener("click", () => this.nudgeSelected("rotR"));
    this.selEl.querySelector('[data-sel="up"]')?.addEventListener("click", () => this.nudgeSelected("up"));
    this.selEl.querySelector('[data-sel="down"]')?.addEventListener("click", () => this.nudgeSelected("down"));
    this.selEl.querySelector('[data-sel="del"]')?.addEventListener("click", () => this.deleteSelected());
  }

  private revert(): void {
    MarkerStore.revertScene(this.sceneId);
    this.working = MarkerStore.forScene(this.sceneId);
    this.clearLiveMarkers();
    for (const def of this.working) this.spawnLive(def);
    this.select(null);
    this.dirty = false;
    if (this.countEl) this.countEl.textContent = `${this.working.length} marker(s) · reverted`;
    this.deps.showToast?.("Reverted to saved layout");
  }
}

// ── helpers ────────────────────────────────────────────────────────────────────
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Walk up from a hit object to the tagged marker root, or null if not a marker. */
function findMarkerRoot(o: THREE.Object3D | null): THREE.Object3D | null {
  let cur: THREE.Object3D | null = o;
  while (cur) {
    if (cur.userData?.marker) return cur;
    cur = cur.parent;
  }
  return null;
}

function disposeObject(o: THREE.Object3D): void {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
  });
}

/**
 * Recall a scene's saved markers into a freshly-built scene (called on scene
 * enter). Returns the created objects so the scene can dispose them itself. The
 * store must be loaded first (MarkerStore.load()).
 */
export function spawnSceneMarkers(sceneId: string, parent: THREE.Scene): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  for (const def of MarkerStore.forScene(sceneId)) {
    const obj = buildMarkerObject(def);
    parent.add(obj);
    out.push(obj);
  }
  return out;
}
