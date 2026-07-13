import * as THREE from "three";

/**
 * Port of the Godot `HumanoidAnimator` (characters/humanoid_animator.gd) to
 * Three.js. The uploaded Jack/Sarah models are Meshy AUTO-RIGGED humanoids:
 * skinned skeletons with anonymous `Bone_NNN` names and NO baked animation
 * clips. This module bakes procedural clips from the same declarative
 * sine-channel definitions (STD_CLIPS) and per-rig semantic bone maps the Godot
 * build uses, so the web characters move exactly as they do in the source
 * project — a subtle breathing idle and a walk cycle — without shipping any
 * animation data.
 *
 * The one non-obvious detail carried over verbatim: every swing axis is defined
 * in MODEL space (PITCH = X, YAW = Y, ROLL = Z) and transformed into each
 * bone's PARENT-rest frame before it is applied, so e.g. a PITCH leg-swing
 * rotates every limb around the same model-space axis regardless of how its
 * bone is oriented in the bind pose.
 */

const DEG = Math.PI / 180;
const PI = Math.PI;
const TAU = Math.PI * 2;
const BAKE_STEP = 1 / 30;

// Axis constants (model space). Meshy rigs face +Z; facing in-scene is handled
// by the character group's own rotation, so these stay model-local.
const PITCH = new THREE.Vector3(1, 0, 0); // forward/back swings
const YAW = new THREE.Vector3(0, 1, 0);
const ROLL = new THREE.Vector3(0, 0, 1); // arm drop / stance adduction

export interface AnimChannel {
  g: string; // semantic bone group
  axis: THREE.Vector3;
  amp?: number; // degrees
  freq?: number;
  phase?: number;
  offset?: number; // constant (held) degrees
  cascade?: number; // per-bone phase increment down a group's chain
  attack?: number; // seconds to ramp the offset in — one-shot clips only (Menace/Lunge)
}
export interface ClipDef {
  len: number;
  loop: boolean;
  bob: number;
  bob_freq: number;
  channels: AnimChannel[];
}

/** Semantic bone group → ordered bone names, plus the constant humanising pose
 * baked under every clip (arm drop from T-pose, finger relax, stance). */
export interface RigConfig {
  bones: Record<string, string | string[]>;
  poseChannels: AnimChannel[];
}

/**
 * Standard human clip set, tuned in Godot on the first auto-rig test (Jack) and
 * expressed purely in group names so any configured rig can bake it. Only the
 * locomotion clips the prologue needs are ported for now (Idle / Walking /
 * Running); the gesture clips can be added later from the same source.
 */
export const STD_CLIPS: Record<string, ClipDef> = {
  Idle: {
    len: 3.5,
    loop: true,
    bob: 0,
    bob_freq: 1,
    channels: [
      { g: "spine", axis: PITCH, amp: 1.1, freq: 1 },
      { g: "head", axis: YAW, amp: 1.6, freq: 1, phase: 0.9 },
      { g: "uparm_r", axis: PITCH, amp: 1.4, freq: 1, phase: 0.5 },
      { g: "uparm_l", axis: PITCH, amp: 1.4, freq: 1, phase: 0.5 + PI },
    ],
  },
  Walking: {
    len: 1.1,
    loop: true,
    bob: 0.02,
    bob_freq: 2,
    channels: [
      { g: "thigh_l", axis: PITCH, amp: 26, freq: 1 },
      { g: "thigh_r", axis: PITCH, amp: 26, freq: 1, phase: PI },
      { g: "shin_l", axis: PITCH, amp: 18, freq: 1, phase: -1.6, offset: 7 },
      { g: "shin_r", axis: PITCH, amp: 18, freq: 1, phase: -1.6 + PI, offset: 7 },
      { g: "foot_l", axis: PITCH, amp: 10, freq: 1, phase: -0.1 },
      { g: "foot_r", axis: PITCH, amp: 10, freq: 1, phase: -0.1 + PI },
      { g: "uparm_r", axis: PITCH, amp: 16, freq: 1 },
      { g: "uparm_l", axis: PITCH, amp: 16, freq: 1, phase: PI },
      { g: "spine", axis: YAW, amp: 2.5, freq: 1 },
      { g: "head", axis: PITCH, amp: 1.2, freq: 2 },
    ],
  },
  Running: {
    len: 0.62,
    loop: true,
    bob: 0.045,
    bob_freq: 2,
    channels: [
      { g: "thigh_l", axis: PITCH, amp: 40, freq: 1 },
      { g: "thigh_r", axis: PITCH, amp: 40, freq: 1, phase: PI },
      { g: "shin_l", axis: PITCH, amp: 30, freq: 1, phase: -1.6, offset: 14 },
      { g: "shin_r", axis: PITCH, amp: 30, freq: 1, phase: -1.6 + PI, offset: 14 },
      { g: "foot_l", axis: PITCH, amp: 14, freq: 1, phase: -0.1 },
      { g: "foot_r", axis: PITCH, amp: 14, freq: 1, phase: -0.1 + PI },
      { g: "uparm_r", axis: PITCH, amp: 28, freq: 1 },
      { g: "uparm_l", axis: PITCH, amp: 28, freq: 1, phase: PI },
      { g: "forearm_r", axis: PITCH, amp: 8, freq: 1, offset: -34 },
      { g: "forearm_l", axis: PITCH, amp: 8, freq: 1, phase: PI, offset: -34 },
      { g: "spine", axis: PITCH, amp: 1.5, freq: 2, offset: 6 },
      { g: "spine", axis: YAW, amp: 3, freq: 1 },
    ],
  },
};

