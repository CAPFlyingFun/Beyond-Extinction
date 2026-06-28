import type { Marker, MarkerKind, ObjectShape, WallChain } from "../state/types";
import { UNIT_LABEL, UNITS, fmtLen, fmtXZ, isUnit, type Unit } from "../util/units";
import { getApiToken, setApiToken } from "../persistence/levelsApi";

export interface EditorSettings {
  mode: MarkerKind;
  tag: string;
  objectShape: ObjectShape;
  objectSize: number;
  wallHeight: number;
  wallThickness: number;
  snapEnabled: boolean;
  snapRadius: number;
  gridEnabled: boolean;
  gridSize: number;
  units: Unit;
  levelName: string;
}

// Grid snap increments (meters). Matches the game's metric coordinate space.
const GRID_SIZES = [0.05, 0.1, 0.25, 0.5, 0.75, 1.0];

export interface FloorPlanControls {
  widthMeters: number;
  offsetX: number;
  offsetZ: number;
  rotationDeg: number;
  opacity: number;
  visible: boolean;
}

export interface HudCallbacks {
  onDrop(): void;
  onUndo(): void;
  onFinishWall(): void;
  onCloseWall(): void;
  onClearAll(): void;
  onSave(): void;
  onLoad(name: string): void;
  onDownload(): void;
  onDeleteMarker(id: string): void;
  onSettingsChange(): void;
  onFloorPlanFile(file: File): void;
  onFloorPlanChange(): void;
}

function q<T extends HTMLElement>(root: ParentNode, sel: string): T {
  const el = root.querySelector(sel);
  if (!el) throw new Error(`HUD element not found: ${sel}`);
  return el as T;
}

const NAME_RE = /^[a-z0-9][a-z0-9-_]{0,63}$/i;

export class Hud {
  readonly settings: EditorSettings = {
    mode: "object",
    tag: "",
    objectShape: "square",
    objectSize: 1,
    wallHeight: 3,
    wallThickness: 0.2,
    snapEnabled: true,
    snapRadius: 1.0,
    gridEnabled: true,
    gridSize: 1,
    units: "m",
    levelName: "prologue-room",
  };

  readonly floorPlan: FloorPlanControls = {
    widthMeters: 20,
    offsetX: 0,
    offsetZ: 0,
    rotationDeg: 0,
    opacity: 0.6,
    visible: true,
  };

  private panel: HTMLDivElement;
  private statusEl: HTMLDivElement;
  private coordsEl: HTMLDivElement;
  private listEl: HTMLDivElement;
  private loadSelect: HTMLSelectElement;
  private wallInfoEl: HTMLDivElement;
  private lastMarkers: Marker[] = [];

  constructor(host: HTMLElement, private cb: HudCallbacks) {
    // Crosshair
    const crosshair = document.createElement("div");
    crosshair.className = "crosshair";
    crosshair.innerHTML = `<span></span><span></span>`;
    host.appendChild(crosshair);

    // Coords readout
    this.coordsEl = document.createElement("div");
    this.coordsEl.className = "coords-readout";
    this.coordsEl.textContent = "x — , z —";
    host.appendChild(this.coordsEl);

    // Drop button
    const drop = document.createElement("button");
    drop.className = "drop-btn";
    drop.type = "button";
    drop.textContent = "DROP";
    drop.addEventListener("click", () => this.cb.onDrop());
    host.appendChild(drop);

    // Panel
    this.panel = document.createElement("div");
    this.panel.className = "hud-panel";
    this.panel.innerHTML = this.template();
    host.appendChild(this.panel);

    this.statusEl = q(this.panel, ".js-status");
    this.listEl = q(this.panel, ".js-list");
    this.loadSelect = q(this.panel, ".js-load-select");
    this.wallInfoEl = q(this.panel, ".js-wall-info");

    this.wire();
    this.refreshModeUI();
  }

