import {
  readGuardedArtifactObjectUrl,
  type GuardedArtifactObjectUrl,
  type GuardedArtifactDispatch,
} from '../../ui/show/media-bytes/read-guarded-artifact-blob';

/**
 * Compatibility-shaped screen helper whose input is now the admitted relation
 * identity. The deleted direct CAS reader accepted raw storage coordinates and
 * a caller-selected partition; presentation can only use the shared guarded
 * relation delivery boundary.
 */
export type CanonicalArtifactObjectUrl = GuardedArtifactObjectUrl;

export async function readCanonicalArtifactObjectUrl(
  relationRef: string,
  dispatch?: GuardedArtifactDispatch,
): Promise<CanonicalArtifactObjectUrl> {
  if (!relationRef.trim()) throw new Error('relation_ref is required');
  if (!dispatch) {
    const { sendRequestToBitfieldTarget } = await import('#workspace-records');
    return readGuardedArtifactObjectUrl(relationRef, sendRequestToBitfieldTarget);
  }
  return readGuardedArtifactObjectUrl(relationRef, dispatch);
}