/** Jack (Lab outfit) — 35-joint auto-rig, mitten hands (no thumbs). */
export const JACK_RIG: RigConfig = {
  bones: {
    root: "Bone_000",
    pelvis: ["Bone_001"],
    spine: ["Bone_005", "Bone_004", "Bone_003", "Bone_002"],
    neck: ["Bone_018"],
    head: ["Bone_017", "Bone_016"],
    uparm_r: ["Bone_025"],
    forearm_r: ["Bone_024"],
    hand_r: ["Bone_023"],
    uparm_l: ["Bone_033"],
    forearm_l: ["Bone_032"],
    hand_l: ["Bone_031"],
    fingers_r: ["Bone_022", "Bone_021", "Bone_020"],
    fingers_l: ["Bone_030", "Bone_029", "Bone_028"],
    thigh_r: ["Bone_010"],
    shin_r: ["Bone_009"],
    foot_r: ["Bone_008"],
    thigh_l: ["Bone_015"],
    shin_l: ["Bone_014"],
    foot_l: ["Bone_013"],
  },
  poseChannels: [
    { g: "uparm_r", axis: ROLL, offset: -62 },
    { g: "uparm_l", axis: ROLL, offset: 62 },
    { g: "forearm_r", axis: ROLL, offset: -10 },
    { g: "forearm_l", axis: ROLL, offset: 10 },
    { g: "fingers_r", axis: ROLL, offset: -12 },
    { g: "fingers_l", axis: ROLL, offset: 12 },
    { g: "thigh_r", axis: ROLL, offset: -17 },
    { g: "thigh_l", axis: ROLL, offset: 17 },
    { g: "foot_r", axis: ROLL, offset: 17 },
    { g: "foot_l", axis: ROLL, offset: -17 },
  ],
};

/** Sarah (8 weeks) — 69-joint auto-rig, full fingers + thumbs. */
export const SARAH_RIG: RigConfig = {
  bones: {
    root: "Bone_000",
    pelvis: ["Bone_001"],
    spine: ["Bone_005", "Bone_004", "Bone_003", "Bone_002"],
    neck: ["Bone_018"],
    head: ["Bone_017", "Bone_016"],
    uparm_r: ["Bone_027"],
    forearm_r: ["Bone_026"],
    hand_r: ["Bone_024"],
    uparm_l: ["Bone_022"],
    forearm_l: ["Bone_021"],
    hand_l: ["Bone_019"],
    thumb_r: ["Bone_052", "Bone_051", "Bone_050"],
    thumb_l: ["Bone_032", "Bone_031", "Bone_030"],
    fingers_r: [
      "Bone_056", "Bone_055", "Bone_054", "Bone_053",
      "Bone_060", "Bone_059", "Bone_058", "Bone_057",
      "Bone_064", "Bone_063", "Bone_062", "Bone_061",
      "Bone_068", "Bone_067", "Bone_066", "Bone_065",
    ],
    fingers_l: [
      "Bone_036", "Bone_035", "Bone_034", "Bone_033",
      "Bone_040", "Bone_039", "Bone_038", "Bone_037",
      "Bone_044", "Bone_043", "Bone_042", "Bone_041",
      "Bone_048", "Bone_047", "Bone_046", "Bone_045",
    ],
    thigh_r: ["Bone_010"],
    shin_r: ["Bone_009"],
    foot_r: ["Bone_008"],
    thigh_l: ["Bone_015"],
    shin_l: ["Bone_014"],
    foot_l: ["Bone_013"],
  },
  poseChannels: [
    { g: "uparm_r", axis: ROLL, offset: -62 },
    { g: "uparm_l", axis: ROLL, offset: 62 },
    { g: "forearm_r", axis: ROLL, offset: -10 },
    { g: "forearm_l", axis: ROLL, offset: 10 },
    { g: "fingers_r", axis: ROLL, offset: -14 },
    { g: "fingers_l", axis: ROLL, offset: 14 },
    { g: "thumb_r", axis: ROLL, offset: -8 },
    { g: "thumb_l", axis: ROLL, offset: 8 },
    { g: "thigh_r", axis: ROLL, offset: -15 },
    { g: "thigh_l", axis: ROLL, offset: 15 },
    { g: "shin_r", axis: ROLL, offset: -6 },
    { g: "shin_l", axis: ROLL, offset: 6 },
    { g: "foot_r", axis: ROLL, offset: 21 },
    { g: "foot_l", axis: ROLL, offset: -21 },
  ],
};

