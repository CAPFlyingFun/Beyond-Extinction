import * as THREE from "three";
import { loadModel } from "./assets";
import { RIGS, bakeHumanoidClips, STD_CLIPS } from "./proceduralAnimator";
import { AnimStore } from "./AnimStore";

// Reused scratch for the per-frame foot-IK solve (no per-frame allocation).
const _hip = new THREE.Vector3();
const _knee = new THREE.Vector3();
const _ankle = new THREE.Vector3();
const _target = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _newKnee = new THREE.Vector3();
const _curDir = new THREE.Vector3();
const _desDir = new THREE.Vector3();
const _child = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _pWorld = new THREE.Quaternion();
const _cWorld = new THREE.Quaternion();
const _solved = new THREE.Quaternion();
const _grp = new THREE.Vector3();

/** One IK leg: the thigh→shin→foot bone chain plus its eased blend weight. */
interface IkLeg {
  thigh: THREE.Object3D;
  shin: THREE.Object3D;
  foot: THREE.Object3D;
  w: number; // eased IK weight 0..1
}

/**
 * A self-contained humanoid actor for the real-scale (metre) island maps.
 *
 * Loads a named GLB (Jack/Sarah), scales it to a real height, and sits its feet
 * exactly on the group origin so the caller can plant it by setting the group's
 * world Y to the ground height. On the streaming Kauaʻi map that height comes
 * from KauaiTileStreamer.surfaceHeightAt — the RENDERED mesh surface — so the
 * character stands on the terrain you see, never sunk into it (the clip we get
 * when grounding to a height that doesn't match the drawn mesh).
 *
 * Auto-rigged Meshy models ship no clips, so idle/walk/run are synthesized from
 * the ported rig (same as the other scenes); a mixer plays Idle by default.
 */
export class IslandCharacter {
  readonly group = new THREE.Group();
  private model?: THREE.Object3D;
  private mixer?: THREE.AnimationMixer;
  private idle?: THREE.AnimationAction;
  private walk?: THREE.AnimationAction;
  private run?: THREE.AnimationAction;
  // Eased blend weights: idle↔moving, and within moving, walk↔run.
  private moveBlend = 0;
  private gaitMix = 0;
  // Commanded locomotion, set each frame by the scene from real displacement.
  private cmdSpeed = 0; // world m/s
  private cmdRun = false; // sprint gait requested
  // Each clip's OWN implied ground speed (m/s) at timeScale 1 — measured from the
  // baked foot swing at load, per model (leg length differs Jack vs Sarah), so
  // timeScale = worldSpeed / ref plants the stride instead of foot-sliding.
  private refWalk = 1.4;
  private refRun = 3.6;
  // ── Optional foot IK (opt-in via the scene; off by default). Plants each foot
  // on its OWN patch of ground so the stance reads level on slopes, and RELEASES
  // (weight → 0) the moment the body leaves the floor: airborne/jumping, wading
  // or swimming, or when a foot would need too big a correction (a ledge). The
  // knee pole is taken from the live animated pose, so the leg never inverts.
  private footIk = false;
  private legs?: IkLeg[];
  private sampleGround?: (x: number, z: number) => number | null;
  private stanceReleased = false; // airborne or in water this frame → no clamp
  private readonly name: "Jack" | "Sarah";
  /** Extra metres to lift the feet so they rest ON the surface (no z-fight). */
  private readonly lift: number;

  /** The measured clip reference speeds (m/s) — exposed for the dev diagnostic. */
  get referenceSpeeds(): { walk: number; run: number } {
    return { walk: this.refWalk, run: this.refRun };
  }

  private constructor(name: "Jack" | "Sarah", lift: number) {
    this.name = name;
    this.lift = lift;
  }

