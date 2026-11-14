// packages/group/show/presence-channel.test.ts
//
// The same-origin presence transport: wire-shape fail-closed validation,
// board scoping, and the no-op fallback. Node 23 ships BroadcastChannel
// globally, so the real primitive is under test (no mock transport).
import { describe, expect, it, vi } from 'vitest';
import { openPresenceChannel } from './presence-channel';
import type { Participant } from '../read-data/presence';

const alice: Participant = { id: 'peer-alice', name: 'Alice', cursor: { x: 10, y: 20 }, selection: ['m1'], ts: 1000 };

const flush = () => new Promise((r) => setTimeout(r, 25));

describe('openPresenceChannel', () => {
  it('delivers a published participant to a sibling channel on the SAME board', async () => {
    const seen: Participant[] = [];
    const rx = openPresenceChannel('board-1', (p) => seen.push(p));
    const tx = openPresenceChannel('board-1', () => {});
    tx.publish(alice);
    await flush();
    expect(seen).toEqual([alice]);
    rx.close();
    tx.close();
  });

  it('board-scopes: a different board id never receives the update', async () => {
    const seen: Participant[] = [];
    const rx = openPresenceChannel('board-OTHER', (p) => seen.push(p));
    const tx = openPresenceChannel('board-1', () => {});
    tx.publish(alice);
    await flush();
    expect(seen).toEqual([]);
    rx.close();
    tx.close();
  });

  it('drops a malformed wire message (fail-closed on the DATA boundary)', async () => {
    const seen: Participant[] = [];
    const rx = openPresenceChannel('board-2', (p) => seen.push(p));
    const raw = new BroadcastChannel('group.presence::board-2');
    raw.postMessage(null);
    raw.postMessage({ id: '', name: 'x', ts: 1 }); // empty id
    raw.postMessage({ id: 'p', name: 'x', ts: Number.NaN }); // non-finite ts
    raw.postMessage({ id: 'p', name: 'x', ts: 5 }); // VALID
    await flush();
    expect(seen).toEqual([{ id: 'p', name: 'x', ts: 5 }]);
    raw.close();
    rx.close();
  });

  it('publish after close never throws into the board', async () => {
    const ch = openPresenceChannel('board-3', () => {});
    ch.close();
    expect(() => ch.publish(alice)).not.toThrow();
  });

  it('degrades to a no-op channel where BroadcastChannel is unavailable', () => {
    const original = globalThis.BroadcastChannel;
    // @ts-expect-error — simulating an environment without the primitive
    delete globalThis.BroadcastChannel;
    try {
      const onUpdate = vi.fn();
      const ch = openPresenceChannel('board-4', onUpdate);
      expect(() => ch.publish(alice)).not.toThrow();
      expect(() => ch.close()).not.toThrow();
      expect(onUpdate).not.toHaveBeenCalled();
    } finally {
      globalThis.BroadcastChannel = original;
    }
  });
});
