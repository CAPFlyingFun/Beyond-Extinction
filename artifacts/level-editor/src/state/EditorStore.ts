import type {
  LevelData,
  Marker,
  ObjectMarker,
  SpawnMarker,
  Vec2,
  WallChain,
} from "./types";
import { AXES, LEVEL_VERSION } from "./types";

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}

/**
 * Holds all placed markers plus the wall chain currently being drawn.
 * Every mutation pushes an inverse onto an undo stack and notifies listeners
 * so the scene and HUD can rebuild.
 */
export class EditorStore {
  walls: WallChain[] = [];
  objects: ObjectMarker[] = [];
  spawns: SpawnMarker[] = [];
  activeWall: WallChain | null = null;

  private undoStack: Array<() => void> = [];
  private listeners = new Set<() => void>();

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  private push(undo: () => void): void {
    this.undoStack.push(undo);
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  // --- Objects & spawns ---

  addObject(o: Omit<ObjectMarker, "id" | "kind">): ObjectMarker {
    const marker: ObjectMarker = { ...o, id: nextId("obj"), kind: "object" };
    this.objects.push(marker);
    this.push(() => {
      this.objects = this.objects.filter((m) => m.id !== marker.id);
    });
    this.emit();
    return marker;
  }

  addSpawn(s: Omit<SpawnMarker, "id" | "kind">): SpawnMarker {
    const marker: SpawnMarker = { ...s, id: nextId("spawn"), kind: "spawn" };
    this.spawns.push(marker);
    this.push(() => {
      this.spawns = this.spawns.filter((m) => m.id !== marker.id);
    });
    this.emit();
    return marker;
  }

  // --- Walls ---

  startWall(tag: string, height: number, thickness: number): WallChain {
    const wall: WallChain = {
      id: nextId("wall"),
      kind: "wall",
      tag,
      closed: false,
      height,
      thickness,
      points: [],
    };
    this.activeWall = wall;
    this.emit();
    return wall;
  }

  /** Append a point to the active wall (starting one if needed). */
  addWallPoint(p: Vec2, tag: string, height: number, thickness: number): void {
    if (!this.activeWall) this.startWall(tag, height, thickness);
    const wall = this.activeWall!;
    wall.points.push({ x: p.x, z: p.z });
    this.push(() => {
      wall.points.pop();
      // If we undid the very first point, drop the empty active chain.
      if (wall === this.activeWall && wall.points.length === 0) {
        this.activeWall = null;
      }
    });
    this.emit();
  }

  /** Finish the active wall as an open chain (>= 2 points) or discard it. */
  finishWall(): void {
    const wall = this.activeWall;
    if (!wall) return;
    if (wall.points.length >= 2) {
      wall.closed = false;
      this.walls.push(wall);
      this.activeWall = null;
      this.push(() => {
        this.walls = this.walls.filter((w) => w.id !== wall.id);
        this.activeWall = wall;
      });
    } else {
      this.activeWall = null;
    }
    this.emit();
  }

  /** Close the active wall into a loop (needs >= 3 points). */
  closeWall(): void {
    const wall = this.activeWall;
    if (!wall || wall.points.length < 3) return;
    wall.closed = true;
    this.walls.push(wall);
    this.activeWall = null;
    this.push(() => {
      this.walls = this.walls.filter((w) => w.id !== wall.id);
      wall.closed = false;
      this.activeWall = wall;
    });
    this.emit();
  }

  cancelActiveWall(): void {
    if (!this.activeWall) return;
    this.activeWall = null;
    this.emit();
  }

  // --- Generic delete / undo / clear ---

  deleteMarker(id: string): void {
    const wall = this.walls.find((w) => w.id === id);
    if (wall) {
      const idx = this.walls.indexOf(wall);
      this.walls.splice(idx, 1);
      this.push(() => {
        this.walls.splice(Math.min(idx, this.walls.length), 0, wall);
      });
      this.emit();
      return;
    }
    const obj = this.objects.find((o) => o.id === id);
    if (obj) {
      const idx = this.objects.indexOf(obj);
      this.objects.splice(idx, 1);
      this.push(() => {
        this.objects.splice(Math.min(idx, this.objects.length), 0, obj);
      });
      this.emit();
      return;
    }
    const spawn = this.spawns.find((s) => s.id === id);
    if (spawn) {
      const idx = this.spawns.indexOf(spawn);
      this.spawns.splice(idx, 1);
      this.push(() => {
        this.spawns.splice(Math.min(idx, this.spawns.length), 0, spawn);
      });
      this.emit();
    }
  }

  undo(): void {
    const op = this.undoStack.pop();
    if (op) {
      op();
      this.emit();
    }
  }

  clearAll(): void {
    const snapshot = {
      walls: this.walls,
      objects: this.objects,
      spawns: this.spawns,
      activeWall: this.activeWall,
    };
    this.walls = [];
    this.objects = [];
    this.spawns = [];
    this.activeWall = null;
    this.push(() => {
      this.walls = snapshot.walls;
      this.objects = snapshot.objects;
      this.spawns = snapshot.spawns;
      this.activeWall = snapshot.activeWall;
    });
    this.emit();
  }

  allMarkers(): Marker[] {
    return [...this.walls, ...this.objects, ...this.spawns];
  }

  // --- Serialization ---

  serialize(name: string): LevelData {
    return {
      name,
      version: LEVEL_VERSION,
      units: "meters",
      axes: AXES,
      walls: this.walls.map((w) => ({
        tag: w.tag,
        closed: w.closed,
        height: w.height,
        thickness: w.thickness,
        points: w.points.map((p) => ({ x: round(p.x), z: round(p.z) })),
      })),
      objects: this.objects.map((o) => ({
        tag: o.tag,
        shape: o.shape,
        x: round(o.x),
        z: round(o.z),
        rot: round(o.rot),
        size: round(o.size),
      })),
      spawns: this.spawns.map((s) => ({
        tag: s.tag,
        x: round(s.x),
        z: round(s.z),
        facing: round(s.facing),
      })),
    };
  }

  load(data: LevelData): void {
    this.activeWall = null;
    this.undoStack = [];
    this.walls = (data.walls ?? []).map((w) => ({
      id: nextId("wall"),
      kind: "wall",
      tag: w.tag ?? "",
      closed: Boolean(w.closed),
      height: w.height ?? 3,
      thickness: w.thickness ?? 0.2,
      points: (w.points ?? []).map((p) => ({ x: p.x, z: p.z })),
    }));
    this.objects = (data.objects ?? []).map((o) => ({
      id: nextId("obj"),
      kind: "object",
      tag: o.tag ?? "",
      shape: o.shape === "circle" ? "circle" : "square",
      x: o.x,
      z: o.z,
      rot: o.rot ?? 0,
      size: o.size ?? 1,
    }));
    this.spawns = (data.spawns ?? []).map((s) => ({
      id: nextId("spawn"),
      kind: "spawn",
      tag: s.tag ?? "",
      x: s.x,
      z: s.z,
      facing: s.facing ?? 0,
    }));
    this.emit();
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
