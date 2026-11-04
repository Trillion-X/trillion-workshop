// Durable idempotency seam for an addressed board placement. The caller owns
// the opaque delivery identity; this leaf maps it to one group member identity
// and asks the existing graph whether that member has already been persisted.

import { makeHashCodeHexFromBytes } from '#workspace-records';
import type { GroupGraph } from '../../ui/show/group/group-graph';

const textEncoder = new TextEncoder();

/**
 * The durable, bounded identity for one caller-owned delivery. `deliveryRef` is
 * opaque and unbounded; putting it directly in a graph member id also puts it in
 * an AddressRef part, JSON map key, and DOM-facing serialized node ref. The
 * runtime-owned multihash is the canonical fixed-size marker instead. It remains
 * deterministic for exact delivery lookup without introducing a Group hash family
 * or a browser-session completion cache.
 */
export function deliveryPlacementMarker(deliveryRef: string): string {
  return makeHashCodeHexFromBytes(textEncoder.encode(deliveryRef));
}

export function deliveryPlacementMemberId(deliveryRef: string): string {
  return `delivery:${deliveryPlacementMarker(deliveryRef)}`;
}

export function graphContainsDeliveryPlacement(graph: GroupGraph, deliveryRef: string): boolean {
  const memberId = deliveryPlacementMemberId(deliveryRef);
  return Object.values(graph.groups).some((group) => Object.prototype.hasOwnProperty.call(group.members, memberId));
}
