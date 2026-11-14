import { InstancedMesh, Matrix4, Mesh, Object3D, StaticDrawUsage } from 'three';

export type StaticGeometryBatchOptions = {
  /** Objects addressed by tracks, interactions, or diagnostics stay individually named. */
  protectedNames?: ReadonlySet<string>;
  /** Transparent instances cannot be depth-sorted independently, so they are opt-in. */
  includeTransparent?: boolean;
  minInstances?: number;
};

export type StaticGeometryBatchStats = {
  sourceMeshes: number;
  emittedBatches: number;
  emittedInstances: number;
  savedPlacements: number;
  skippedProtected: number;
  skippedIncompatible: number;
};

type CandidateMesh = Mesh & { isInstancedMesh?: boolean; isSkinnedMesh?: boolean };

const hasNegativeScale = (mesh: Mesh): boolean => {
  mesh.updateMatrix();
  return mesh.matrix.determinant() < 0;
};

const isCandidate = (mesh: CandidateMesh, options: Required<StaticGeometryBatchOptions>): boolean => {
  if (mesh.isInstancedMesh || mesh.isSkinnedMesh || mesh.children.length || !mesh.geometry || Array.isArray(mesh.material)) return false;
  if (!options.includeTransparent && mesh.material.transparent) return false;
  if (mesh.morphTargetInfluences || hasNegativeScale(mesh)) return false;
  return true;
};

/**
 * Collapse immutable direct mesh children into InstancedMesh batches while
 * preserving every owner group. Processing each owner independently keeps room,
 * track, interaction, visibility, and residency transforms addressable.
 */
export function batchImmutableStaticGeometry(root: Object3D, rawOptions: StaticGeometryBatchOptions = {}): StaticGeometryBatchStats {
  const options: Required<StaticGeometryBatchOptions> = {
    protectedNames: rawOptions.protectedNames ?? new Set<string>(),
    includeTransparent: rawOptions.includeTransparent ?? false,
    minInstances: Math.max(2, rawOptions.minInstances ?? 2),
  };
  const stats: StaticGeometryBatchStats = {
    sourceMeshes: 0, emittedBatches: 0, emittedInstances: 0,
    savedPlacements: 0, skippedProtected: 0, skippedIncompatible: 0,
  };

  const owners: Object3D[] = [];
  root.traverse((object) => owners.push(object));
  for (const owner of owners.reverse()) {
    const buckets = new Map<string, CandidateMesh[]>();
    for (const child of [...owner.children]) {
      if (!(child as CandidateMesh).isMesh) continue;
      const mesh = child as CandidateMesh;
      stats.sourceMeshes += 1;
      if (options.protectedNames.has(mesh.name)) { stats.skippedProtected += 1; continue; }
      if (!isCandidate(mesh, options)) { stats.skippedIncompatible += 1; continue; }
      const material = mesh.material;
      const key = [mesh.geometry.uuid, material.uuid, Number(mesh.castShadow), Number(mesh.receiveShadow), mesh.renderOrder, mesh.layers.mask, Number(mesh.visible), Number(mesh.frustumCulled)].join('|');
      const bucket = buckets.get(key) ?? [];
      bucket.push(mesh);
      buckets.set(key, bucket);
    }

    let ordinal = 0;
    for (const meshes of buckets.values()) {
      if (meshes.length < options.minInstances) continue;
      const source = meshes[0];
      const batch = new InstancedMesh(source.geometry, source.material, meshes.length);
      batch.name = `static-batch:${owner.name || 'anonymous'}:${ordinal++}:${source.material.name || 'material'}`;
      batch.instanceMatrix.setUsage(StaticDrawUsage);
      batch.castShadow = source.castShadow;
      batch.receiveShadow = source.receiveShadow;
      batch.renderOrder = source.renderOrder;
      batch.layers.mask = source.layers.mask;
      batch.visible = source.visible;
      batch.frustumCulled = source.frustumCulled;
      meshes.forEach((mesh, index) => {
        mesh.updateMatrix();
        batch.setMatrixAt(index, mesh.matrix);
        owner.remove(mesh);
      });
      batch.instanceMatrix.needsUpdate = true;
      batch.computeBoundingBox();
      batch.computeBoundingSphere();
      owner.add(batch);
      stats.emittedBatches += 1;
      stats.emittedInstances += meshes.length;
      stats.savedPlacements += meshes.length - 1;
    }
  }
  return stats;
}

/** Read back every local transform for deterministic source-to-batch proof. */
export function readInstanceMatrices(batch: InstancedMesh): Matrix4[] {
  const matrix = new Matrix4();
  return Array.from({ length: batch.count }, (_, index) => {
    batch.getMatrixAt(index, matrix);
    return matrix.clone();
  });
}