  static async load(
    name: "Jack" | "Sarah",
    heightM: number,
    opts: { lift?: number } = {},
  ): Promise<IslandCharacter> {
    const c = new IslandCharacter(name, opts.lift ?? 0.03);
    c.group.name = `island-char-${name}`;
    const model = await loadModel(`assets/models/${name}.glb`, () =>
      IslandCharacter.placeholder(name === "Sarah" ? 0x36b27a : 0x3a78d0),
    );
    c.model = model;
    c.group.add(model);
    IslandCharacter.groundAndScale(model, heightM);

    // Synthesize the standard clip set for auto-rigs that ship none, then overlay
    // any dev-authored clips — exactly as the other island scenes do.
    if (
      (!model.animations || model.animations.length === 0) &&
      !model.userData.isPlaceholder &&
      RIGS[name]
    ) {
      model.animations = bakeHumanoidClips(model, RIGS[name], {
        Idle: STD_CLIPS.Idle,
        Walking: STD_CLIPS.Walking,
        Running: STD_CLIPS.Running,
      });
    }
    if (model.animations) model.animations = AnimStore.applyTo(model.animations);

    if (model.animations && model.animations.length > 0) {
      const clips = model.animations;
      const byRe = (re: RegExp) => clips.find((cl) => re.test(cl.name));
      const idleClip =
        THREE.AnimationClip.findByName(clips, "Idle") ?? byRe(/idle/i) ?? clips[0];
      const walkClip = byRe(/^walking$/i) ?? byRe(/walk/i) ?? null;
      const runClip = byRe(/^running$/i) ?? byRe(/run/i) ?? null;

      // Measure each locomotion clip's implied ground speed from its baked foot
      // swing BEFORE the live mixer starts (measurement scrubs the skeleton, so
      // it must run on a throwaway mixer first). Feet are RIGS[name].foot_*.
      const rig = RIGS[name];
      const footL = (Array.isArray(rig?.bones.foot_l) ? rig.bones.foot_l[0] : rig?.bones.foot_l) ?? "";
      const footR = (Array.isArray(rig?.bones.foot_r) ? rig.bones.foot_r[0] : rig?.bones.foot_r) ?? "";
      if (walkClip) {
        const m = IslandCharacter.measureGroundSpeed(model, walkClip, footL, footR);
        if (m > 0.4) c.refWalk = THREE.MathUtils.clamp(m, 0.6, 2.5);
      }
      if (runClip) {
        const m = IslandCharacter.measureGroundSpeed(model, runClip, footL, footR);
        if (m > 0.8) c.refRun = THREE.MathUtils.clamp(m, 1.5, 7);
      }

      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.log(
          `[locomotion] ${name} refWalk=${c.refWalk.toFixed(2)} m/s refRun=${c.refRun.toFixed(2)} m/s`,
        );
      }

      const mixer = new THREE.AnimationMixer(model);
      c.idle = mixer.clipAction(idleClip);
      c.idle.play();
      if (walkClip && walkClip !== idleClip) {
        c.walk = mixer.clipAction(walkClip);
        c.walk.play();
        c.walk.setEffectiveWeight(0);
      }
      if (runClip && runClip !== idleClip && runClip !== walkClip) {
        c.run = mixer.clipAction(runClip);
        c.run.play();
        c.run.setEffectiveWeight(0);
      }
      mixer.update(0);
      c.mixer = mixer;
    }

