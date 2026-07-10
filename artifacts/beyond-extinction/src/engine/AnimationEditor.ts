import * as THREE from "three";
import { loadModel } from "./assets";
import { RIGS, bakeHumanoidClips, STD_CLIPS, type RigConfig } from "./proceduralAnimator";
import { AnimStore, type SerClip } from "./AnimStore";

/**
 * In-game Animation Editor — reached from the PIN Dev menu. It opens a dedicated
 * turntable scene with a rigged character, lets the dev select a bone group,
 * pose it, drop keyframes on a timeline, scrub/play, and save a named clip.
 * Saved clips persist to AnimStore (localStorage + exportable JSON) and, because
 * every character shares the same bone rig, a clip named to match a baked one
 * ("Idle", "Walking", …) overrides it game-wide — "modify any animation".
 *
 * The character has NO native keyframed clips (locomotion is procedural), so the
 * editor can also LOAD an existing clip (Idle/Walking/Running or a saved custom)
 * by sampling it into editable keyframes — the base for tweaking any animation.
 */

const KEY_EPS = 0.02; // seconds: keyframes within this snap to the same time
const LOAD_SAMPLES = 10; // keyframes when importing an existing clip

interface Keyframe {
  time: number;
  /** boneName -> [x,y,z,w]; bones absent here fall back to the rest pose. */
  pose: Record<string, [number, number, number, number]>;
}

export interface AnimationEditorDeps {
  uiLayer: HTMLElement;
  domElement: HTMLCanvasElement;
  input: {
    setEnabled: (b: boolean) => void;
    enableFpControls: (b: boolean) => void;
    fpControlsActive: boolean;
  };
  onOpenChange?: (open: boolean) => void;
  playSfx?: (n: string) => void;
  showToast?: (m: string) => void;
}

// Friendly labels for the rig's semantic bone groups (skips root/pelvis/neck).
const GROUP_LABELS: Record<string, string> = {
  spine: "Spine",
  head: "Head",
  uparm_r: "R Upper Arm",
  forearm_r: "R Forearm",
  hand_r: "R Hand",
  uparm_l: "L Upper Arm",
  forearm_l: "L Forearm",
  hand_l: "L Hand",
  fingers_r: "R Fingers",
  fingers_l: "L Fingers",
  thumb_r: "R Thumb",
  thumb_l: "L Thumb",
  thigh_r: "R Thigh",
  shin_r: "R Shin",
  foot_r: "R Foot",
  thigh_l: "L Thigh",
  shin_l: "L Shin",
  foot_l: "L Foot",
};
const GROUP_ORDER = [
  "spine", "head",
  "uparm_r", "forearm_r", "hand_r",
  "uparm_l", "forearm_l", "hand_l",
  "thigh_r", "shin_r", "foot_r",
  "thigh_l", "shin_l", "foot_l",
  "fingers_r", "fingers_l", "thumb_r", "thumb_l",
];

export class AnimationEditor {
  private open = false;
  private scene = new THREE.Scene();
  private cam = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
  private model: THREE.Object3D | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private playAction: THREE.AnimationAction | null = null;

  private rig: RigConfig = RIGS.Jack;
  private bonesByName = new Map<string, THREE.Bone>();
  private groups: Array<{ key: string; label: string; bones: string[] }> = [];
  private restPose = new Map<string, THREE.Quaternion>();

  private selectedGroup: string | null = null;
  private keyframes: Keyframe[] = [];
  private editedBones = new Set<string>();
  private duration = 2;
  private scrubT = 0;
  private clipName = "Custom_1";
  private playing = false;
  private busy = false;
  private wasFp = false; // whether FP controls were active before opening

  // Orbit camera state.
  private orbitYaw = 0.5;
  private orbitPitch = 0.15;
  private orbitDist = 16;
  private target = new THREE.Vector3(0, 3.4, 0);
  private pointerId: number | null = null;
  private lastX = 0;
  private lastY = 0;

  private root?: HTMLDivElement;

