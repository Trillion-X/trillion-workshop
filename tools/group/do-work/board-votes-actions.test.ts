// Proof for the vote GRAPH bridge: tallies co-locate on the item as extra.votes, budget enforcement
// no-ops an over-budget cast, connectors + furniture are never targets, ranking carries item labels.
import { describe, expect, it } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import type { AddressRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { placeItem, readItems } from '../read-data/group-board-model';
import { AXIS_TICK_PREFIX } from './batch-actions';
import {
  boardTallies,
  castVoteOnItem,
  clearItemVotes,
  itemIsVoteTarget,
  itemVoteCount,
  tallyOf,
  voteRankingRows,
} from './board-votes-actions';

const PARENT: AddressRef = { family: 'test.board', parts: { board: 'b1' } };

function board() {
  let g = emptyGraph();
  const put = (a: Record<string, unknown>) => (g = placeItem(g, PARENT, { nodeRef: { family: 't', parts: { id: a.memberId } }, w: 100, h: 60, ...a } as never));
  put({ memberId: 'n1', kind: 'note', x: 0, y: 0, text: 'Idea A', extra: { fill: '#fff' } });
  put({ memberId: 'n2', kind: 'note', x: 200, y: 0, text: 'Idea B' });
  put({ memberId: 'edge', kind: 'connector', x: 0, y: 0, extra: { fromMemberId: 'n1', toMemberId: 'n2' } });
  put({ memberId: `${AXIS_TICK_PREFIX}x:10`, kind: 'note', x: 0, y: 400, text: '10', extra: { axisTick: true } });
  return g;
}

describe('board-votes-actions — the graph bridge', () => {
  it('casting stores the tally on the item as extra.votes, preserving other extra', () => {
    let g = board();
    g = castVoteOnItem(g, PARENT, 'n1', 'me', 1, 5);
    const n1 = readItems(g, PARENT).find((it) => it.memberId === 'n1')!;
    expect(tallyOf(g, PARENT, 'n1')).toEqual({ me: 1 });
    expect(n1.extra.fill).toBe('#fff'); // other extra untouched
    expect(itemVoteCount(g, PARENT, 'n1')).toBe(1);
  });

  it('enforces the per-actor budget across the board: an over-budget cast is a no-op', () => {
    let g = board();
    // Budget 3: spend all three on n1, then a 4th cast (n2) must be rejected.
    g = castVoteOnItem(g, PARENT, 'n1', 'me', 3, 3);
    expect(itemVoteCount(g, PARENT, 'n1')).toBe(3);
    const before = g;
    g = castVoteOnItem(g, PARENT, 'n2', 'me', 1, 3); // over budget → no-op
    expect(g).toBe(before);
    expect(itemVoteCount(g, PARENT, 'n2')).toBe(0);
    // a positive cast that only PARTIALLY fits is clamped to the remaining budget
    let g2 = castVoteOnItem(board(), PARENT, 'n1', 'me', 10, 3);
    expect(itemVoteCount(g2, PARENT, 'n1')).toBe(3);
  });

  it('retracting a vote is not budget-limited and frees the dot', () => {
    let g = board();
    g = castVoteOnItem(g, PARENT, 'n1', 'me', 3, 3); // budget spent
    g = castVoteOnItem(g, PARENT, 'n1', 'me', -1, 3); // retract → 2 spent
    expect(itemVoteCount(g, PARENT, 'n1')).toBe(2);
    g = castVoteOnItem(g, PARENT, 'n2', 'me', 1, 3); // now fits (1 free)
    expect(itemVoteCount(g, PARENT, 'n2')).toBe(1);
  });

  it('boardTallies + itemIsVoteTarget exclude connectors and furniture', () => {
    const items = readItems(board(), PARENT);
    const byId = (id: string) => items.find((it) => it.memberId === id)!;
    expect(itemIsVoteTarget(byId('n1'))).toBe(true);
    expect(itemIsVoteTarget(byId('edge'))).toBe(false);
    expect(itemIsVoteTarget(byId(`${AXIS_TICK_PREFIX}x:10`))).toBe(false);
    expect(boardTallies(items).map((t) => t.id).sort()).toEqual(['n1', 'n2']);
  });

  it('voteRankingRows: most-voted first with item labels; clearItemVotes empties one', () => {
    let g = board();
    g = castVoteOnItem(g, PARENT, 'n1', 'a', 1, 9);
    g = castVoteOnItem(g, PARENT, 'n2', 'a', 2, 9);
    g = castVoteOnItem(g, PARENT, 'n2', 'b', 1, 9);
    const rows = voteRankingRows(readItems(g, PARENT));
    expect(rows.map((r) => r.memberId)).toEqual(['n2', 'n1']); // n2=3, n1=1
    expect(rows[0].label).toBe('Idea B');
    expect(rows.map((r) => r.count)).toEqual([3, 1]);
    g = clearItemVotes(g, PARENT, 'n2');
    expect(itemVoteCount(g, PARENT, 'n2')).toBe(0);
    expect(voteRankingRows(readItems(g, PARENT)).map((r) => r.memberId)).toEqual(['n1']);
  });
});
