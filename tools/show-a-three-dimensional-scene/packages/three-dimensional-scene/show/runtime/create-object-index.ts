import type { Object3D } from 'three';

export type ObjectIndex = { objects: Map<string, Object3D>; duplicates: Set<string> };

export function createObjectIndex(roots: readonly Object3D[]): ObjectIndex {
  const objects = new Map<string, Object3D>(); const duplicates = new Set<string>();
  for (const root of roots) root.traverse((object) => {
    if (!object.name) return;
    if (objects.has(object.name)) { duplicates.add(object.name); objects.delete(object.name); }
    else if (!duplicates.has(object.name)) objects.set(object.name, object);
  });
  return { objects, duplicates };
}