  constructor(private deps: AnimationEditorDeps) {
    this.scene.background = new THREE.Color(0x141a22);
    const hemi = new THREE.HemisphereLight(0xcfe0ff, 0x2a2f38, 1.1);
    const key = new THREE.DirectionalLight(0xffffff, 1.8);
    key.position.set(8, 14, 10);
    const rim = new THREE.DirectionalLight(0x88aaff, 0.7);
    rim.position.set(-8, 6, -10);
    this.scene.add(hemi, key, rim);
    const grid = new THREE.GridHelper(40, 20, 0x39506a, 0x24303e);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.4;
    this.scene.add(grid);
  }

  isOpen(): boolean {
    return this.open;
  }

  /** The scene+camera the game should render while editing (null = normal). */
  overrideView(): { scene: THREE.Scene; camera: THREE.Camera } | null {
    return this.open ? { scene: this.scene, camera: this.cam } : null;
  }

  toggle(): void {
    if (this.open) this.close();
    else void this.openEditor();
  }

  private async openEditor(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.open = true;
    this.deps.onOpenChange?.(true);
    this.wasFp = this.deps.input.fpControlsActive;
    if (this.wasFp) this.deps.input.enableFpControls(false);
    this.deps.input.setEnabled(false);
    // Isolate the editor: hide every other HUD/menu overlay in the UI layer so
    // the island minimap, first-person buttons, main-menu splash, etc. can't
    // show through or overlap it (the 3D character is on the canvas behind, and
    // the editor scene fills that canvas, so we only need to hide sibling DOM).
    this.deps.uiLayer.classList.add("be-ae-open");
    this.buildHud();
    // Match the render camera to the canvas NOW — resize() otherwise only fires
    // on a window-resize event, so opening on a wide desktop left the aspect at
    // its initial 1 and stretched the character horizontally ("warped").
    this.resize(window.innerWidth, window.innerHeight);
    if (!this.model) await this.loadCharacter();
    this.busy = false;
    this.attachListeners();
    this.deps.playSfx?.("ui-confirm");
    this.updateCamera();
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.stop();
    this.detachListeners();
    this.root?.remove();
    this.root = undefined;
    this.deps.uiLayer.classList.remove("be-ae-open");
    this.deps.input.setEnabled(true);
    if (this.wasFp) this.deps.input.enableFpControls(true);
    this.deps.onOpenChange?.(false);
    this.deps.playSfx?.("ui-select");
  }

  update(dt: number): void {
    if (!this.open) return;
    if (this.playing && this.mixer) {
      this.mixer.update(dt);
      // Advance the scrubber + time label with playback so the playhead tracks
      // the frames (it was frozen — the mixer played but the UI never moved).
      if (this.playAction) {
        this.scrubT = this.playAction.time % Math.max(this.duration, 1e-3);
        this.updatePlayhead();
      }
    }
  }

  /** Move just the scrub thumb + time label to the current scrubT (no tick
   *  rebuild) — cheap enough to call every frame during playback. */
  private updatePlayhead(): void {
    const scrub = this.root?.querySelector<HTMLInputElement>(".be-ae__scrub");
    if (scrub) scrub.value = String(Math.round((this.scrubT / Math.max(this.duration, 1e-3)) * 1000));
    const time = this.root?.querySelector(".be-ae__time");
    if (time) time.textContent = `${this.scrubT.toFixed(2)}s`;
  }

  resize(w: number, h: number): void {
    this.cam.aspect = w / Math.max(1, h);
    this.cam.updateProjectionMatrix();
  }

