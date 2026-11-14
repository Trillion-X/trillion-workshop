// packages/group/show/board-insight-lenses.test.ts
//
// Gate coverage for the extracted lens registry (show/board-insight-lenses.tsx). Before the extraction the 16
// availability gates lived inline in the 8000-line god panel and were exercised only by ONE fixed-board Chromium
// harness; as a pure builder they are testable over varied board states here. These tests pin the registry's
// STRUCTURAL contract (exactly 16 lenses, keys, groups) and the gate behavior for the stable cases: an empty
// board surfaces nothing, and a board of plain notes surfaces only the "has any card" lenses (not the
// data-dependent ones — due/metric/connectivity/etc.), which is what keeps the InsightsMenu honest (L118).
import { describe, it, expect } from 'vitest';
import type { AddressRef, GroupGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import type { BoardItem } from '../read-data/group-board-model';
import { boardInsightLenses, type BoardInsightLensCtx } from './board-insight-lenses';

const NOW = 1_800_000_000_000;

// A minimal content note — enough for the "has any card" gates, with none of the optional signal fields
// (no due date, metric, time log, habit, tags, connectors) so the data-dependent gates stay closed.
const note = (id: string): BoardItem => ({ memberId: id, x: 0, y: 0, w: 200, h: 160, text: id } as unknown as BoardItem);

// A context with inert stubs — the gates read only board DATA (nodeItems/items/now/rollupSpec); the callbacks
// and refs are never invoked because we assert on `available`/`group`/`label`, not on `render`.
const ctx = (nodeItems: BoardItem[], items: BoardItem[] = nodeItems): BoardInsightLensCtx => ({
  nodeItems,
  items,
  now: NOW,
  nodeRects: new Map(),
  frameRects: () => {},
  selectedIdsRef: { current: new Set() },
  setSelectedIds: () => {},
  commit: () => undefined,
  graphRef: { current: {} as GroupGraph },
  currentRefRef: { current: {} as AddressRef },
  applyBatch: () => {},
  reorderFrameById: () => {},
  rollupSpecRaw: undefined,
});

const availableKeys = (nodeItems: BoardItem[], items?: BoardItem[]): string[] =>
  boardInsightLenses(ctx(nodeItems, items)).filter((l) => l.available).map((l) => l.key);

describe('boardInsightLenses — structural contract', () => {
  it('returns exactly the 22 board lenses, in declared order, each tagged to one of the four groups', () => {
    const lenses = boardInsightLenses(ctx([note('a')]));
    expect(lenses.map((l) => l.key)).toEqual([
      'due', 'agenda', 'forecast', 'review', 'progress', 'time', 'streaks',
      'core', 'outline', 'critpath', 'readiness', 'questions', 'diversity', 'overview', 'breakdown', 'themes', 'composition', 'frames', 'tidiness', 'health', 'tagmap', 'hubs',
    ]);
    const GROUPS = new Set(['Deadlines', 'Momentum', 'Structure', 'Composition']);
    for (const l of lenses) expect(GROUPS.has(l.group ?? '')).toBe(true);
  });
});

describe('boardInsightLenses — availability gates', () => {
  it('surfaces NOTHING on an empty board (22 lenses returned, all unavailable)', () => {
    const lenses = boardInsightLenses(ctx([]));
    expect(lenses).toHaveLength(22);
    expect(lenses.every((l) => !l.available)).toBe(true);
  });

  it('a board of plain notes surfaces the "has any card" lenses + Overview + Board health (disconnected = a hygiene issue)', () => {
    // Composition/Frames/Tidiness/Tag map gate on nodeItems.length>0; Overview gates on cards>0 (vital signs of
    // any non-empty board); Outline treats a flat note list as a valid (connector-free) numbered outline; and
    // Board health surfaces because three UNCONNECTED notes are flagged as "orphans" (a real hygiene issue). The
    // rest stay closed — plain notes carry no dates/metrics/time/habits/endorsements/facet-spread/dependencies.
    expect(availableKeys([note('a'), note('b'), note('c')]).sort()).toEqual(['composition', 'frames', 'health', 'outline', 'overview', 'tagmap', 'tidiness']);
  });

  it('the Readiness lens reads dependencies from CONNECTORS in `items`, not the stripped `nodeItems` (Codex finding 1)', () => {
    // Two unfinished tasks; A depends-on B (a connector). B gates A → A is BLOCKED → Readiness must surface.
    // This ONLY works if the registry feeds the full `items` (connector included) to the graph engines; feeding
    // the connector-stripped `nodeItems` would leave the graph edgeless — no dependency, nothing ever "blocked".
    const metric = (id: string) => ({ memberId: id, x: 0, y: 0, w: 100, h: 40, text: id, extra: { metric: { current: 0, target: 10 } } } as unknown as BoardItem);
    const dep = { memberId: 'e', kind: 'connector', x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: 'A', toMemberId: 'B', relationKind: 'depends-on' } } as unknown as BoardItem;
    const tasks = [metric('A'), metric('B')];
    expect(availableKeys(tasks, [...tasks, dep])).toContain('readiness'); // connector present → dependency seen
    expect(availableKeys(tasks, tasks)).not.toContain('readiness');       // no connector → nothing blocks
  });

  it('the Core-ideas lens reads endorsement edges from CONNECTORS in `items`, not the stripped `nodeItems` (Codex finding 1, category sweep)', () => {
    // A points at B (a connector) → B gains an endorser → PageRank + endorsers are non-trivial → Core ideas
    // surfaces. Feeding the connector-stripped `nodeItems` would leave the graph edgeless: 0 endorsers for every
    // card → the gate `importance.some(r => r.endorsers > 0)` never fires and the lens could never appear.
    const idea = (id: string) => ({ memberId: id, x: 0, y: 0, w: 100, h: 40, text: id, extra: {} } as unknown as BoardItem);
    const edge = { memberId: 'e', kind: 'connector', x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: 'A', toMemberId: 'B', relationKind: 'relates-to' } } as unknown as BoardItem;
    const ideas = [idea('A'), idea('B')];
    expect(availableKeys(ideas, [...ideas, edge])).toContain('core'); // connector → B has an endorser
    expect(availableKeys(ideas, ideas)).not.toContain('core');        // no connector → no endorsers
  });

  it('the Hubs lens stays closed until the board has connectors (items > nodeItems)', () => {
    const nodes = [note('a'), note('b')];
    expect(availableKeys(nodes)).not.toContain('hubs'); // items === nodeItems
    // add a connector-ish extra item so items.length > nodeItems.length
    const withConnector = [...nodes, note('c')];
    expect(availableKeys(nodes, withConnector)).toContain('hubs');
  });
});
