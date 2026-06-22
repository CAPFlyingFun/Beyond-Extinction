import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

/**
 * Resolve a relative asset path (e.g. "assets/models/Jack.glb") against the
 * Vite base URL so it works regardless of where the artifact is mounted.
 */
export function assetUrl(relativePath: string): string {
  const base = import.meta.env.BASE_URL ?? "/";
  const clean = relativePath.replace(/^\/+/, "");
  return `${base}${clean}`;
}

const gltfLoader = new GLTFLoader();
const textureLoader = new THREE.TextureLoader();

/**
 * Load a GLB model. On any failure (missing file, parse error) this logs a
 * clear error to the console and returns the provided placeholder mesh so the
 * scene keeps working with an obvious stand-in.
 */
export async function loadModel(
  relativePath: string,
  placeholderFactory: () => THREE.Object3D,
): Promise<THREE.Object3D> {
  const url = assetUrl(relativePath);
  try {
    const gltf = await gltfLoader.loadAsync(url);
    const root = gltf.scene;
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });
    console.info(`[Beyond Extinction] Loaded model: ${url}`);
    return root;
  } catch (err) {
    const fileName = relativePath.split("/").pop() ?? relativePath;
    console.error(
      `[Beyond Extinction] ${fileName} failed to load — using placeholder. ` +
        `Drop the real model at "public/${relativePath}" to replace it.`,
      err,
    );
    const placeholder = placeholderFactory();
    placeholder.userData.isPlaceholder = true;
    return placeholder;
  }
}

/**
 * Load a texture, returning null (and logging) on failure so callers can fall
 * back gracefully.
 */
export async function loadTexture(
  relativePath: string,
): Promise<THREE.Texture | null> {
  const url = assetUrl(relativePath);
  try {
    const tex = await textureLoader.loadAsync(url);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  } catch (err) {
    console.error(
      `[Beyond Extinction] Failed to load texture "${url}".`,
      err,
    );
    return null;
  }
}