  // ── Character load + rest pose ───────────────────────────────────────────────
  private async loadCharacter(): Promise<void> {
    const model = await loadModel("assets/models/Jack.glb", () => new THREE.Group());
    this.groundAndScale(model, 7);
    this.scene.add(model);
    this.model = model;
    this.rig = RIGS.Jack;

    this.bonesByName.clear();
    model.traverse((o) => {
      if ((o as THREE.Bone).isBone) this.bonesByName.set(o.name, o as THREE.Bone);
    });

    // Natural rest: bake a pose-only clip (rig.poseChannels drop the arms out of
    // the raw T-pose) and stamp its first frame onto the skeleton.
    const poseClips = bakeHumanoidClips(model, this.rig, {
      Rest: { len: 1, loop: false, bob: 0, bob_freq: 1, channels: [] },
    });
    if (poseClips[0]) {
      const m = new THREE.AnimationMixer(model);
      m.clipAction(poseClips[0]).play();
      m.update(0);
      m.stopAllAction();
    }
    // Capture rest quaternions for every rig bone.
    this.groups = [];
    for (const key of GROUP_ORDER) {
      const raw = this.rig.bones[key];
      if (raw == null) continue;
      const names = (Array.isArray(raw) ? raw : [raw]).filter((n) => this.bonesByName.has(n));
      if (!names.length) continue;
      this.groups.push({ key, label: GROUP_LABELS[key] ?? key, bones: names });
      for (const n of names) this.restPose.set(n, this.bonesByName.get(n)!.quaternion.clone());
    }
    this.renderGroupList();
  }

  private groundAndScale(model: THREE.Object3D, targetH: number): void {
    model.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const s = targetH / Math.max(size.y, 1e-3);
    model.scale.multiplyScalar(s);
    model.updateWorldMatrix(true, true);
    const box2 = new THREE.Box3().setFromObject(model);
    const c = box2.getCenter(new THREE.Vector3());
    model.position.x -= c.x;
    model.position.z -= c.z;
    model.position.y -= box2.min.y;
  }

  // ── Posing ───────────────────────────────────────────────────────────────────
  private rotateSelected(axis: "x" | "y" | "z", deg: number): void {
    if (!this.selectedGroup || this.playing) return;
    const grp = this.groups.find((g) => g.key === this.selectedGroup);
    if (!grp) return;
    const localAxis = new THREE.Vector3(axis === "x" ? 1 : 0, axis === "y" ? 1 : 0, axis === "z" ? 1 : 0);
    const q = new THREE.Quaternion().setFromAxisAngle(localAxis, (deg * Math.PI) / 180);
    for (const n of grp.bones) {
      const bone = this.bonesByName.get(n);
      if (!bone) continue;
      bone.quaternion.multiply(q);
      this.editedBones.add(n);
    }
    // If we're sitting on an existing keyframe, update it live.
    const kf = this.keyframes.find((k) => Math.abs(k.time - this.scrubT) <= KEY_EPS);
    if (kf) this.snapshotInto(kf);
  }

  private resetSelected(): void {
    if (!this.selectedGroup || this.playing) return;
    const grp = this.groups.find((g) => g.key === this.selectedGroup);
    if (!grp) return;
    for (const n of grp.bones) {
      const rest = this.restPose.get(n);
      const bone = this.bonesByName.get(n);
      if (rest && bone) bone.quaternion.copy(rest);
    }
    const kf = this.keyframes.find((k) => Math.abs(k.time - this.scrubT) <= KEY_EPS);
    if (kf) this.snapshotInto(kf);
  }

  private snapshotInto(kf: Keyframe): void {
    for (const n of this.editedBones) {
      const b = this.bonesByName.get(n);
      if (b) kf.pose[n] = [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w];
    }
  }

  // ── Keyframes / timeline ─────────────────────────────────────────────────────
  private addKeyframe(): void {
    if (this.playing) return;
    // Guarantee a t=0 anchor the first time.
    if (this.keyframes.length === 0 && this.scrubT > KEY_EPS) {
      this.keyframes.push({ time: 0, pose: {} });
      this.snapshotInto(this.keyframes[0]);
    }
    let kf = this.keyframes.find((k) => Math.abs(k.time - this.scrubT) <= KEY_EPS);
    if (!kf) {
      kf = { time: round(this.scrubT), pose: {} };
      this.keyframes.push(kf);
    }
    this.snapshotInto(kf);
    this.keyframes.sort((a, b) => a.time - b.time);
    this.duration = Math.max(this.duration, ...this.keyframes.map((k) => k.time), 0.1);
    this.renderTimeline();
    this.deps.showToast?.(`Keyframe @ ${kf.time.toFixed(2)}s`);
  }

  private deleteKeyframeAt(): void {
    const before = this.keyframes.length;
    this.keyframes = this.keyframes.filter((k) => Math.abs(k.time - this.scrubT) > KEY_EPS);
    if (this.keyframes.length !== before) this.renderTimeline();
  }

