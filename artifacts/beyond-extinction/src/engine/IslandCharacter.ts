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
  /** Extra metres to lift the feet so they rest ON the surface (no z-fight). */
  private readonly lift: number;

  private constructor(lift: number) {
    this.lift = lift;
  }

  static async load(
    name: "Jack" | "Sarah",
    heightM: number,
    opts: { lift?: number } = {},
  ): Promise<IslandCharacter> {
    const c = new IslandCharacter(opts.lift ?? 0.03);
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
      const idle =
        THREE.AnimationClip.findByName(clips, "Idle") ??
        clips.find((cl) => /idle/i.test(cl.name)) ??
        clips[0];
      mixer.clipAction(idle).play();
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

  update(dt: number): void {
    this.mixer?.update(dt);
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
