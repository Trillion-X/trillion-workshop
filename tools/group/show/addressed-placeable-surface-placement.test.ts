import { describe, expect, it, vi } from 'vitest';

import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { boardRootRef, readItems } from '../read-data/group-board-model';
import {
  commitAddressedBoardDraft,
  commitAddressedPlaceableSurface,
} from './addressed-placeable-surface-placement';

const boardId = 'addressed-board';
const parentRef = boardRootRef(boardId);
const payload = {
  packageEntry: { packageName: 'workout-plan', entryName: 'surface' },
  surfaceInput: { planRef: 'plan-7' },
} as const;

function input(graph: ReturnType<typeof emptyGraph>, persist: (after: ReturnType<typeof emptyGraph>, before: ReturnType<typeof emptyGraph>) => Promise<string | null>) {
  return {
    payload,
    catalog: [payload],
    deliveryRef: 'delivery/ref with opaque payload',
    graph,
    parentRef,
    boardId,
    appearance: undefined,
    centerX: 500,
    centerY: 400,
    newId: (prefix: string) => `${prefix}-allocated`,
    persist,
  };
}

describe('addressed placeable-surface Group owner', () => {
  it('maps an eligible payload through the existing draft, persists one placement, and makes a repeat a durable no-op', async () => {
    let graph = emptyGraph();
    const persist = vi.fn(async (after) => {
      graph = after;
      return null;
    });

    const first = await commitAddressedPlaceableSurface(input(graph, persist));
    expect(first).toEqual({ accepted: true, disposition: 'placed' });
    expect(persist).toHaveBeenCalledTimes(1);

    const item = readItems(graph, parentRef)[0]!;
    expect(item.kind).toBe('note');
    expect(item.w).toBe(380);
    expect(item.h).toBe(300);
    expect(item.extra.placeableSurface).toEqual({
      packageName: 'workout-plan', entryName: 'surface', surfaceInput: { planRef: 'plan-7' },
    });

    const repeated = await commitAddressedPlaceableSurface(input(graph, persist));
    expect(repeated).toEqual({ accepted: true, disposition: 'already-placed' });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(readItems(graph, parentRef)).toHaveLength(1);
  });

  it('does not acknowledge a failed write and retries the same delivery without creating a second card', async () => {
    let graph = emptyGraph();
    const persist = vi.fn(async (after) => {
      if (persist.mock.calls.length === 1) return 'disk unavailable';
      graph = after;
      return null;
    });

    const failed = await commitAddressedPlaceableSurface(input(graph, persist));
    expect(failed).toEqual({ accepted: false, disposition: 'persistence-failed' });
    expect(readItems(graph, parentRef)).toHaveLength(0);

    const retried = await commitAddressedPlaceableSurface(input(graph, persist));
    expect(retried).toEqual({ accepted: true, disposition: 'placed' });
    expect(persist).toHaveBeenCalledTimes(2);
    expect(readItems(graph, parentRef)).toHaveLength(1);
  });

  it('denies a revoked catalog row before constructing or persisting a mutation', async () => {
    const persist = vi.fn(async () => null);
    const result = await commitAddressedPlaceableSurface({
      ...input(emptyGraph(), persist),
      catalog: [],
    });
    expect(result).toEqual({ accepted: false, disposition: 'catalog-denied' });
    expect(persist).not.toHaveBeenCalled();
  });

  it('preserves the board draft text, src, and opaque mount contract at the shared graph-write boundary', async () => {
    let graph = emptyGraph();
    const result = await commitAddressedBoardDraft({
      ...input(graph, async (after) => {
        graph = after;
        return null;
      }),
      draft: {
        kind: 'note', text: 'Daily plan', src: 'cas:proof', contentType: 'text/plain',
        extra: { placeableSurface: payload.packageEntry, custom: { retained: true } },
      },
    });
    expect(result).toEqual({ accepted: true, disposition: 'placed' });
    expect(readItems(graph, parentRef)[0]).toMatchObject({
      text: 'Daily plan', src: 'cas:proof',
      extra: { placeableSurface: payload.packageEntry, contentType: 'text/plain', custom: { retained: true } },
    });
  });
});