  private scrubTo(t: number): void {
    this.scrubT = Math.max(0, Math.min(this.duration, t));
    if (this.playing) return;
    this.applyPoseAt(this.scrubT);
    this.renderTimeline();
  }

  /** Preview: interpolate the skeleton to time t from the keyframes. */
  private applyPoseAt(t: number): void {
    if (this.keyframes.length === 0) return;
    const ks = this.keyframes;
    let a = ks[0];
    let b = ks[ks.length - 1];
    for (let i = 0; i < ks.length - 1; i++) {
      if (t >= ks[i].time && t <= ks[i + 1].time) {
        a = ks[i];
        b = ks[i + 1];
        break;
      }
    }
    const span = b.time - a.time;
    const f = span > 1e-4 ? (t - a.time) / span : 0;
    const qa = new THREE.Quaternion();
    const qb = new THREE.Quaternion();
    for (const n of this.editedBones) {
      const bone = this.bonesByName.get(n);
      if (!bone) continue;
      const rest = this.restPose.get(n)!;
      readQuat(a.pose[n], rest, qa);
      readQuat(b.pose[n], rest, qb);
      bone.quaternion.copy(qa).slerp(qb, f);
    }
  }

  // ── Play ─────────────────────────────────────────────────────────────────────
  private buildClip(name: string): THREE.AnimationClip {
    const times = this.keyframes.map((k) => k.time);
    const tracks: THREE.QuaternionKeyframeTrack[] = [];
    for (const n of this.editedBones) {
      const rest = this.restPose.get(n)!;
      const values: number[] = [];
      const q = new THREE.Quaternion();
      for (const kf of this.keyframes) {
        readQuat(kf.pose[n], rest, q);
        values.push(q.x, q.y, q.z, q.w);
      }
      tracks.push(new THREE.QuaternionKeyframeTrack(`${n}.quaternion`, times, values));
    }
    return new THREE.AnimationClip(name, this.duration, tracks);
  }

  private play(): void {
    if (this.playing || !this.model || this.keyframes.length < 2) {
      if (this.keyframes.length < 2) this.deps.showToast?.("Add at least 2 keyframes");
      return;
    }
    this.playing = true;
    this.mixer = new THREE.AnimationMixer(this.model);
    this.playAction = this.mixer.clipAction(this.buildClip("preview"));
    this.playAction.setLoop(THREE.LoopRepeat, Infinity);
    this.playAction.play();
    this.setPlayButton(true);
  }

  private stop(): void {
    this.playing = false;
    this.playAction?.stop();
    this.mixer?.stopAllAction();
    this.mixer = null;
    this.playAction = null;
    this.applyPoseAt(this.scrubT);
    this.setPlayButton(false);
  }

  // ── Save / load ──────────────────────────────────────────────────────────────
  private saveClip(): void {
    if (this.keyframes.length < 2) {
      this.deps.showToast?.("Add at least 2 keyframes first");
      return;
    }
    const clip = this.buildClip(this.clipName);
    const ser: SerClip = {
      name: this.clipName,
      duration: this.duration,
      tracks: clip.tracks.map((t) => ({
        bone: t.name.replace(/\.quaternion$/, ""),
        times: Array.from(t.times),
        values: Array.from(t.values),
      })),
    };
    AnimStore.save(ser);
    this.deps.showToast?.(`Saved "${this.clipName}" — used game-wide`);
    this.deps.playSfx?.("ui-confirm");
    this.renderLoadList();
  }

  private async exportClips(): Promise<void> {
    const json = AnimStore.exportJson();
    try {
      await navigator.clipboard.writeText(json);
    } catch {
      /* clipboard blocked */
    }
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "animations.json";
    a.click();
    URL.revokeObjectURL(url);
    this.deps.showToast?.("Exported animations.json (also copied)");
  }

