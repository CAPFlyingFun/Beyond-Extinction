import * as THREE from "three";
import { loadModel } from "./assets";
import { RIGS, bakeHumanoidClips, STD_CLIPS } from "./proceduralAnimator";
import { AnimStore } from "./AnimStore";

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
  private walkBlend = 0;
  private targetBlend = 0;
  private readonly name: "Jack" | "Sarah";
  /** Extra metres to lift the feet so they rest ON the surface (no z-fight). */
  private readonly lift: number;

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
      const mixer = new THREE.AnimationMixer(model);
      const clips = model.animations;
      const byRe = (re: RegExp) => clips.find((cl) => re.test(cl.name));
      const idleClip =
        THREE.AnimationClip.findByName(clips, "Idle") ?? byRe(/idle/i) ?? clips[0];
      const walkClip = byRe(/^walking$/i) ?? byRe(/walk/i) ?? null;
      c.idle = mixer.clipAction(idleClip);
      c.idle.play();
      if (walkClip && walkClip !== idleClip) {
        c.walk = mixer.clipAction(walkClip);
        c.walk.play();
        c.walk.setEffectiveWeight(0);
      }
      mixer.update(0);
      c.mixer = mixer;
    }

    // Hero characters stay near camera; skip frustum culling so skinned limbs
    // (whose bind-pose bounds lag the animated pose) never pop out.
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.frustumCulled = false;
    });
    return c;
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

  /** Blend toward walk (true) or idle (false); eased in update(). */
  setMoving(moving: boolean): void {
    this.targetBlend = moving ? 1 : 0;
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

  update(dt: number): void {
    this.mixer?.update(dt);
    if (this.walk) {
      this.walkBlend += (this.targetBlend - this.walkBlend) * Math.min(1, dt * 8);
      this.idle?.setEffectiveWeight(1 - this.walkBlend);
      this.walk.setEffectiveWeight(this.walkBlend);
    }
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