    // Hero characters stay near camera; skip frustum culling so skinned limbs
    // (whose bind-pose bounds lag the animated pose) never pop out.
    //
    // v0.0.136: the +30% scene lighting (v0.0.135) brightened the sand but left
    // the characters reading dark against it — GLB albedos (denim, hair) are low
    // and only lit by the sun/hemi. Give each standard material a gentle
    // self-lit floor keyed off its own albedo map so dark cloth lifts while
    // already-bright skin barely moves; intensity is low enough not to flatten
    // form or blow highlights.
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.frustumCulled = false;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) {
        const std = mat as THREE.MeshStandardMaterial;
        if (!std || !std.isMeshStandardMaterial) continue;
        std.emissive = std.color.clone();
        if (std.map) std.emissiveMap = std.map;
        std.emissiveIntensity = 0.22;
        std.needsUpdate = true;
      }
    });
    return c;
  }

  /**
   * Implied ground speed (m/s) of a baked locomotion clip: scrub one full cycle
   * on a throwaway mixer and track the peak forward (+Z, model faces +Z)
   * separation between the two feet — that's one step length. The body advances
   * two steps per cycle, so speed = 2 · maxStep / cycleDuration. Self-calibrating
   * per model (Jack's legs are longer than Sarah's), so timeScale = worldSpeed /
   * ref plants the stride at any gameplay speed.
   */
  private static measureGroundSpeed(
    model: THREE.Object3D,
    clip: THREE.AnimationClip,
    footLName: string,
    footRName: string,
  ): number {
    const bl = footLName ? model.getObjectByName(footLName) : undefined;
    const br = footRName ? model.getObjectByName(footRName) : undefined;
    if (!bl || !br || clip.duration <= 0) return 0;
    const mixer = new THREE.AnimationMixer(model);
    mixer.clipAction(clip).play();
    const pL = new THREE.Vector3();
    const pR = new THREE.Vector3();
    let maxStep = 0;
    const N = 48;
    for (let i = 0; i <= N; i++) {
      mixer.setTime((i / N) * clip.duration);
      model.updateMatrixWorld(true);
      bl.getWorldPosition(pL);
      br.getWorldPosition(pR);
      maxStep = Math.max(maxStep, Math.abs(pL.z - pR.z));
    }
    mixer.stopAllAction();
    mixer.uncacheClip(clip);
    return (2 * maxStep) / clip.duration;
  }

  /** Scale to `targetHeight` metres and drop the feet onto the group origin. */
  private static groundAndScale(model: THREE.Object3D, targetHeight: number): void {
    const size = new THREE.Vector3();
    new THREE.Box3().setFromObject(model).getSize(size);
    if (size.y > 1e-4) model.scale.multiplyScalar(targetHeight / size.y);
    const box = new THREE.Box3().setFromObject(model);
    model.position.y -= box.min.y; // feet (box.min.y) → y = 0
  }

  private static placeholder(color: number): THREE.Object3D {
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.28, 1.1, 6, 12),
      new THREE.MeshStandardMaterial({ color, roughness: 0.6 }),
    );
    body.position.y = 0.95;
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 16, 16),
      new THREE.MeshStandardMaterial({ color, roughness: 0.5 }),
    );
    head.position.y = 1.7;
    body.castShadow = head.castShadow = true;
    g.add(body, head);
    return g;
  }

  /** Face a world direction given by a yaw (radians, 0 = +Z). */
  setFacing(yaw: number): void {
    this.group.rotation.y = yaw;
  }

  /** Plant the feet at world (x, groundY, z). */
  place(x: number, groundY: number, z: number): void {
    this.group.position.set(x, groundY + this.lift, z);
  }

  /** Re-plant the feet at a new ground height (call when terrain refines). */
  setGround(groundY: number): void {
    this.group.position.y = groundY + this.lift;
  }

  /** Orient the BODY to a look yaw (radians). The model faces +Z, the look yaw
   *  faces -Z, so the body is turned 180° from the camera yaw. Used when this
   *  character is the first-person player. */
  setBodyYaw(lookYaw: number): void {
    this.group.rotation.y = lookYaw + Math.PI;
  }

  /**
   * Drive locomotion from the character's REAL world speed (m/s) and whether the
   * sprint gait is active. The walk/run clip is time-warped so its stride matches
   * the distance actually travelled (no foot-slide), and idle↔walk↔run weights
   * are eased in update(). Pass speed 0 for a standing NPC.
   */
  setLocomotion(speed: number, running: boolean): void {
    this.cmdSpeed = Math.max(0, speed);
    this.cmdRun = running;
  }

  /** Back-compat shim: binary moving flag → walk at its natural cadence. */
  setMoving(moving: boolean): void {
    this.setLocomotion(moving ? this.refWalk : 0, false);
  }

  /**
   * Shrink (0.001) or restore the head bone chain. Hidden while this character
   * is the first-person player so the head-height camera doesn't render the
   * inside of the skull (the baked clips only write rotation, so scale sticks).
   */
  setHeadHidden(hidden: boolean): void {
    const model = this.model;
    if (!model) return;
    const spec = RIGS[this.name]?.bones.head ?? ["Bone_017", "Bone_016"];
    const names = Array.isArray(spec) ? spec : [spec];
    let head: THREE.Object3D | undefined;
    for (const n of names) {
      head = model.getObjectByName(n);
      if (head) break;
    }
    if (!head) return;
    const s = hidden ? 0.001 : 1;
    head.traverse((o) => {
      if ((o as THREE.Bone).isBone) o.scale.setScalar(s);
    });
  }

  /**
   * Turn on foot IK. `sampleGround(x, z)` returns the world ground height under a
   * world XZ (or null when that spot hasn't loaded / is off the map). Builds the
   * thigh→shin→foot chains from the rig; a no-op if the rig or bones are missing.
   */
  enableFootIk(sampleGround: (x: number, z: number) => number | null): void {
    const model = this.model;
    const rig = RIGS[this.name];
    if (!model || !rig) return;
    const pick = (spec: string | string[] | undefined): THREE.Object3D | undefined => {
      const names = Array.isArray(spec) ? spec : spec ? [spec] : [];
      for (const n of names) {
        const b = model.getObjectByName(n);
        if (b) return b;
      }
      return undefined;
    };
    const build = (t?: string | string[], s?: string | string[], f?: string | string[]): IkLeg | null => {
      const thigh = pick(t);
      const shin = pick(s);
      const foot = pick(f);
      return thigh && shin && foot ? { thigh, shin, foot, w: 0 } : null;
    };
    const legs = [
      build(rig.bones.thigh_l, rig.bones.shin_l, rig.bones.foot_l),
      build(rig.bones.thigh_r, rig.bones.shin_r, rig.bones.foot_r),
    ].filter((l): l is IkLeg => l !== null);
    if (legs.length === 0) return;
    this.legs = legs;
    this.sampleGround = sampleGround;
    this.footIk = true;
  }

  /** Per-frame release flags: while airborne or in water the feet unclamp so the
   *  legs swing/paddle freely instead of being pinned to the (irrelevant) floor. */
  setStance(o: { airborne?: boolean; inWater?: boolean }): void {
    this.stanceReleased = !!(o.airborne || o.inWater);
  }

  update(dt: number): void {
    this.mixer?.update(dt);
    if (this.footIk) this.applyFootIk(dt);
    if (!this.walk && !this.run) return;

    const v = this.cmdSpeed;
    const movingTarget = v > 0.15 ? 1 : 0;
    // Sprint uses the run clip; otherwise walk. (Selected by input state, not by
    // speed, so a slow careful sprint still reads as a run gait and vice-versa.)
    const gaitTarget = this.cmdRun && this.run ? 1 : 0;
    this.moveBlend += (movingTarget - this.moveBlend) * Math.min(1, dt * 8);
    this.gaitMix += (gaitTarget - this.gaitMix) * Math.min(1, dt * 6);

    // Time-warp each clip so its stride matches the real distance travelled: a
    // clip whose feet imply `ref` m/s is played at v/ref. Clamped so it eases the
    // slide without whirring (retuned stride/speed keep this near 1.0).
    if (this.walk) this.walk.timeScale = THREE.MathUtils.clamp(v / this.refWalk, 0.55, 1.7);
    if (this.run) this.run.timeScale = THREE.MathUtils.clamp(v / this.refRun, 0.55, 1.7);

    this.idle?.setEffectiveWeight(1 - this.moveBlend);
    this.walk?.setEffectiveWeight(this.moveBlend * (1 - this.gaitMix));
    this.run?.setEffectiveWeight(this.moveBlend * this.gaitMix);
  }

  /**
   * Plant each foot on its own ground. Per leg: read the animated hip/knee/ankle,
   * shift the ankle target vertically onto THIS foot's ground (a foot over higher
   * ground lifts; over a dip, drops), solve a two-bone chain that keeps the
   * animated knee pole (never inverts), and blend by an eased per-foot weight
   * that fades to 0 when released (airborne / in water) or the correction is too
   * large (a ledge the leg shouldn't reach for). Runs on the freshly-animated
   * pose; next frame's mixer overwrites it, so nothing accumulates.
   */
  private applyFootIk(dt: number): void {
    const legs = this.legs;
    const sample = this.sampleGround;
    if (!legs || !sample) return;
    this.group.getWorldPosition(_grp);
    const gBody = sample(_grp.x, _grp.z);
    const ease = Math.min(1, dt * 7); // ~0.15 s ramp in/out
    const MAX_CORR = 0.4; // clamp the per-foot lift/drop (m)
    const RELEASE = 0.7; // correction beyond this → let go (ledge/step)

    for (const leg of legs) {
      leg.thigh.getWorldPosition(_hip);
      leg.shin.getWorldPosition(_knee);
      leg.foot.getWorldPosition(_ankle);

      // Desired weight this frame, and the vertical correction if engaged.
      let want = 0;
      let corr = 0;
      if (!this.stanceReleased && gBody != null) {
        const gFoot = sample(_ankle.x, _ankle.z);
        if (gFoot != null) {
          const raw = gFoot - gBody; // this foot's ground vs the body plant
          if (Math.abs(raw) <= RELEASE) {
            corr = THREE.MathUtils.clamp(raw, -MAX_CORR, MAX_CORR);
            want = 1;
          }
        }
      }
      leg.w += (want - leg.w) * ease;
      if (leg.w < 1e-3) continue; // fully released → animation untouched

      _target.set(_ankle.x, _ankle.y + corr, _ankle.z);
      const l1 = _hip.distanceTo(_knee);
      const l2 = _knee.distanceTo(_ankle);
      if (l1 < 1e-3 || l2 < 1e-3) continue;

      _dir.copy(_target).sub(_hip);
      let D = _dir.length();
      if (D < 1e-4) continue;
      _dir.multiplyScalar(1 / D);
      D = THREE.MathUtils.clamp(D, Math.abs(l1 - l2) + 1e-3, l1 + l2 - 1e-3);

      // Knee = a along the hip→target line, plus a pole offset lifted from the
      // CURRENT bend plane so it keeps bending the way the animation does.
      const a = (l1 * l1 - l2 * l2 + D * D) / (2 * D);
      const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
      _pole.copy(_knee).sub(_hip);
      _pole.addScaledVector(_dir, -_pole.dot(_dir));
      if (_pole.lengthSq() < 1e-6) {
        // Leg near-straight: fall back to bending in the body's forward.
        _pole.set(Math.sin(this.group.rotation.y), 0, Math.cos(this.group.rotation.y));
        _pole.addScaledVector(_dir, -_pole.dot(_dir));
        if (_pole.lengthSq() < 1e-6) continue;
      }
      _pole.normalize();
      _newKnee.copy(_hip).addScaledVector(_dir, a).addScaledVector(_pole, h);

      // Aim thigh → new knee, propagate, then aim shin (from the moved knee) →
      // the target ankle. Both blended by the eased weight.
      this.aimBone(leg.thigh, _knee, _newKnee, leg.w);
      leg.thigh.updateWorldMatrix(false, true);
      leg.foot.getWorldPosition(_ankle); // ankle rode along with the thigh
      this.aimBone(leg.shin, _ankle, _target, leg.w);
      leg.shin.updateWorldMatrix(false, true);
    }
  }

  /**
   * Rotate `bone` so the direction to its child swings from `childWorld` toward
   * `targetWorld`, slerped into the bone's animated local rotation by `weight`.
   * Solved in world space (via the parent) so it composes with the pose cleanly.
   */
  private aimBone(
    bone: THREE.Object3D,
    childWorld: THREE.Vector3,
    targetWorld: THREE.Vector3,
    weight: number,
  ): void {
    bone.getWorldPosition(_child); // _child ← bone world position
    _curDir.copy(childWorld).sub(_child);
    _desDir.copy(targetWorld).sub(_child);
    if (_curDir.lengthSq() < 1e-8 || _desDir.lengthSq() < 1e-8) return;
    _curDir.normalize();
    _desDir.normalize();
    _q.setFromUnitVectors(_curDir, _desDir); // world-space delta
    bone.getWorldQuaternion(_cWorld);
    if (bone.parent) bone.parent.getWorldQuaternion(_pWorld);
    else _pWorld.identity();
    // localSolved = parentWorld⁻¹ · q · curWorld
    _solved.copy(_pWorld).invert().multiply(_q).multiply(_cWorld);
    bone.quaternion.slerp(_solved, weight);
  }

  dispose(): void {
    this.mixer?.stopAllAction();
    this.group.removeFromParent();
    this.model?.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[];
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      }
    });
  }
}