  /** Load an existing clip (baked STD or saved custom) into editable keyframes. */
  private loadExisting(name: string): void {
    if (!this.model) return;
    this.stop();
    let clip: THREE.AnimationClip | null = null;
    const custom = AnimStore.get(name);
    if (custom) {
      clip = AnimStore.toClip(custom);
    } else if (STD_CLIPS[name]) {
      clip = bakeHumanoidClips(this.model, this.rig, { [name]: STD_CLIPS[name] })[0] ?? null;
    }
    if (!clip) return;

    this.keyframes = [];
    this.editedBones.clear();
    this.duration = clip.duration || 2;
    // Which bones this clip animates.
    const quatTracks = clip.tracks.filter(
      (t): t is THREE.QuaternionKeyframeTrack => t.name.endsWith(".quaternion"),
    );
    for (const t of quatTracks) this.editedBones.add(t.name.replace(/\.quaternion$/, ""));
    // Sample the clip into a handful of editable keyframes.
    const n = custom ? Math.max(2, custom.tracks[0]?.times.length ?? LOAD_SAMPLES) : LOAD_SAMPLES;
    for (let i = 0; i < n; i++) {
      const time = (i / (n - 1)) * this.duration;
      const pose: Keyframe["pose"] = {};
      for (const t of quatTracks) {
        const bone = t.name.replace(/\.quaternion$/, "");
        pose[bone] = sampleQuat(t, time);
      }
      this.keyframes.push({ time: round(time), pose });
    }
    this.clipName = name;
    this.scrubT = 0;
    this.applyPoseAt(0);
    const nameInput = this.root?.querySelector<HTMLInputElement>(".be-ae__name");
    if (nameInput) nameInput.value = name;
    this.renderTimeline();
    this.deps.showToast?.(`Loaded "${name}" — ${this.keyframes.length} keyframes`);
  }

  // ── Camera ───────────────────────────────────────────────────────────────────
  private updateCamera(): void {
    const p = this.pitchClamped();
    const cx = this.target.x + this.orbitDist * Math.cos(p) * Math.sin(this.orbitYaw);
    const cy = this.target.y + this.orbitDist * Math.sin(p);
    const cz = this.target.z + this.orbitDist * Math.cos(p) * Math.cos(this.orbitYaw);
    this.cam.position.set(cx, cy, cz);
    this.cam.lookAt(this.target);
  }
  private pitchClamped(): number {
    return Math.max(-1.2, Math.min(1.2, this.orbitPitch));
  }

