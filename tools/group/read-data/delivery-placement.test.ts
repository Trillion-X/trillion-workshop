import { describe, expect, it } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { boardRootRef, itemRef, placeItem } from './group-board-model';
import { deliveryPlacementMarker, deliveryPlacementMemberId, graphContainsDeliveryPlacement } from './delivery-placement';

describe('durable addressed board placement identity', () => {
  it('finds one caller-owned delivery across the graph without re-placing it', () => {
    const deliveryRef = 'opaque-attempt';
    const memberId = deliveryPlacementMemberId(deliveryRef);
    const root = boardRootRef('board');
    const graph = placeItem(emptyGraph(), root, {
      memberId,
      nodeRef: itemRef('board', memberId),
      kind: 'note', x: 0, y: 0, text: 'kept', src: 'cas:kept',
    });
    expect(graphContainsDeliveryPlacement(graph, deliveryRef)).toBe(true);
    expect(graphContainsDeliveryPlacement(graph, 'other')).toBe(false);
  });

  it('uses the runtime multihash marker rather than embedding an opaque delivery in graph/address keys', () => {
    const opaque = `unbounded/${'x'.repeat(100_000)}`;
    const marker = deliveryPlacementMarker(opaque);
    const memberId = deliveryPlacementMemberId(opaque);
    expect(marker).toBe(deliveryPlacementMarker(opaque));
    expect(memberId).toBe(`delivery:${marker}`);
    expect(memberId).not.toContain(opaque);
    expect(memberId.length).toBeLessThan(200);
    expect(deliveryPlacementMemberId('different')).not.toBe(memberId);
  });
});
