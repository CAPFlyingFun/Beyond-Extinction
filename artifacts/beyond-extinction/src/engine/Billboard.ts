import * as THREE from "three";

/**
 * A camera-facing cutout plane for lightweight outdoor scene dressing
 * (vegetation, rocks, distant terrain) — far cheaper than full GLB props,
 * especially on phones. Geometry pivots at the bottom-center so placing the
 * mesh at y=0 plants its base on the ground.
 */
export function createBillboard(
  texture: THREE.Texture,
  height: number,
  widthOverride?: number,
): THREE.Mesh {
  const image = texture.image as { width: number; height: number } | undefined;
  const aspect = image ? image.width / image.height : 1;
  const width = widthOverride ?? height * aspect;
  const geometry = new THREE.PlaneGeometry(width, height);
  geometry.translate(0, height / 2, 0);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.isBillboard = true;
  return mesh;
}

/**
 * Face billboards toward the camera around the Y axis only, so trees/rocks
 * stay upright instead of tilting with camera pitch (a full look-at would
 * make them lean as the camera bobs).
 */
export function updateBillboardsYAxis(
  billboards: THREE.Object3D[],
  cameraPosition: THREE.Vector3,
): void {
  for (const b of billboards) {
    b.rotation.y = Math.atan2(
      cameraPosition.x - b.position.x,
      cameraPosition.z - b.position.z,
    );
  }
}