/**
 * Dilophosaurus — Meshy auto-rig ("Dilo rigged - no animations.glb", 51 unnamed
 * bones, no clips). Bone map decoded from rest-pose geometry + rig screenshots in
 * the Godot source (Dinos/dilo_animator.gd). Quadruped-style theropod: spine runs
 * along +Z, so PITCH swings legs/neck, YAW side-sways tail/body. No T-pose
 * correction is needed (the rig ships posed), so poseChannels is empty.
 */
export const DILO_RIG: RigConfig = {
  bones: {
    root: "Bone_000",
    spine: ["Bone_001", "Bone_003", "Bone_002"],
    neck: ["Bone_017", "Bone_016", "Bone_015", "Bone_014"],
    head: ["Bone_050", "Bone_049", "Bone_048", "Bone_047"],
    snout: ["Bone_046", "Bone_045", "Bone_044"],
    arm_l: ["Bone_036", "Bone_035", "Bone_034", "Bone_033"],
    arm_r: ["Bone_043", "Bone_042", "Bone_041", "Bone_040"],
    thigh_l: ["Bone_023"], shin_l: ["Bone_022"], foot_l: ["Bone_021"],
    thigh_r: ["Bone_029"], shin_r: ["Bone_028"], foot_r: ["Bone_027"],
    tail: [
      "Bone_013", "Bone_012", "Bone_011", "Bone_010", "Bone_009",
      "Bone_008", "Bone_007", "Bone_006", "Bone_005", "Bone_004",
    ],
  },
  poseChannels: [],
};

/**
 * Dilophosaurus clip set, ported verbatim from the Godot DiloAnimator CLIPS.
 * Idle / Walk / Run loop; Menace (rear-up threat display — the crest-flare story
 * beat, pair with the snarl SFX) and Lunge (bite-snap) are one-shots that hold
 * their final pose (play with LoopOnce + clampWhenFinished).
 */