  // ── Listeners ────────────────────────────────────────────────────────────────
  private prevTouchAction = "";
  private attachListeners(): void {
    const el = this.deps.domElement;
    // Own the canvas's touch-action while editing (InputManager is disabled), so
    // a touch drag orbits the model instead of scrolling the page.
    this.prevTouchAction = el.style.touchAction;
    el.style.touchAction = "none";
    el.addEventListener("pointerdown", this.onDown);
    el.addEventListener("pointermove", this.onMove);
    el.addEventListener("pointerup", this.onUp);
    el.addEventListener("pointercancel", this.onUp);
    el.addEventListener("wheel", this.onWheel, { passive: false });
    window.addEventListener("keydown", this.onKey);
  }
  private detachListeners(): void {
    const el = this.deps.domElement;
    el.style.touchAction = this.prevTouchAction;
    el.removeEventListener("pointerdown", this.onDown);
    el.removeEventListener("pointermove", this.onMove);
    el.removeEventListener("pointerup", this.onUp);
    el.removeEventListener("pointercancel", this.onUp);
    el.removeEventListener("wheel", this.onWheel);
    window.removeEventListener("keydown", this.onKey);
  }
  private onDown = (e: PointerEvent): void => {
    if (this.pointerId !== null) return;
    this.pointerId = e.pointerId;
    this.deps.domElement.setPointerCapture?.(e.pointerId);
    this.lastX = e.clientX;
    this.lastY = e.clientY;
  };
  private onMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    this.orbitYaw -= (e.clientX - this.lastX) * 0.008;
    this.orbitPitch += (e.clientY - this.lastY) * 0.008;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.updateCamera();
  };
  private onUp = (e: PointerEvent): void => {
    if (e.pointerId === this.pointerId) this.pointerId = null;
  };
  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.orbitDist = Math.max(6, Math.min(40, this.orbitDist + Math.sign(e.deltaY) * 1.4));
    this.updateCamera();
  };
  private onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") this.close();
  };

  // ── HUD ──────────────────────────────────────────────────────────────────────
  private buildHud(): void {
    const el = document.createElement("div");
    el.className = "be-ae";
    el.innerHTML = `
      <div class="be-ae__bar">
        <span class="be-ae__title">ANIMATION EDITOR</span>
        <select class="be-ae__load"></select>
        <button class="be-ae__loadbtn" data-act="load">Load</button>
        <span class="be-ae__spacer"></span>
        <input class="be-ae__name" value="${this.clipName}" spellcheck="false" />
        <button data-act="save">Save</button>
        <button data-act="export">Export</button>
        <button class="be-ae__x" data-act="close">Exit ✕</button>
      </div>
      <div class="be-ae__groups"></div>
      <div class="be-ae__pose">
        <div class="be-ae__selname">Select a bone group</div>
        <div class="be-ae__rot">
          <button data-rot="x-">X−</button><button data-rot="x+">X+</button>
          <button data-rot="y-">Y−</button><button data-rot="y+">Y+</button>
          <button data-rot="z-">Z−</button><button data-rot="z+">Z+</button>
          <button data-rot="reset" class="be-ae__reset">Reset</button>
        </div>
      </div>
      <div class="be-ae__timeline">
        <button data-act="play" class="be-ae__play">▶ Play</button>
        <div class="be-ae__scrubwrap">
          <input class="be-ae__scrub" type="range" min="0" max="1000" value="0" />
          <div class="be-ae__ticks"></div>
        </div>
        <span class="be-ae__time">0.00s</span>
        <button data-act="key">＋ Key</button>
        <button data-act="delkey">✕ Key</button>
        <span class="be-ae__kfs"></span>
      </div>
      <div class="be-ae__hint">Drag to orbit · wheel to zoom · pick a group, rotate, ＋Key across the timeline, Play, Save</div>`;
    this.deps.uiLayer.appendChild(el);
    this.root = el;

    el.querySelectorAll<HTMLButtonElement>("[data-rot]").forEach((b) => {
      b.addEventListener("click", () => {
        const r = b.dataset.rot!;
        if (r === "reset") this.resetSelected();
        else this.rotateSelected(r[0] as "x" | "y" | "z", r[1] === "+" ? 6 : -6);
        if (!this.playing) this.renderTimeline();
      });
    });
    el.querySelector('[data-act="close"]')?.addEventListener("click", () => this.close());
    el.querySelector('[data-act="key"]')?.addEventListener("click", () => this.addKeyframe());
    el.querySelector('[data-act="delkey"]')?.addEventListener("click", () => this.deleteKeyframeAt());
    el.querySelector('[data-act="play"]')?.addEventListener("click", () => (this.playing ? this.stop() : this.play()));
    el.querySelector('[data-act="save"]')?.addEventListener("click", () => this.saveClip());
    el.querySelector('[data-act="export"]')?.addEventListener("click", () => void this.exportClips());
    el.querySelector('[data-act="load"]')?.addEventListener("click", () => {
      const sel = el.querySelector<HTMLSelectElement>(".be-ae__load");
      if (sel?.value) this.loadExisting(sel.value);
    });
    el.querySelector<HTMLInputElement>(".be-ae__name")?.addEventListener("input", (e) => {
      this.clipName = (e.target as HTMLInputElement).value.trim() || "Custom_1";
    });
    const scrub = el.querySelector<HTMLInputElement>(".be-ae__scrub");
    scrub?.addEventListener("input", () => {
      this.scrubTo((Number(scrub.value) / 1000) * this.duration);
    });
    this.renderLoadList();
    this.renderGroupList();
    this.renderTimeline();
  }

  private renderLoadList(): void {
    const sel = this.root?.querySelector<HTMLSelectElement>(".be-ae__load");
    if (!sel) return;
    const std = Object.keys(STD_CLIPS);
    const custom = AnimStore.names().filter((n) => !std.includes(n));
    sel.innerHTML =
      `<optgroup label="Built-in">${std.map((n) => `<option>${n}</option>`).join("")}</optgroup>` +
      (custom.length ? `<optgroup label="Saved">${custom.map((n) => `<option>${n}</option>`).join("")}</optgroup>` : "");
  }

  private renderGroupList(): void {
    const wrap = this.root?.querySelector<HTMLDivElement>(".be-ae__groups");
    if (!wrap) return;
    wrap.innerHTML = this.groups
      .map(
        (g) =>
          `<button class="be-ae__group${g.key === this.selectedGroup ? " on" : ""}" data-g="${g.key}">${g.label}</button>`,
      )
      .join("");
    wrap.querySelectorAll<HTMLButtonElement>(".be-ae__group").forEach((b) => {
      b.addEventListener("click", () => {
        this.selectedGroup = b.dataset.g!;
        wrap.querySelectorAll(".be-ae__group").forEach((x) => x.classList.remove("on"));
        b.classList.add("on");
        const sn = this.root?.querySelector(".be-ae__selname");
        if (sn) sn.textContent = this.groups.find((g) => g.key === this.selectedGroup)?.label ?? "";
      });
    });
  }

  private renderTimeline(): void {
    const scrub = this.root?.querySelector<HTMLInputElement>(".be-ae__scrub");
    if (scrub) scrub.value = String(Math.round((this.scrubT / Math.max(this.duration, 1e-3)) * 1000));
    const time = this.root?.querySelector(".be-ae__time");
    if (time) time.textContent = `${this.scrubT.toFixed(2)}s`;
    const kfs = this.root?.querySelector(".be-ae__kfs");
    if (kfs)
      kfs.textContent = this.keyframes.length
        ? `${this.keyframes.length} keys: ${this.keyframes.map((k) => k.time.toFixed(1)).join(", ")}`
        : "no keyframes";
    // Keyframe markers on the timeline: a tick per key at its time, the one at
    // the playhead highlighted — so placed/imported keys are visible + findable.
    const ticks = this.root?.querySelector(".be-ae__ticks");
    if (ticks) {
      const dur = Math.max(this.duration, 1e-3);
      ticks.innerHTML = "";
      for (const k of this.keyframes) {
        const t = document.createElement("div");
        t.className = "be-ae__tick";
        t.style.left = `${Math.max(0, Math.min(100, (k.time / dur) * 100))}%`;
        t.title = `${k.time.toFixed(2)}s`;
        if (Math.abs(k.time - this.scrubT) <= KEY_EPS) t.classList.add("is-current");
        ticks.appendChild(t);
      }
    }
  }

  private setPlayButton(on: boolean): void {
    const b = this.root?.querySelector(".be-ae__play");
    if (b) b.textContent = on ? "⏹ Stop" : "▶ Play";
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────
function round(n: number): number {
  return Math.round(n * 100) / 100;
}
function readQuat(
  v: [number, number, number, number] | undefined,
  rest: THREE.Quaternion,
  out: THREE.Quaternion,
): void {
  if (v) out.set(v[0], v[1], v[2], v[3]);
  else out.copy(rest);
}
/** Sample a quaternion track at time t (nearest-interval slerp). */
function sampleQuat(track: THREE.QuaternionKeyframeTrack, t: number): [number, number, number, number] {
  const times = track.times;
  const v = track.values;
  if (times.length === 0) return [0, 0, 0, 1];
  if (t <= times[0]) return [v[0], v[1], v[2], v[3]];
  const last = times.length - 1;
  if (t >= times[last]) return [v[last * 4], v[last * 4 + 1], v[last * 4 + 2], v[last * 4 + 3]];
  let i = 0;
  while (i < last && times[i + 1] < t) i++;
  const f = (t - times[i]) / Math.max(times[i + 1] - times[i], 1e-4);
  const qa = new THREE.Quaternion(v[i * 4], v[i * 4 + 1], v[i * 4 + 2], v[i * 4 + 3]);
  const qb = new THREE.Quaternion(v[(i + 1) * 4], v[(i + 1) * 4 + 1], v[(i + 1) * 4 + 2], v[(i + 1) * 4 + 3]);
  qa.slerp(qb, f);
  return [qa.x, qa.y, qa.z, qa.w];
}
