import type { Material, Object3D, Texture } from 'three';

export function disposeThreeObject(root: Object3D): void {
  root.traverse((object) => {
    // InstancedMesh owns per-instance GPU buffers in addition to shared geometry.
    (object as unknown as { isInstancedMesh?: boolean; dispose?: () => void }).isInstancedMesh &&
      (object as unknown as { dispose?: () => void }).dispose?.();
    const geometry = (object as unknown as { geometry?: { dispose?: () => void } }).geometry;
    geometry?.dispose?.();
    const raw = (object as unknown as { material?: Material | Material[] }).material;
    const materials = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const material of materials) {
      for (const value of Object.values(material)) if (value && typeof value === 'object' && (value as Texture).isTexture) (value as Texture).dispose();
      material.dispose();
    }
  });
}
