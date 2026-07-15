import * as THREE from "three";
import { TerrainEdit, CELL_U } from "./TerrainEdit";
import { beachHeight, refreshTerrainPatch, METERS_PER_UNIT } from "./beachTerrain";
import type { EditorSceneRef, MarkerEditorDeps } from "./MarkerEditor";

/**
 * In-game Terrain Editor — RCT/Planet-Coaster-style sculpt brushes over the fine
 * patch (see beachTerrain.buildTerrainPatch). Reached through the same PIN gate
 * as the Marker Editor; drives its OWN fly camera while open. Drag over the
 * ground to sculpt: raise / lower / smooth / flatten. Edits write the 1 m
 * TerrainEdit layer (which beachHeight reads), so the change flows to walking,
 * water and trees at once; the patch re-displaces live so you see it as you go.
 */

type Tool = "raise" | "lower" | "smooth" | "flatten";
const MOVE_SPEED = 60; // fly units/sec

export class TerrainEditor {
  private open = false;
  private sceneRef: EditorSceneRef | null = null;
  private cam = new THREE.PerspectiveCamera(70, 1, 0.1, 60000);
  private wasFp = false;

  // fly camera
  private yaw = 0;
  private pitch = 0;
  private readonly keys = new Set<string>();

  // pointer
  private pointerId: number | null = null;
  private lastX = 0;
  private lastY = 0;
  private dragged = false;
  private looking = false; // right-drag / two-finger = look, else = sculpt
  private painting = false;
  private flattenTarget = 0;
  private normalsDirty = false;
  private lastNormalRefresh = 0;

  // tool state
  private tool: Tool = "raise";
  private brushM = 10; // brush radius, metres
  private strengthM = 0.6; // per-stroke strength, metres

  private raycaster = new THREE.Raycaster();
  private root?: HTMLDivElement;
  private countEl?: HTMLSpanElement;

  constructor(private deps: MarkerEditorDeps) {}

  toggle(): void {
    if (this.open) this.close();
    else this.openEditor();
  }

  isOpen(): boolean {
    return this.open;
  }

  overrideCamera(): THREE.Camera | null {
    return this.open ? this.cam : null;
  }

  private openEditor(): void {
    const active = this.deps.getActive();
    if (!active) {
      this.deps.showToast?.("No scene to edit");
      return;
    }
    // Terrain sculpting only makes sense on the island (it has the patch).
    if (active.name !== "island") {
      this.deps.showToast?.("Terrain editor is island-only");
      return;
    }
    this.open = true;
    this.sceneRef = active;
    this.deps.onOpenChange?.(true);
    this.wasFp = this.deps.input.fpControlsActive;
    if (this.wasFp) this.deps.input.enableFpControls(false);
    this.deps.input.setEnabled(false);

    active.camera.updateMatrixWorld();
    this.cam.position.setFromMatrixPosition(active.camera.matrixWorld);
    const e = new THREE.Euler().setFromQuaternion(active.camera.quaternion, "YXZ");
    this.yaw = e.y;
    this.pitch = e.x;
    this.cam.aspect =
      this.deps.domElement.clientWidth / Math.max(1, this.deps.domElement.clientHeight);
    this.cam.updateProjectionMatrix();

    TerrainEdit.load();
    this.buildHud();
    this.attachListeners();
    this.deps.playSfx?.("ui-confirm");
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.detachListeners();
    // Final clean normals pass so lighting is correct after the last stroke.
    if (this.normalsDirty) {
      refreshTerrainPatch(undefined, true);
      this.normalsDirty = false;
    }
    this.root?.remove();
    this.root = undefined;
    this.keys.clear();
    this.deps.input.setEnabled(true);
    if (this.wasFp) this.deps.input.enableFpControls(true);
    this.deps.onOpenChange?.(false);
    this.deps.playSfx?.("ui-select");
    this.sceneRef = null;
  }

  resize(w: number, h: number): void {
    this.cam.aspect = w / Math.max(1, h);
    this.cam.updateProjectionMatrix();
  }

