// Proof for the checklist GRAPH bridge: checklists co-locate on the item as extra.checklist, mutations
// go through patchItem preserving other extra, connectors + furniture are never targets, rollup sums.
import { describe, expect, it } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import type { AddressRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { placeItem, readItems } from '../read-data/group-board-model';
import { AXIS_TICK_PREFIX } from './batch-actions';
import { checklistProgress } from '../read-data/board-checklist';
import {
  addStepToItem,
  boardChecklists,
  boardRollup,
  checklistOf,
  itemIsChecklistTarget,
  removeStepFromItem,
  renameStepOnItem,
  toggleStepOnItem,
} from './board-checklist-actions';

const PARENT: AddressRef = { family: 'test.board', parts: { board: 'b1' } };
const step = (id: string, text: string, done = false) => ({ id, text, done });

function board() {
  let g = emptyGraph();
  const put = (a: Record<string, unknown>) => (g = placeItem(g, PARENT, { nodeRef: { family: 't', parts: { id: a.memberId } }, w: 100, h: 60, ...a } as never));
  put({ memberId: 'goal', kind: 'note', x: 0, y: 0, text: 'Launch', extra: { fill: '#fff' } });
  put({ memberId: 'n2', kind: 'note', x: 200, y: 0, text: 'Other' });
  put({ memberId: 'edge', kind: 'connector', x: 0, y: 0, extra: { fromMemberId: 'goal', toMemberId: 'n2' } });
  put({ memberId: `${AXIS_TICK_PREFIX}x:10`, kind: 'note', x: 0, y: 400, text: '10', extra: { axisTick: true } });
  return g;
}

describe('board-checklist-actions — the graph bridge', () => {
  it('adding a step stores the checklist on the item as extra.checklist, preserving other extra', () => {
    let g = board();
    g = addStepToItem(g, PARENT, 'goal', step('s1', 'Write copy'));
    const goal = readItems(g, PARENT).find((it) => it.memberId === 'goal')!;
    expect(checklistOf(g, PARENT, 'goal').map((s) => s.text)).toEqual(['Write copy']);
    expect(goal.extra.fill).toBe('#fff'); // other extra untouched
  });

  it('toggle/rename/remove flow through patchItem and update progress', () => {
    let g = board();
    g = addStepToItem(g, PARENT, 'goal', step('s1', 'a'));
    g = addStepToItem(g, PARENT, 'goal', step('s2', 'b'));
    g = toggleStepOnItem(g, PARENT, 'goal', 's1');
    expect(checklistProgress(checklistOf(g, PARENT, 'goal'))).toMatchObject({ done: 1, total: 2 });
    g = renameStepOnItem(g, PARENT, 'goal', 's2', 'renamed');
    expect(checklistOf(g, PARENT, 'goal').find((s) => s.id === 's2')!.text).toBe('renamed');
    g = removeStepFromItem(g, PARENT, 'goal', 's1');
    expect(checklistOf(g, PARENT, 'goal').map((s) => s.id)).toEqual(['s2']);
  });

  it('itemIsChecklistTarget + boardChecklists exclude connectors and furniture', () => {
    let g = board();
    g = addStepToItem(g, PARENT, 'goal', step('s1', 'a'));
    const items = readItems(g, PARENT);
    const byId = (id: string) => items.find((it) => it.memberId === id)!;
    expect(itemIsChecklistTarget(byId('goal'))).toBe(true);
    expect(itemIsChecklistTarget(byId('edge'))).toBe(false);
    expect(itemIsChecklistTarget(byId(`${AXIS_TICK_PREFIX}x:10`))).toBe(false);
    // both content notes are targets; only 'goal' carries steps
    expect(boardChecklists(items).map((c) => c.id).sort()).toEqual(['goal', 'n2']);
  });

  it('boardRollup sums done/total across the whole board', () => {
    let g = board();
    g = addStepToItem(g, PARENT, 'goal', step('s1', 'a'));
    g = addStepToItem(g, PARENT, 'goal', step('s2', 'b'));
    g = toggleStepOnItem(g, PARENT, 'goal', 's1');
    g = addStepToItem(g, PARENT, 'n2', step('s3', 'c'));
    g = toggleStepOnItem(g, PARENT, 'n2', 's3');
    expect(boardRollup(readItems(g, PARENT))).toEqual({ done: 2, total: 3 });
  });
});
