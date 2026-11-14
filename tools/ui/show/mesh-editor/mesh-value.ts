// packages/ui/show/mesh-editor/mesh-value.ts
//
// Purpose: a mesh gradient's value (a base color and colored points) and the CSS that draws it, read by the mesh layer's
// render on every screen and by MeshEditor when the person changes it. Kept apart from the editor so drawing a mesh
// never loads the editor.
//
// Non-negotiable invariants:
// - readMeshValue always answers a drawable value: missing or malformed input falls back to the default mesh.
// - composeMeshBackground is pure: the same points give the same CSS.

export interface MeshPoint {
  /** 0..100 percent across. */
  readonly x: number;
  /** 0..100 percent down. */
  readonly y: number;
  /** #rrggbb(aa). */
  readonly color: string;
}

export interface MeshValue {
  readonly baseColor: string;
  readonly points: readonly MeshPoint[];
}

const DEFAULT_VALUE: MeshValue = {
  baseColor: '#1e1e2e',
  points: [
    { x: 0, y: 0, color: '#3b82f6' },
    { x: 100, y: 0, color: '#8b5cf6' },
    { x: 100, y: 100, color: '#ec4899' },
    { x: 0, y: 100, color: '#06b6d4' },
  ],
};

/** Compose the CSS `background-image` (a stack of radial blobs) for a mesh. */
export function composeMeshBackground(points: readonly MeshPoint[]): string {
  if (points.length === 0) return 'none';
  return points
    .map((p) => `radial-gradient(at ${p.x}% ${p.y}%, ${p.color} 0px, transparent 55%)`)
    .join(', ');
}

/** Read a MeshValue out of a layer's opaque input (with safe defaults). */
export function readMeshValue(input: Record<string, unknown>): MeshValue {
  const baseColor = typeof input.baseColor === 'string' ? input.baseColor : DEFAULT_VALUE.baseColor;
  const points = Array.isArray(input.points) && input.points.length > 0
    ? (input.points as MeshPoint[]).filter(
        (p) => typeof p?.x === 'number' && typeof p?.y === 'number' && typeof p?.color === 'string',
      )
    : DEFAULT_VALUE.points;
  return { baseColor, points: points.length > 0 ? points : DEFAULT_VALUE.points };
}