export const DILO_CLIPS: Record<string, ClipDef> = {
  Idle: {
    len: 3.0, loop: true, bob: 0.004, bob_freq: 1.0,
    channels: [
      { g: "spine", axis: PITCH, amp: 1.2, freq: 1.0 },
      { g: "neck", axis: PITCH, amp: 1.6, freq: 1.0, phase: 0.4 },
      { g: "head", axis: YAW, amp: 2.0, freq: 1.0, phase: 1.1 },
      { g: "tail", axis: YAW, amp: 2.6, freq: 1.0, cascade: 0.45 },
      { g: "arm_l", axis: PITCH, amp: 1.5, freq: 1.0, phase: 0.7 },
      { g: "arm_r", axis: PITCH, amp: 1.5, freq: 1.0, phase: 2.3 },
    ],
  },
  Walk: {
    len: 1.4, loop: true, bob: 0.015, bob_freq: 2.0,
    channels: [
      { g: "thigh_l", axis: PITCH, amp: 24.0, freq: 1.0 },
      { g: "thigh_r", axis: PITCH, amp: 24.0, freq: 1.0, phase: PI },
      { g: "shin_l", axis: PITCH, amp: 16.0, freq: 1.0, phase: -1.6, offset: 6.0 },
      { g: "shin_r", axis: PITCH, amp: 16.0, freq: 1.0, phase: -1.6 + PI, offset: 6.0 },
      { g: "foot_l", axis: PITCH, amp: 10.0, freq: 1.0, phase: -0.1 },
      { g: "foot_r", axis: PITCH, amp: 10.0, freq: 1.0, phase: -0.1 + PI },
      { g: "spine", axis: YAW, amp: 2.5, freq: 1.0 },
      { g: "neck", axis: PITCH, amp: 2.0, freq: 2.0, phase: 0.6 },
      { g: "tail", axis: YAW, amp: 5.0, freq: 1.0, cascade: 0.5 },
      { g: "arm_l", axis: PITCH, amp: 4.0, freq: 1.0, phase: 0.8 },
      { g: "arm_r", axis: PITCH, amp: 4.0, freq: 1.0, phase: 0.8 + PI },
    ],
  },
  Run: {
    len: 0.7, loop: true, bob: 0.03, bob_freq: 2.0,
    channels: [
      { g: "thigh_l", axis: PITCH, amp: 38.0, freq: 1.0 },
      { g: "thigh_r", axis: PITCH, amp: 38.0, freq: 1.0, phase: PI },
      { g: "shin_l", axis: PITCH, amp: 26.0, freq: 1.0, phase: -1.6, offset: 10.0 },
      { g: "shin_r", axis: PITCH, amp: 26.0, freq: 1.0, phase: -1.6 + PI, offset: 10.0 },
      { g: "foot_l", axis: PITCH, amp: 14.0, freq: 1.0, phase: -0.1 },
      { g: "foot_r", axis: PITCH, amp: 14.0, freq: 1.0, phase: -0.1 + PI },
      { g: "spine", axis: PITCH, amp: 1.5, freq: 2.0, offset: -6.0 }, // forward lean
      { g: "neck", axis: PITCH, amp: 2.5, freq: 2.0, offset: 4.0 }, // head level
      { g: "tail", axis: YAW, amp: 4.0, freq: 1.0, cascade: 0.6 },
      { g: "tail", axis: PITCH, amp: 0.0, freq: 1.0, offset: 2.5 }, // tail lifts
      { g: "arm_l", axis: PITCH, amp: 7.0, freq: 1.0, phase: 0.8 },
      { g: "arm_r", axis: PITCH, amp: 7.0, freq: 1.0, phase: 0.8 + PI },
    ],
  },
  Menace: {
    // One-shot: rears up over 0.6 s and holds. NEGATIVE pitch = front rises.
    len: 2.2, loop: false, bob: 0.0, bob_freq: 1.0,
    channels: [
      { g: "spine", axis: PITCH, amp: 0.0, freq: 1.0, offset: -9.0, attack: 0.6 },
      { g: "neck", axis: PITCH, amp: 0.0, freq: 1.0, offset: -18.0, attack: 0.6 },
      { g: "head", axis: YAW, amp: 6.0, freq: 5.5 }, // threat shake
      { g: "arm_l", axis: ROLL, amp: 0.0, freq: 1.0, offset: -14.0, attack: 0.6 },
      { g: "arm_r", axis: ROLL, amp: 0.0, freq: 1.0, offset: 14.0, attack: 0.6 },
      { g: "tail", axis: PITCH, amp: 0.0, freq: 1.0, offset: 3.0, attack: 0.6 },
      { g: "tail", axis: YAW, amp: 4.0, freq: 2.0, cascade: 0.5 },
    ],
  },
  Lunge: {
    // One-shot bite-snap, upper body only — legs stay planted.
    len: 0.8, loop: false, bob: 0.0, bob_freq: 1.0,
    channels: [
      { g: "spine", axis: PITCH, amp: -5.0, freq: 1.0 },
      { g: "neck", axis: PITCH, amp: -10.0, freq: 1.0 },
      { g: "head", axis: PITCH, amp: -5.0, freq: 1.0 },
      { g: "tail", axis: PITCH, amp: 5.0, freq: 0.5, cascade: 0.3 },
    ],
  },
};

export const RIGS: Record<string, RigConfig> = {
  Jack: JACK_RIG,
  Sarah: SARAH_RIG,
  Dilo: DILO_RIG,
};

interface BonePlan {
  axis: THREE.Vector3;
  amp: number;
  freq: number;
  phase: number;
  offset: number;
  attack: number;
}

/**
 * Bake the named clips for a rigged model and return them as THREE.AnimationClips
 * whose tracks target the model's bones by name. Bones referenced by the rig but
 * missing from the skeleton, and groups referenced by a clip but absent from the
 * rig, are skipped — exactly like the Godot engine — so the shared STD_CLIPS
 * stays portable across rigs with different hands.
 *
 * Must be called at load, while the skeleton is in its bind pose, so the
 * captured rest rotations are correct.
 */
