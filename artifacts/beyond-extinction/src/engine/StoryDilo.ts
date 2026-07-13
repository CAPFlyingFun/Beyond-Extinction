import * as THREE from "three";
import { loadModel } from "./assets";
import { beachHeight } from "./beachTerrain";
import { bakeHumanoidClips, DILO_RIG, DILO_CLIPS } from "./proceduralAnimator";

/**
 * The scripted Chapter One Dilophosaurus — the first dinosaur the player meets.
 * It is a STORY entity, deliberately kept out of the fauna streaming system
 * (SeaCreatures): it is placed by hand, revealed on cue, and choreographed by
 * the scene's reveal cutscene rather than driven by AI. ChatGPT's note: the
 * first encounter must be memorable and authored, not a random spawn.
 *
 * The model is the real Meshy rig ("dilophosaurus.glb", Draco-compressed) with
 * no baked clips, so idle / walk / run / menace (rear-up threat) / lunge are
 * synthesized from the ported sine-channel animator (proceduralAnimator). If the
 * GLB is ever missing it degrades to a coloured procedural theropod so the beat
 * still plays.
 */
export class StoryDilo {
  readonly group = new THREE.Group();
  private model?: THREE.Object3D;
  private mixer?: THREE.AnimationMixer;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private current?: THREE.AnimationAction;
  private head?: THREE.Object3D;

  constructor() {
    this.group.name = "StoryDilo";
    this.group.visible = false;
  }

  /** Load + scale the GLB, bake the clips, and start on Idle (hidden). */
  async load(targetHeightU: number): Promise<void> {
    const model = await loadModel("assets/models/dilophosaurus.glb", () =>
      this.buildFallback(),
    );

    // Scale so the standing model is targetHeightU tall, feet on the group origin.
    const size = new THREE.Vector3();
    new THREE.Box3().setFromObject(model).getSize(size);
    if (size.y > 1e-3) model.scale.multiplyScalar(targetHeightU / size.y);
    const grounded = new THREE.Box3().setFromObject(model);
    model.position.y -= grounded.min.y;

    // Meshy GLBs import fully-metallic/emissive (reads as black chrome under game
    // lighting); tame that the same way the Godot rig's _fix_materials does.
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.frustumCulled = false; // skinned bounds stay at bind pose
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        const sm = m as THREE.MeshStandardMaterial;
        if (sm && "metalness" in sm) {
          sm.metalness = Math.min(sm.metalness ?? 0, 0.1);
          if (sm.emissive) sm.emissiveIntensity = 0;
        }
      }
    });

    // Synthesize the clip set from the ported rig (the GLB ships none).
    if (!model.userData.isPlaceholder && (!model.animations || model.animations.length === 0)) {
      model.animations = bakeHumanoidClips(model, DILO_RIG, DILO_CLIPS);
    }

    if (model.animations && model.animations.length > 0) {
      this.mixer = new THREE.AnimationMixer(model);
      for (const clip of model.animations) {
        const action = this.mixer.clipAction(clip);
        if (clip.name === "Menace" || clip.name === "Lunge") {
          action.setLoop(THREE.LoopOnce, 1);
          action.clampWhenFinished = true; // hold the final (reared / snapped) pose
        }
        this.actions.set(clip.name, action);
      }
    }

    // The neck-top bone drives camera framing during the reveal.
    model.traverse((o) => {
      if ((o as THREE.Bone).isBone && o.name === "Bone_050") this.head = o;
    });

    this.group.add(model);
    this.model = model;
    this.play("Idle", 0);
  }

  /** Crossfade to a looping clip (Idle / Walk / Run). */
  play(name: string, fade = 0.25): void {
    const next = this.actions.get(name);
    if (!next || next === this.current) return;
    next.reset().fadeIn(fade).play();
    this.current?.fadeOut(fade);
    this.current = next;
  }

  /** Fire a one-shot (Menace / Lunge) from the start; it holds its final pose. */
  playOnce(name: string, fade = 0.15): void {
    const a = this.actions.get(name);
    if (!a) return;
    this.current?.fadeOut(fade);
    a.reset().setEffectiveWeight(1).fadeIn(fade).play();
    this.current = a;
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  /** Drop the Dilo onto the terrain at (x,z). */
  placeAt(x: number, z: number): void {
    this.group.position.set(x, beachHeight(x, z), z);
  }

  /** Turn to face a world point (model forward is +Z, yawed by the group). */
  faceToward(p: THREE.Vector3): void {
    this.group.rotation.y = Math.atan2(p.x - this.group.position.x, p.z - this.group.position.z);
  }

  /** Step forward along the current facing, riding the terrain. */
  moveForward(dist: number): void {
    const y = this.group.rotation.y;
    this.group.position.x += Math.sin(y) * dist;
    this.group.position.z += Math.cos(y) * dist;
    this.group.position.y = beachHeight(this.group.position.x, this.group.position.z);
  }

  /** World position of the head (for the reveal camera to frame). */
  headWorld(out: THREE.Vector3): THREE.Vector3 {
    (this.head ?? this.model ?? this.group).getWorldPosition(out);
    return out;
  }

  update(dt: number): void {
    this.mixer?.update(dt);
  }

  dispose(): void {
    this.mixer?.stopAllAction();
    this.group.removeFromParent();
  }

  /** Coarse procedural theropod — only used if the GLB fails to load. */
  private buildFallback(): THREE.Object3D {
    const g = new THREE.Group();
    const skin = new THREE.MeshStandardMaterial({ color: 0x6b7a4a, roughness: 0.9, flatShading: true });
    const crest = new THREE.MeshStandardMaterial({ color: 0xc0492f, roughness: 0.8 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(1.1, 3.2, 6, 12), skin);
    body.rotation.z = Math.PI / 2;
    body.position.set(0, 3.2, 0);
    const neck = new THREE.Mesh(new THREE.CapsuleGeometry(0.5, 2.2, 4, 8), skin);
    neck.rotation.x = Math.PI / 4;
    neck.position.set(0, 4.6, 1.9);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 2.2), skin);
    head.position.set(0, 5.6, 3.2);
    for (const sx of [-0.35, 0.35]) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.7, 1.6), crest);
      fin.position.set(sx, 6.2, 3.0);
      g.add(fin);
    }
    const tail = new THREE.Mesh(new THREE.CapsuleGeometry(0.6, 4, 4, 8), skin);
    tail.rotation.x = Math.PI / 2.2;
    tail.position.set(0, 3.0, -3.2);
    const legMat = new THREE.MeshStandardMaterial({ color: 0x556039, roughness: 0.9 });
    for (const sx of [-0.7, 0.7]) {
      const thigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.45, 2.0, 4, 8), legMat);
      thigh.position.set(sx, 1.6, -0.2);
      g.add(thigh);
    }
    g.add(body, neck, head, tail);
    g.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.castShadow = true;
    });
    return g;
  }
}