  private template(): string {
    return `
    <div class="hp-head">
      <div class="hp-title">Level Editor</div>
      <button type="button" class="hp-collapse js-collapse" title="Collapse">–</button>
    </div>
    <div class="hp-body js-body">
      <div class="hp-section">
        <label class="hp-label">Level name</label>
        <div class="hp-row">
          <input class="hp-input js-name" type="text" value="prologue-room" spellcheck="false" />
        </div>
        <div class="hp-row">
          <button type="button" class="hp-btn js-save">Save</button>
          <button type="button" class="hp-btn js-download">Download</button>
        </div>
        <div class="hp-row">
          <select class="hp-input js-load-select"><option value="">— saved levels —</option></select>
          <button type="button" class="hp-btn js-load">Load</button>
        </div>
      </div>

      <div class="hp-section">
        <label class="hp-label">Mode</label>
        <div class="hp-modes">
          <button type="button" class="mode-btn js-mode" data-mode="object">Object</button>
          <button type="button" class="mode-btn js-mode" data-mode="spawn">Spawn</button>
          <button type="button" class="mode-btn js-mode" data-mode="wall">Wall</button>
        </div>
        <div class="hp-row">
          <input class="hp-input js-tag" type="text" placeholder="tag (e.g. NW Corner)" spellcheck="false" />
        </div>
      </div>

      <div class="hp-section">
        <label class="hp-label">Grid &amp; units</label>
        <div class="hp-row">
          <label class="hp-check"><input type="checkbox" class="js-grid" checked /> snap to grid</label>
          <label class="hp-mini">size(m)
            <select class="hp-input js-grid-s">
              ${GRID_SIZES.map(
                (g) =>
                  `<option value="${g}"${g === 1 ? " selected" : ""}>${g.toFixed(2)}</option>`,
              ).join("")}
            </select>
          </label>
        </div>
        <div class="hp-row">
          <label class="hp-mini">display units
            <select class="hp-input js-units">
              ${UNITS.map(
                (u) =>
                  `<option value="${u}"${u === "m" ? " selected" : ""}>${UNIT_LABEL[u]}</option>`,
              ).join("")}
            </select>
          </label>
        </div>
        <div class="hp-hint">Grid snap applies to every marker. Files always save in meters.</div>
      </div>

      <div class="hp-section js-object-ctrls">
        <label class="hp-label">Object</label>
        <div class="hp-row">
          <select class="hp-input js-shape">
            <option value="square">Square</option>
            <option value="circle">Circle</option>
          </select>
          <label class="hp-mini">size<input class="hp-num js-size" type="number" min="0.1" step="0.1" value="1" /></label>
        </div>
      </div>

      <div class="hp-section js-wall-ctrls">
        <label class="hp-label">Wall</label>
        <div class="hp-row">
          <label class="hp-mini">height<input class="hp-num js-wall-h" type="number" min="0.1" step="0.1" value="3" /></label>
          <label class="hp-mini">thick<input class="hp-num js-wall-t" type="number" min="0.02" step="0.02" value="0.2" /></label>
        </div>
        <div class="hp-row">
          <label class="hp-check"><input type="checkbox" class="js-snap" checked /> snap to endpoints</label>
          <label class="hp-mini">radius<input class="hp-num js-snap-r" type="number" min="0.1" step="0.1" value="1" /></label>
        </div>
        <div class="hp-row">
          <button type="button" class="hp-btn js-finish">Finish</button>
          <button type="button" class="hp-btn js-close">Close loop</button>
        </div>
        <div class="js-wall-info hp-hint"></div>
      </div>

      <div class="hp-section js-spawn-ctrls">
        <div class="hp-hint">Spawn faces the direction you're looking when dropped.</div>
      </div>

      <details class="hp-section hp-details">
        <summary>Floor plan image</summary>
        <div class="hp-row">
          <input type="file" accept="image/*" class="hp-file js-file" />
        </div>
        <div class="hp-row"><label class="hp-mini">width(m)<input class="hp-num js-fp-w" type="number" min="1" step="0.5" value="20" /></label></div>
        <div class="hp-row">
          <label class="hp-mini">off X<input class="hp-num js-fp-x" type="number" step="0.5" value="0" /></label>
          <label class="hp-mini">off Z<input class="hp-num js-fp-z" type="number" step="0.5" value="0" /></label>
        </div>
        <div class="hp-row">
          <label class="hp-mini">rot°<input class="hp-num js-fp-r" type="number" step="1" value="0" /></label>
          <label class="hp-mini">opacity<input class="hp-num js-fp-o" type="number" min="0" max="1" step="0.05" value="0.6" /></label>
        </div>
        <div class="hp-row"><label class="hp-check"><input type="checkbox" class="js-fp-vis" checked /> show image</label></div>
      </details>

      <details class="hp-section hp-details">
        <summary>API write token</summary>
        <div class="hp-row">
          <input class="hp-input js-token" type="password" placeholder="only if server sets LEVELS_API_TOKEN" spellcheck="false" autocomplete="off" />
        </div>
        <div class="hp-hint">Sent with Save so a protected server accepts the GitHub push. Stored only in this browser.</div>
      </details>

      <div class="hp-section">
        <div class="hp-row">
          <button type="button" class="hp-btn js-undo">Undo</button>
          <button type="button" class="hp-btn hp-btn--danger js-clear">Clear all</button>
        </div>
      </div>

      <div class="hp-section">
        <label class="hp-label">Markers <span class="js-count">(0)</span></label>
        <div class="marker-list js-list"></div>
      </div>

      <div class="hp-status js-status">Ready.</div>
      <div class="hp-help">Left half = move • Right half = look • WASD + drag on desktop • Space = drop</div>
    </div>`;
  }

