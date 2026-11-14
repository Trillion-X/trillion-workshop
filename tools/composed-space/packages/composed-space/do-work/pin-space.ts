/**
 * Placement is presentation DATA, not a composed-space mutation. The host supplies
 * a previously declared placement descriptor; composed-space only carries its ref
 * with the normalized descriptor identity.
 */
export function buildSpacePlacementIntent(spaceRef: string, placementDescriptorRef: string) {
  const space_ref = typeof spaceRef === 'string' ? spaceRef.trim() : '';
  const placement_descriptor_ref = typeof placementDescriptorRef === 'string' ? placementDescriptorRef.trim() : '';
  if (!space_ref || !placement_descriptor_ref) return null;
  return { space_ref, placement_descriptor_ref };
}