  update(dt: number): void {
    if (!this.open) return;
    const euler = new THREE.Euler(this.pitch, this.yaw, 0, "YXZ");
    this.cam.quaternion.setFromEuler(euler);
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
      move.normalize().multiplyScalar(MOVE_SPEED * dt * (this.keys.has("shift") ? 3 : 1));
      this.cam.position.add(move);
    }
    // Throttled normals during a drag so lighting keeps up without per-move cost.
    if (this.painting && this.normalsDirty) {
      this.lastNormalRefresh += dt;
      if (this.lastNormalRefresh > 0.1) {
        this.lastNormalRefresh = 0;
        refreshTerrainPatch(undefined, true);
        this.normalsDirty = false;
      }
    }
  }

  // ── sculpting ────────────────────────────────────────────────────────────────
  private raycastGround(clientX: number, clientY: number): THREE.Vector3 | null {
    if (!this.sceneRef) return null;
    const rect = this.deps.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.cam);
    const hits = this.raycaster.intersectObjects(this.sceneRef.scene.children, true);
    for (const h of hits) {
      const n = h.object.name;
      if (n === "terrain-patch" || n === "beach-terrain") return h.point.clone();
    }
    return hits[0]?.point.clone() ?? null;
  }

  private applyBrush(point: THREE.Vector3): void {
    const rU = this.brushM / METERS_PER_UNIT;
    const stepU = (this.strengthM * 0.14) / METERS_PER_UNIT; // per pointer-move
    const centre = TerrainEdit.cellOf(point.x, point.z);
    const cells = Math.ceil(rU / CELL_U) + 1;
    for (let di = -cells; di <= cells; di++) {
      for (let dj = -cells; dj <= cells; dj++) {
        const i = centre.i + di;
        const j = centre.j + dj;
        const cc = TerrainEdit.cellCentre(i, j);
        const d = Math.hypot(cc.x - point.x, cc.z - point.z);
        if (d > rU) continue;
        const t = 1 - d / rU;
        const w = t * t * (3 - 2 * t); // smooth falloff, 1 at centre → 0 at rim
        const cur = TerrainEdit.getCell(i, j);
        if (this.tool === "raise") {
          TerrainEdit.setCell(i, j, cur + stepU * w);
        } else if (this.tool === "lower") {
          TerrainEdit.setCell(i, j, cur - stepU * w);
        } else if (this.tool === "smooth") {
          const here = beachHeight(cc.x, cc.z);
          const avg =
            (beachHeight(cc.x + CELL_U, cc.z) +
              beachHeight(cc.x - CELL_U, cc.z) +
              beachHeight(cc.x, cc.z + CELL_U) +
              beachHeight(cc.x, cc.z - CELL_U)) /
            4;
          TerrainEdit.setCell(i, j, cur + (avg - here) * w * 0.5);
        } else {
          // flatten toward the height under the cursor when the stroke began
          const here = beachHeight(cc.x, cc.z);
          TerrainEdit.setCell(i, j, cur + (this.flattenTarget - here) * w * 0.5);
        }
      }
    }
    refreshTerrainPatch(
      { minX: point.x - rU, minZ: point.z - rU, maxX: point.x + rU, maxZ: point.z + rU },
      false,
    );
    this.normalsDirty = true;
    if (this.countEl) this.countEl.textContent = `${TerrainEdit.cellCount} cell(s) · unsaved`;
  }

  // ── listeners ────────────────────────────────────────────────────────────────
  private prevTouchAction = "";
  private attachListeners(): void {
    const el = this.deps.domElement;
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
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.dragged = false;
    // Right button / ctrl = look-around; primary = sculpt.
    this.looking = e.button === 2 || e.ctrlKey;
    if (!this.looking) {
      const p = this.raycastGround(e.clientX, e.clientY);
      if (p) {
        this.flattenTarget = beachHeight(p.x, p.z);
        this.painting = true;
        this.applyBrush(p);
      }
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    if (Math.abs(dx) + Math.abs(dy) > 2) this.dragged = true;
    if (this.looking) {
      this.yaw -= dx * 0.0035;
      this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch - dy * 0.0035));
    } else if (this.painting) {
      const p = this.raycastGround(e.clientX, e.clientY);
      if (p) this.applyBrush(p);
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    this.pointerId = null;
    if (this.painting) {
      this.painting = false;
      refreshTerrainPatch(undefined, true); // clean normals at stroke end
      this.normalsDirty = false;
    }
    this.looking = false;
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    const k = e.key.toLowerCase();
    if (k === "escape") {
      this.close();
      return;
    }
    if ("wasdqe".includes(k) || k === "shift") this.keys.add(k);
  };
  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.key.toLowerCase());
  };

  // ── HUD ──────────────────────────────────────────────────────────────────────
  private buildHud(): void {
    const el = document.createElement("div");
    el.className = "be-ted";
    const tools: [Tool, string][] = [
      ["raise", "▲ Raise"],
      ["lower", "▼ Lower"],
      ["smooth", "◠ Smooth"],
      ["flatten", "▬ Flatten"],
    ];
    el.innerHTML = `
      <div class="be-ted__bar">
        <span class="be-ted__title">TERRAIN EDITOR</span>
        <span class="be-ted__count"></span>
        <button class="be-ted__x" data-act="close">Exit ✕</button>
      </div>
      <div class="be-ted__tools">
        ${tools
          .map(
            ([t, label]) =>
              `<button class="be-ted__tool${t === this.tool ? " on" : ""}" data-tool="${t}">${label}</button>`,
          )
          .join("")}
      </div>
      <div class="be-ted__sliders">
        <label>Brush <b data-out="brush">${this.brushM} m</b><input type="range" data-slider="brush" min="2" max="60" step="1" value="${this.brushM}" /></label>
        <label>Strength <b data-out="str">${this.strengthM.toFixed(1)} m</b><input type="range" data-slider="str" min="0.1" max="3" step="0.1" value="${this.strengthM}" /></label>
      </div>
      <div class="be-ted__move">
        <button data-move="e">▲up</button><button data-move="w">▲</button><button data-move="q">▼dn</button>
        <button data-move="a">◀</button><button data-move="s">▼</button><button data-move="d">▶</button>
      </div>
      <div class="be-ted__actions">
        <button data-act="save">Save</button>
        <button data-act="export">Export JSON</button>
        <button data-act="revert">Revert All</button>
      </div>
      <div class="be-ted__hint">Drag to sculpt · right-drag (or ctrl-drag) to look · WASD/Q/E to fly</div>`;
    this.deps.uiLayer.appendChild(el);
    this.root = el;
    this.countEl = el.querySelector<HTMLSpanElement>(".be-ted__count") ?? undefined;
    if (this.countEl) this.countEl.textContent = `${TerrainEdit.cellCount} cell(s)`;

    el.querySelectorAll<HTMLButtonElement>(".be-ted__tool").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.tool = btn.dataset.tool as Tool;
        el.querySelectorAll(".be-ted__tool").forEach((b) => b.classList.remove("on"));
        btn.classList.add("on");
      });
    });
    const brushOut = el.querySelector<HTMLElement>('[data-out="brush"]');
    const strOut = el.querySelector<HTMLElement>('[data-out="str"]');
    el.querySelector<HTMLInputElement>('[data-slider="brush"]')?.addEventListener("input", (ev) => {
      this.brushM = parseFloat((ev.target as HTMLInputElement).value);
      if (brushOut) brushOut.textContent = `${this.brushM} m`;
    });
    el.querySelector<HTMLInputElement>('[data-slider="str"]')?.addEventListener("input", (ev) => {
      this.strengthM = parseFloat((ev.target as HTMLInputElement).value);
      if (strOut) strOut.textContent = `${this.strengthM.toFixed(1)} m`;
    });

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
    el.querySelector('[data-act="save"]')?.addEventListener("click", () => {
      TerrainEdit.save();
      if (this.countEl) this.countEl.textContent = `${TerrainEdit.cellCount} cell(s) · saved`;
      this.deps.showToast?.("Terrain saved");
    });
    el.querySelector('[data-act="export"]')?.addEventListener("click", () => {
      const json = TerrainEdit.serialize();
      void navigator.clipboard?.writeText(json).catch(() => {});
      this.deps.showToast?.(`Copied ${TerrainEdit.cellCount} cells to clipboard`);
    });
    el.querySelector('[data-act="revert"]')?.addEventListener("click", () => {
      TerrainEdit.clear();
      refreshTerrainPatch(undefined, true);
      if (this.countEl) this.countEl.textContent = `0 cell(s) · reverted`;
      this.deps.showToast?.("Terrain reverted");
    });
  }
}
