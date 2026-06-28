import * as THREE from "three";
import { Renderer } from "./Renderer";
import { EditorScene } from "./Scene";
import { CameraController } from "./CameraController";
import { GroundCursor } from "./GroundCursor";
import { InputController } from "./InputController";
import { FloorPlanOverlay } from "../floorplan/FloorPlanOverlay";
import { EditorStore } from "../state/EditorStore";
import { Hud } from "../hud/Hud";
import { snapToGrid, snapWallPoint } from "../markers/snapping";
import { fmtLen, type Unit } from "../util/units";
import {
  buildActiveWallPreview,
  buildObject,
  buildSpawn,
  buildWall,
  disposeGroup,
} from "../markers/renderers";
import { listLevels, loadLevel, saveLevel, downloadLevel } from "../persistence/levelsApi";
import type { Vec2 } from "../state/types";

const CURSOR_COLORS: Record<string, number> = {
  object: 0x9b8cff,
  spawn: 0x4dd6a0,
  wall: 0xffc24d,
};

export class EditorApp {
  private renderer: Renderer;
  private scene: EditorScene;
  private cam: CameraController;
  private cursor: GroundCursor;
  private input: InputController;
  private floorPlan: FloorPlanOverlay;
  private store: EditorStore;
  private hud: Hud;

  private markersGroup = new THREE.Group();
  private activeWallGroup = new THREE.Group();
  private clock = new THREE.Clock();
  private raf = 0;
  private cursorPoint: Vec2 | null = null;
  private disposed = false;

  constructor(host: HTMLElement) {
    this.renderer = new Renderer(host);
    this.scene = new EditorScene();
    this.cam = new CameraController();
    this.renderer.bindCamera(this.cam.camera);

    this.cursor = new GroundCursor();
    this.scene.add(this.cursor.group);
    this.scene.add(this.markersGroup);
    this.scene.add(this.activeWallGroup);

    this.floorPlan = new FloorPlanOverlay();
    this.scene.add(this.floorPlan.mesh);

    this.store = new EditorStore();

    this.input = new InputController(host, {
      onLook: (dx, dy) => this.cam.addLook(dx, dy),
      onDrop: () => this.drop(),
    });

    this.hud = new Hud(host, {
      onDrop: () => this.drop(),
      onUndo: () => this.store.undo(),
      onFinishWall: () => this.store.finishWall(),
      onCloseWall: () => this.store.closeWall(),
      onClearAll: () => this.store.clearAll(),
      onSave: () => void this.save(),
      onLoad: (name) => void this.loadByName(name),
      onDownload: () => this.download(),
      onDeleteMarker: (id) => this.store.deleteMarker(id),
      onSettingsChange: () => {},
      onFloorPlanFile: (file) => void this.onFloorPlanFile(file),
      onFloorPlanChange: () => this.applyFloorPlan(),
    });

    this.store.onChange(() => this.rebuildMarkers());
    this.rebuildMarkers();
    void this.refreshLevelList();
  }

  start(): void {
    this.clock.start();
    this.loop();
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);

    const move = this.input.getMove();
    this.cam.move(move.x, move.y, dt);
    this.cam.applyToCamera();

    this.cursorPoint = this.cursor.update(this.cam);
    this.cursor.setColor(CURSOR_COLORS[this.hud.settings.mode] ?? 0x7fd6ff);
    this.hud.setCoords(this.cursorPoint);

    this.rebuildActiveWall();