  private wire(): void {
    const p = this.panel;
    const s = this.settings;

    q(p, ".js-collapse").addEventListener("click", () => {
      this.panel.classList.toggle("collapsed");
    });

    // Mode buttons
    p.querySelectorAll<HTMLButtonElement>(".js-mode").forEach((btn) => {
      btn.addEventListener("click", () => {
        s.mode = btn.dataset.mode as MarkerKind;
        this.refreshModeUI();
        this.cb.onSettingsChange();
      });
    });

    const name = q<HTMLInputElement>(p, ".js-name");
    name.addEventListener("input", () => {
      s.levelName = name.value.trim();
    });

    const tag = q<HTMLInputElement>(p, ".js-tag");
    tag.addEventListener("input", () => {
      s.tag = tag.value;
    });

    const shape = q<HTMLSelectElement>(p, ".js-shape");
    shape.addEventListener("change", () => {
      s.objectShape = shape.value as ObjectShape;
    });
    this.bindNum(".js-size", (v) => (s.objectSize = v));
    this.bindNum(".js-wall-h", (v) => (s.wallHeight = v));
    this.bindNum(".js-wall-t", (v) => (s.wallThickness = v));
    this.bindNum(".js-snap-r", (v) => (s.snapRadius = v));

    const gridSel = q<HTMLSelectElement>(p, ".js-grid-s");
    gridSel.addEventListener("change", () => {
      const v = parseFloat(gridSel.value);
      if (!Number.isNaN(v)) s.gridSize = v;
    });

    const unitSel = q<HTMLSelectElement>(p, ".js-units");
    unitSel.addEventListener("change", () => {
      if (isUnit(unitSel.value)) {
        s.units = unitSel.value;
        this.setMarkers(this.lastMarkers); // re-render list meta in the new unit
      }
    });

    q<HTMLInputElement>(p, ".js-snap").addEventListener("change", (e) => {
      s.snapEnabled = (e.target as HTMLInputElement).checked;
    });
    q<HTMLInputElement>(p, ".js-grid").addEventListener("change", (e) => {
      s.gridEnabled = (e.target as HTMLInputElement).checked;
    });

    const token = q<HTMLInputElement>(p, ".js-token");
    token.value = getApiToken();
    token.addEventListener("change", () => setApiToken(token.value));

    q(p, ".js-save").addEventListener("click", () => this.cb.onSave());
    q(p, ".js-download").addEventListener("click", () => this.cb.onDownload());
    q(p, ".js-load").addEventListener("click", () => {
      const v = this.loadSelect.value;
      if (v) this.cb.onLoad(v);
    });
    q(p, ".js-undo").addEventListener("click", () => this.cb.onUndo());
    q(p, ".js-clear").addEventListener("click", () => {
      if (confirm("Clear all markers? This can be undone once.")) {
        this.cb.onClearAll();
      }
    });
    q(p, ".js-finish").addEventListener("click", () => this.cb.onFinishWall());
    q(p, ".js-close").addEventListener("click", () => this.cb.onCloseWall());

    // Floor plan
    q<HTMLInputElement>(p, ".js-file").addEventListener("change", (e) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (f) this.cb.onFloorPlanFile(f);
    });
    const fp = this.floorPlan;
    this.bindNum(".js-fp-w", (v) => ((fp.widthMeters = v), this.cb.onFloorPlanChange()));
    this.bindNum(".js-fp-x", (v) => ((fp.offsetX = v), this.cb.onFloorPlanChange()));
    this.bindNum(".js-fp-z", (v) => ((fp.offsetZ = v), this.cb.onFloorPlanChange()));
    this.bindNum(".js-fp-r", (v) => ((fp.rotationDeg = v), this.cb.onFloorPlanChange()));
    this.bindNum(".js-fp-o", (v) => ((fp.opacity = v), this.cb.onFloorPlanChange()));
    q<HTMLInputElement>(p, ".js-fp-vis").addEventListener("change", (e) => {
      fp.visible = (e.target as HTMLInputElement).checked;
      this.cb.onFloorPlanChange();
    });
  }

  private bindNum(sel: string, set: (v: number) => void): void {
    const el = q<HTMLInputElement>(this.panel, sel);
    el.addEventListener("input", () => {
      const v = parseFloat(el.value);
      if (!Number.isNaN(v)) set(v);
    });
  }

  private refreshModeUI(): void {
    const p = this.panel;
    p.querySelectorAll<HTMLButtonElement>(".js-mode").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.mode === this.settings.mode);
    });
    q(p, ".js-object-ctrls").style.display =
      this.settings.mode === "object" ? "" : "none";
    q(p, ".js-wall-ctrls").style.display =
      this.settings.mode === "wall" ? "" : "none";
    q(p, ".js-spawn-ctrls").style.display =
      this.settings.mode === "spawn" ? "" : "none";
  }

  validName(): boolean {
    return NAME_RE.test(this.settings.levelName);
  }

  setStatus(msg: string, kind: "info" | "error" | "ok" = "info"): void {
    this.statusEl.textContent = msg;
    this.statusEl.dataset.kind = kind;
  }

  setCoords(point: { x: number; z: number } | null): void {
    this.coordsEl.textContent = point
      ? fmtXZ(point.x, point.z, this.settings.units)
      : "aim at ground";
  }

  setLevelList(names: string[]): void {
    const cur = this.loadSelect.value;
    this.loadSelect.innerHTML =
      `<option value="">— saved levels —</option>` +
      names.map((n) => `<option value="${n}">${n}</option>`).join("");
    if (names.includes(cur)) this.loadSelect.value = cur;
  }

  setActiveWall(active: WallChain | null): void {
    if (active) {
      this.wallInfoEl.textContent = `Active wall: ${active.points.length} point(s). Drop near start to close, or Finish.`;
    } else {
      this.wallInfoEl.textContent = "";
    }
  }

  setMarkers(markers: Marker[]): void {
    this.lastMarkers = markers;
    q(this.panel, ".js-count").textContent = `(${markers.length})`;
    this.listEl.innerHTML = "";
    if (markers.length === 0) {
      this.listEl.innerHTML = `<div class="marker-empty">No markers yet.</div>`;
      return;
    }
    for (const m of markers) {
      const row = document.createElement("div");
      row.className = "marker-row";
      row.innerHTML = `
        <span class="dot dot--${m.kind}"></span>
        <span class="m-kind">${m.kind}</span>
        <span class="m-tag">${escapeHtml(m.tag || "(untagged)")}</span>
        <span class="m-meta">${markerMeta(m, this.settings.units)}</span>
        <button type="button" class="m-del" title="Delete">✕</button>`;
      row.querySelector(".m-del")!.addEventListener("click", () => {
        this.cb.onDeleteMarker(m.id);
      });
      this.listEl.appendChild(row);
    }
  }
}

function markerMeta(m: Marker, unit: Unit): string {
  if (m.kind === "wall") {
    return `${m.points.length}pt${m.closed ? " ⟳" : ""}`;
  }
  return `${fmtLen(m.x, unit)},${fmtLen(m.z, unit)}${unit}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
