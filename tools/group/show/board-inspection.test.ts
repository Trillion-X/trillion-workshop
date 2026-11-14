// packages/group/show/board-inspection.test.ts

import { describe, it, expect, vi } from 'vitest';
import {
  BOARD_MODEL_WRITE_KIND,
  INSPECTION_FIELD_SET_KIND,
  boardItemRecordProjection,
  createBoardInspectionRegistry,
  createBoardWriteOpRegistry,
  dispatchBoardModelWrite,
  readInspectionFieldSets,
  type BoardItemLike,
} from './board-inspection';
import { resolveInspection, stampInspectionRef, INSPECTION_REF_ATTR } from '../../ui/show/inspection-ref';

const item: BoardItemLike = { memberId: 'm1', text: 'hello', extra: { shape: 'star' } };

/** The DATA rows exactly as the group contract publishes them. */
const FIELD_SET_RECORD = {
  payload: {
    kind: INSPECTION_FIELD_SET_KIND,
    id: 'inspection-fields:group:board-item',
    family: 'group.board-item',
    fields: [
      { id: 'text', label: 'Text', path: ['text'], write_op: 'set-text' },
      { id: 'fill', label: 'Fill color', path: ['fill'], write_op: 'set-fill' },
      { id: 'shape', label: 'Shape', path: ['extra', 'shape'], write_op: 'set-presentation', write_config: { key: 'shape' } },
    ],
  },
};

function fieldSets(records: ReadonlyArray<{ payload?: unknown }> = [FIELD_SET_RECORD]) {
  return readInspectionFieldSets(records);
}

function stamped(family: string, member: string): Element {
  const node = document.createElement('div');
  const stamp = stampInspectionRef({ family, parts: { member } });
  node.setAttribute(INSPECTION_REF_ATTR, stamp[INSPECTION_REF_ATTR]);
  document.body.appendChild(node);
  return node;
}

describe('board-inspection — descriptor DATA drives everything', () => {
  it('field sets decode from published records; families are open DATA', () => {
    const sets = fieldSets();
    expect([...sets.keys()]).toEqual(['group.board-item']);
    expect(sets.get('group.board-item')).toHaveLength(3);
  });

  it('non-descriptor records and malformed rows are skipped (never throw)', () => {
    const sets = readInspectionFieldSets([
      { payload: { kind: 'something-else' } },
      { payload: { kind: INSPECTION_FIELD_SET_KIND, family: 'x', fields: [{ id: 1 }, 'junk', null] } },
      {},
    ]);
    expect(sets.size).toBe(0);
  });

  it('resolves a stamped item to one source per DATA row with the row write_op in the template', () => {
    const registry = createBoardInspectionRegistry((id) => (id === 'm1' ? item : null), fieldSets());
    const sources = resolveInspection(stamped('group.board-item', 'm1'), registry);
    expect(sources.map((s) => s.label)).toEqual(['Text', 'Fill color', 'Shape']);
    expect(sources.every((s) => s.write?.kind === BOARD_MODEL_WRITE_KIND)).toBe(true);
    expect(sources[0].write?.inputTemplate).toEqual({
      member_id: 'm1', op: 'set-text', config: {}, value: '$value',
    });
    expect(sources[2].write?.inputTemplate).toEqual({
      member_id: 'm1', op: 'set-presentation', config: { key: 'shape' }, value: '$value',
    });
  });

  it('a NEW family in DATA gets a resolver with ZERO code change (Generic Gate #1)', () => {
    const sets = fieldSets([
      FIELD_SET_RECORD,
      { payload: { kind: INSPECTION_FIELD_SET_KIND, family: 'family-from-2099', fields: [
        { id: 'anything', label: 'Anything', path: ['extra', 'anything'], write_op: 'set-presentation', write_config: { key: 'anything' } },
      ] } },
    ]);
    const registry = createBoardInspectionRegistry(() => item, sets);
    expect(resolveInspection(stamped('family-from-2099', 'm1'), registry)).toHaveLength(1);
  });

  it('no descriptor DATA → empty registry → honest zero sources', () => {
    const registry = createBoardInspectionRegistry(() => item, fieldSets([]));
    expect(resolveInspection(stamped('group.board-item', 'm1'), registry)).toEqual([]);
  });

  it('an unknown member resolves to nothing (no fabricated sources)', () => {
    const registry = createBoardInspectionRegistry(() => null, fieldSets());
    expect(resolveInspection(stamped('group.board-item', 'ghost'), registry)).toEqual([]);
  });

  it('record projection exposes the values the rows read', () => {
    expect(boardItemRecordProjection(item, '#ff8800')).toEqual({
      text: 'hello', fill: '#ff8800', extra: { shape: 'star' },
    });
  });
});

describe('board-inspection — write dispatch is registry lookup, never a branch', () => {
  it('routes to the op named by the descriptor row, passing value + config', async () => {
    const ops = createBoardWriteOpRegistry();
    const setPresentation = vi.fn(async () => {});
    ops.register('set-presentation', setPresentation);
    await dispatchBoardModelWrite(
      { member_id: 'm1', op: 'set-presentation', config: { key: 'shape' }, value: 'circle' },
      ops, 'no',
    );
    expect(setPresentation).toHaveBeenCalledWith('m1', 'circle', { key: 'shape' });
  });

  it('an op the host has no seam for is an honest error (fail-closed)', async () => {
    const ops = createBoardWriteOpRegistry();
    await expect(
      dispatchBoardModelWrite({ member_id: 'm1', op: 'op-from-2099', value: 1 }, ops, 'Not supported.'),
    ).rejects.toThrow('Not supported.');
  });

  it('malformed inputs fail closed (missing member/op)', async () => {
    const ops = createBoardWriteOpRegistry();
    ops.register('set-text', vi.fn(async () => {}));
    await expect(dispatchBoardModelWrite({}, ops, 'Not supported.')).rejects.toThrow();
    await expect(dispatchBoardModelWrite({ member_id: 'm1' }, ops, 'Not supported.')).rejects.toThrow();
  });

  it('a NEW op = one register() + one DATA row — dispatch untouched (Generic Gate #2)', async () => {
    const ops = createBoardWriteOpRegistry();
    const novel = vi.fn(async () => {});
    ops.register('rotate-by', novel);
    await dispatchBoardModelWrite({ member_id: 'm1', op: 'rotate-by', config: { degrees: 45 }, value: 45 }, ops, 'no');
    expect(novel).toHaveBeenCalledWith('m1', 45, { degrees: 45 });
  });
});