export function bakeHumanoidClips(
  model: THREE.Object3D,
  rig: RigConfig,
  clipDefs: Record<string, ClipDef> = STD_CLIPS,
): THREE.AnimationClip[] {
  model.updateMatrixWorld(true);
  const rootQuatInv = model.getWorldQuaternion(new THREE.Quaternion()).invert();

  // Index the skeleton's bones by name.
  const byName = new Map<string, THREE.Bone>();
  model.traverse((o) => {
    if ((o as THREE.Bone).isBone) byName.set(o.name, o as THREE.Bone);
  });

  const groupBones = (g: string): string[] => {
    const v = rig.bones[g];
    return v == null ? [] : Array.isArray(v) ? v : [v];
  };

  // Parent-rest rotation of a bone, expressed in MODEL space (matches Godot's
  // parent global rest basis). At bind pose the bone world quaternions are the
  // rest globals; dividing out the model's own world rotation makes the baked
  // clip orientation-independent so the scene can freely rotate the character.
  const parentRestQuat = (bone: THREE.Bone): THREE.Quaternion => {
    const parent = bone.parent;
    if (!parent) return new THREE.Quaternion();
    const pq = parent.getWorldQuaternion(new THREE.Quaternion());
    return rootQuatInv.clone().multiply(pq);
  };

  const clips: THREE.AnimationClip[] = [];
  for (const [clipName, def] of Object.entries(clipDefs)) {
    const length = def.len;
    // Expand pose channels (innermost) then the clip's own channels onto bones.
    const perBone = new Map<string, BonePlan[]>();
    for (const src of [rig.poseChannels, def.channels]) {
      for (const ch of src) {
        const bl = groupBones(ch.g);
        bl.forEach((boneName, i) => {
          if (!perBone.has(boneName)) perBone.set(boneName, []);
          perBone.get(boneName)!.push({
            axis: ch.axis,
            amp: ch.amp ?? 0,
            freq: ch.freq ?? 1,
            phase: (ch.phase ?? 0) + (ch.cascade ?? 0) * i,
            offset: ch.offset ?? 0,
            attack: ch.attack ?? 0,
          });
        });
      }
    }

    const tracks: THREE.KeyframeTrack[] = [];
    const times: number[] = [];
    for (let t = 0; t <= length + 1e-3; t += BAKE_STEP) times.push(Math.min(t, length));

    for (const [boneName, plans] of perBone) {
      const bone = byName.get(boneName);
      if (!bone) continue;
      const restQ = bone.quaternion.clone();
      const parentInv = parentRestQuat(bone).invert();
      const values: number[] = [];
      const q = new THREE.Quaternion();
      const axisLocal = new THREE.Vector3();
      const rot = new THREE.Quaternion();
      for (const t of times) {
        q.copy(restQ);
        for (const e of plans) {
          // Attack ramps the held offset in over the first `attack` seconds, but
          // only on one-shots — on a loop the ramp would restart every cycle and
          // pop, so looping clips hold the full offset (matches the Godot baker).
          const ramp = !def.loop && e.attack > 0 ? Math.min(t / e.attack, 1) : 1;
          const deg = e.offset * ramp + e.amp * Math.sin(TAU * e.freq * (t / length) + e.phase);
          if (Math.abs(deg) > 1e-4) {
            axisLocal.copy(e.axis).applyQuaternion(parentInv).normalize();
            rot.setFromAxisAngle(axisLocal, deg * DEG);
            q.premultiply(rot);
          }
        }
        values.push(q.x, q.y, q.z, q.w);
      }
      tracks.push(new THREE.QuaternionKeyframeTrack(`${boneName}.quaternion`, times, values));
    }

    // Vertical bob on the root bone.
    if (def.bob > 0) {
      const rootName = groupBones("root")[0];
      const rootBone = rootName ? byName.get(rootName) : undefined;
      if (rootBone) {
        const o = rootBone.position;
        const bf = def.bob_freq;
        const pos: number[] = [];
        for (const t of times) {
          const y = def.bob * (0.5 - 0.5 * Math.cos(TAU * bf * (t / length) * 2));
          pos.push(o.x, o.y + y, o.z);
        }
        tracks.push(new THREE.VectorKeyframeTrack(`${rootName}.position`, times, pos));
      }
    }

    if (tracks.length > 0) {
      const clip = new THREE.AnimationClip(clipName, length, tracks);
      clips.push(clip);
    }
  }
  return clips;
}
