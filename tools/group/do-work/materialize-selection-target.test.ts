import { describe, expect, it } from 'vitest';
import type { AddressRef, Group } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { groupRecordAddress } from '../read-data/group-eeaf';
import { materializeGroupSelectionTarget } from './materialize-selection-target';
import { makeFactAddressBytesFromLabel } from '@bitfield/slot-protocol';

const root: AddressRef = { family: 'group.board', parts: { board: 'workout' } };
const item = (id: string): AddressRef => ({ family: 'board.item', parts: { id } });
const id = '8f4d9b77-a103-4d8a-9d51-2e3b1c4a5d6e';
const descriptor = 'package::group::target::materialize-selection-target';
const runtimeContext = { packageData: undefined, runtime: { ambient: { entropy_hex: 'ab'.repeat(32) } } };

function found(value: unknown): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(value));
  const multihash = Uint8Array.from([0x1f, 0x20, ...Array.from({ length: 32 }, (_, index) => (payload[index % Math.max(1, payload.length)] ?? index))]);
  const out = new Uint8Array(11 + payload.byteLength + multihash.byteLength);
  out[0] = 1; out[1] = 1; new DataView(out.buffer).setUint32(2, payload.byteLength, true); out.set(payload, 6);
  const offset = 6 + payload.byteLength;
  out[offset] = 1; new DataView(out.buffer).setUint32(offset + 1, multihash.byteLength, true); out.set(multihash, offset + 5);
  return out;
}

function board(): Group {
  return {
    groupRef: root,
    memberOrder: ['first', 'second'],
    members: {
      first: { memberId: 'first', nodeRef: item('first'), presentation: { kind: 'note', text: 'First plan', x: 1, y: 2, w: 200, h: 100 } },
      second: { memberId: 'second', nodeRef: item('second'), presentation: { kind: 'note', text: 'Second plan', x: 3, y: 4, w: 200, h: 100 } },
    },
  };
}

function engine() {
  const stored = new Map<string, unknown>([
    [groupRecordAddress(root), board()],
    [descriptor, { kind: 'package-target-descriptor', target: 'group.materialize-selection-target' }],
    ['package::group::entry-bytes::selected-capsule-renderer', 'prebuilt Group capsule renderer bytes'],
  ]);
  const writes: unknown[] = [];
  const sender = async (request: { payload: unknown }) => {
    if (request.payload instanceof Uint8Array) {
      const text = new TextDecoder().decode(request.payload);
      const start = text.indexOf('{"address"');
      if (start >= 0) {
        let depth = 0; let quoted = false; let escaped = false; let end = -1;
        for (let index = start; index < text.length; index += 1) {
          const char = text[index]!;
          if (quoted) { if (!escaped && char === '"') quoted = false; escaped = !escaped && char === '\\'; continue; }
          if (char === '"') { quoted = true; continue; }
          if (char === '{') depth += 1;
          if (char === '}' && --depth === 0) { end = index + 1; break; }
        }
        const value = JSON.parse(text.slice(start, end));
        const address = value.address as string;
        if (stored.has(address)) throw new Error('already exists');
        stored.set(address, value); writes.push(value);
        return { ok: true };
      }
      for (const [address, value] of stored) {
        const encoded = makeFactAddressBytesFromLabel(address);
        if (text.includes(address) || contains(request.payload, encoded)) return found(value);
      }
      return new Uint8Array([0]);
    }
    throw new Error('unexpected engine request');
  };
  return { stored, writes, sender };
}

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let offset = 0; offset <= haystack.length - needle.length; offset += 1) {
    for (let index = 0; index < needle.length; index += 1) if (haystack[offset + index] !== needle[index]) continue outer;
    return true;
  }
  return false;
}

const request = (member_ids = ['first']) => ({ partition_label: 'test', materialization_id: id, selection: { root_ref: root, member_ids } });

describe('Group selection materialization target', () => {
  it('refuses missing trusted entropy before persisting anything', async () => {
    const runtime = engine();
    const result = await materializeGroupSelectionTarget(request(), undefined, runtime.sender as never);
    expect(result.error).toContain('no trusted entropy');
    expect(runtime.writes).toEqual([]);
  });
  it('persists an exact, buyer-renderable selected projection with no source paths', async () => {
    const runtime = engine();
    const result = await materializeGroupSelectionTarget(request(['first', 'second']), runtimeContext, runtime.sender as never);
    expect(result.schema).toBe('selection-materialization-result/v1');
    expect(result.error).toBeUndefined();
    expect(result.root_refs).toHaveLength(1);
    expect(result.records?.[0]).toMatchObject({
      kind_ref: 'group.selection-projection/v1',
      dependency_refs: [],
      browser_import_bindings: [],
    });
    const file = (result.records?.[0].projection_files as Array<Record<string, unknown>>)[0]!;
    expect(file.source).toMatchObject({ kind: 'inline' });
    expect(file).not.toHaveProperty('mounted_path');
    const renderer = (result.records?.[0].projection_files as Array<Record<string, unknown>>)[1]!;
    expect(renderer.source).toMatchObject({ kind: 'blob_ref', hash: renderer.integrity_hash });
    expect(JSON.stringify(result)).not.toContain('/Users/');
    const projection = runtime.stored.get(result.root_refs![0].address) as Record<string, unknown>;
    expect(JSON.stringify(projection)).toContain('First plan');
    expect(JSON.stringify(projection)).toContain('Second plan');
  });

  it('rejects empty, local-only, and unresolvable selections', async () => {
    const runtime = engine();
    await expect(materializeGroupSelectionTarget({ ...request(), selection: { root_ref: root, member_ids: [] } }, runtimeContext, runtime.sender as never)).resolves.toMatchObject({ schema: 'selection-materialization-result/v1', error: expect.any(String) });
    await expect(materializeGroupSelectionTarget({ ...request(['missing']) }, runtimeContext, runtime.sender as never)).resolves.toMatchObject({ schema: 'selection-materialization-result/v1', error: expect.any(String) });
    await expect(materializeGroupSelectionTarget({ ...request(), selection: { root_ref: { family: 'group.board', parts: {} }, member_ids: ['first'] } }, runtimeContext, runtime.sender as never)).resolves.toMatchObject({ schema: 'selection-materialization-result/v1', error: expect.any(String) });
  });

  it('is idempotent for an identical retry and rejects a conflicting retry', async () => {
    const runtime = engine();
    const first = await materializeGroupSelectionTarget(request(), runtimeContext, runtime.sender as never);
    const again = await materializeGroupSelectionTarget(request(), runtimeContext, runtime.sender as never);
    expect(again).toMatchObject({ schema: 'selection-materialization-result/v1', root_refs: first.root_refs, authority_ref: first.authority_ref });
    const conflict = await materializeGroupSelectionTarget(request(['second']), runtimeContext, runtime.sender as never);
    expect(conflict).toMatchObject({ schema: 'selection-materialization-result/v1', error: 'materialization conflict' });
  });

  it('uses only the generic authority vocabulary', async () => {
    const runtime = engine();
    const result = await materializeGroupSelectionTarget(request(), runtimeContext, runtime.sender as never);
    const authority = runtime.stored.get(result.authority_ref!.address) as Record<string, unknown>;
    expect(authority.kind).toBe('selection-materialization-authority/v1');
    expect(authority.materializer).toBe('group.materialize-selection-target');
    expect(JSON.stringify(authority).toLowerCase()).not.toMatch(/seller|offer|policy|hosted/);
  });
});