    this.renderer.render(this.scene.scene, this.cam.camera);
  };

  private rebuildMarkers(): void {
    disposeGroup(this.markersGroup);
    for (const w of this.store.walls) this.markersGroup.add(buildWall(w));
    for (const o of this.store.objects) this.markersGroup.add(buildObject(o));
    for (const s of this.store.spawns) this.markersGroup.add(buildSpawn(s));
    this.hud.setMarkers(this.store.allMarkers());
    this.hud.setActiveWall(this.store.activeWall);
  }

  private rebuildActiveWall(): void {
    disposeGroup(this.activeWallGroup);
    const active = this.store.activeWall;
    if (active && active.points.length > 0) {
      this.activeWallGroup.add(buildActiveWallPreview(active, this.cursorPoint));
    }
  }

  private drop(): void {
    if (!this.cursorPoint) {
      this.hud.setStatus("Aim at the ground to drop a marker.", "error");
      return;
    }
    const s = this.hud.settings;
    const p = this.cursorPoint;

    if (s.mode === "object") {
      const gp = snapToGrid(p, s.gridEnabled, s.gridSize);
      this.store.addObject({
        tag: s.tag,
        shape: s.objectShape,
        x: gp.x,
        z: gp.z,
        rot: 0,
        size: s.objectSize,
      });
      this.hud.setStatus(`Object dropped at ${fmt(gp, s.units)}.`, "ok");
    } else if (s.mode === "spawn") {
      const gp = snapToGrid(p, s.gridEnabled, s.gridSize);
      const facing = this.cam.headingDegrees();
      this.store.addSpawn({ tag: s.tag, x: gp.x, z: gp.z, facing });
      this.hud.setStatus(
        `Spawn dropped at ${fmt(gp, s.units)}, facing ${facing.toFixed(0)}°.`,
        "ok",
      );
    } else {
      const snap = snapWallPoint(p, this.store.walls, this.store.activeWall, {
        snapEnabled: s.snapEnabled,
        snapRadius: s.snapRadius,
        gridEnabled: s.gridEnabled,
        gridSize: s.gridSize,
      });
      const active = this.store.activeWall;
      if (active && active.points.length >= 3 && snap.snappedToStart) {
        this.store.closeWall();
        this.hud.setStatus("Wall closed into a loop.", "ok");
      } else {
        this.store.addWallPoint(snap.point, s.tag, s.wallHeight, s.wallThickness);
        const n = this.store.activeWall?.points.length ?? 0;
        this.hud.setStatus(
          `Wall point ${n} at ${fmt(snap.point, s.units)}${snap.snappedToEndpoint ? " (snapped)" : ""}.`,
          "ok",
        );
      }
    }
  }

  private async save(): Promise<void> {
    const name = this.hud.settings.levelName;
    if (!this.hud.validName()) {
      this.hud.setStatus(
        "Invalid name. Use letters, numbers, - or _ (no spaces).",
        "error",
      );
      return;
    }
    try {
      this.hud.setStatus("Saving…");
      const result = await saveLevel(name, this.store.serialize(name));
      const g = result.github;
      if (g?.pushed) {
        const short = g.commitSha ? ` (${g.commitSha.slice(0, 7)})` : "";
        this.hud.setStatus(
          `Saved levels/${name}.json + pushed to GitHub${short}`,
          "ok",
        );
      } else if (g && g.error) {
        this.hud.setStatus(
          `Saved levels/${name}.json locally — GitHub push failed: ${g.error}`,
          "error",
        );
      } else {
        this.hud.setStatus(`Saved to levels/${name}.json`, "ok");
      }
      await this.refreshLevelList();
    } catch (err) {
      this.hud.setStatus(`Save failed: ${(err as Error).message}`, "error");
    }
  }

  private download(): void {
    const name = this.hud.validName() ? this.hud.settings.levelName : "level";
    downloadLevel(name, this.store.serialize(name));
    this.hud.setStatus(`Downloaded ${name}.json`, "ok");
  }

  private async loadByName(name: string): Promise<void> {
    try {
      this.hud.setStatus(`Loading ${name}…`);
      const data = await loadLevel(name);
      this.store.load(data);
      this.hud.settings.levelName = name;
      const nameInput = document.querySelector<HTMLInputElement>(".js-name");
      if (nameInput) nameInput.value = name;
      this.hud.setStatus(`Loaded ${name}.`, "ok");
    } catch (err) {
      this.hud.setStatus(`Load failed: ${(err as Error).message}`, "error");
    }
  }

  private async refreshLevelList(): Promise<void> {
    try {
      const names = await listLevels();
      this.hud.setLevelList(names);
    } catch {
      /* api-server may be momentarily unavailable; ignore */
    }
  }

  private async onFloorPlanFile(file: File): Promise<void> {
    try {
      await this.floorPlan.setImage(file);
      this.applyFloorPlan();
      this.hud.setStatus("Floor plan loaded.", "ok");
    } catch (err) {
      this.hud.setStatus(`Image failed: ${(err as Error).message}`, "error");
    }
  }

  private applyFloorPlan(): void {
    const fp = this.hud.floorPlan;
    this.floorPlan.widthMeters = fp.widthMeters;
    this.floorPlan.offsetX = fp.offsetX;
    this.floorPlan.offsetZ = fp.offsetZ;
    this.floorPlan.rotationDeg = fp.rotationDeg;
    this.floorPlan.opacity = fp.opacity;
    this.floorPlan.applyTransform();
    this.floorPlan.setVisible(fp.visible);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.input.dispose();
    disposeGroup(this.markersGroup);
    disposeGroup(this.activeWallGroup);
    this.floorPlan.dispose();
    this.renderer.dispose();
  }
}

function fmt(p: Vec2, unit: Unit): string {
  return `(${fmtLen(p.x, unit)}, ${fmtLen(p.z, unit)} ${unit})`;
}
