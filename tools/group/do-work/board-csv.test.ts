// Proof for the board -> CSV export: a header row + one row per goal card (Title, Due, Progress %,
// Checklist Done/Total, Tags), progress as a bare number (spreadsheet-computable), RFC 4180 quoting of
// fields with commas/quotes, CRLF line endings, and sections/connectors/furniture skipped.
import { describe, expect, it } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import type { AddressRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { placeItem, placeSection, readItems } from '../read-data/group-board-model';
import { AXIS_TICK_PREFIX } from './batch-actions';
import { setItemMetric } from './board-metric-actions';
import { setItemDueDate } from './board-due-date-actions';
import { addStepToItem, toggleStepOnItem } from './board-checklist-actions';
import { dueMsToDateLabel } from '../read-data/board-due-date';
import { boardToCsv } from './board-csv';

const DAY = 86_400_000;
const NOW = 1_760_000_000_000;
const PARENT: AddressRef = { family: 'test.board', parts: { board: 'b1' } };
const csv = (g: ReturnType<typeof emptyGraph>) => boardToCsv(readItems(g, PARENT));
const put = (g: ReturnType<typeof emptyGraph>, a: Record<string, unknown>) =>
  placeItem(g, PARENT, { nodeRef: { family: 't', parts: { id: a.memberId } }, w: 100, h: 60, kind: 'note', ...a } as never);

describe('board-csv — spreadsheet export of goals', () => {
  it('always emits the header row, CRLF-joined', () => {
    expect(boardToCsv([])).toBe('Title,Due,Progress %,Checklist Done,Checklist Total,Tags');
    let g = emptyGraph();
    g = put(g, { memberId: 'a', x: 0, y: 0, text: 'x' });
    expect(csv(g).split('\r\n')[0]).toBe('Title,Due,Progress %,Checklist Done,Checklist Total,Tags');
  });

  it('a goal card row carries title, due (YYYY-MM-DD), numeric progress, checklist counts, and tags', () => {
    let g = emptyGraph();
    g = put(g, { memberId: 'save', x: 0, y: 0, text: 'Save money', extra: { tags: ['finance', 'q1'] } });
    g = setItemMetric(g, PARENT, 'save', { current: 8, target: 10 }); // 80
    g = setItemDueDate(g, PARENT, 'save', NOW + 3 * DAY);
    for (const s of ['open', 'auto']) g = addStepToItem(g, PARENT, 'save', { id: s, text: s, done: false });
    g = toggleStepOnItem(g, PARENT, 'save', 'open'); // 1/2
    const row = csv(g).split('\r\n')[1];
    expect(row).toBe(`Save money,${dueMsToDateLabel(NOW + 3 * DAY)},80,1,2,finance; q1`);
  });

  it('blank cells when a card has no due / no progress / no checklist / no tags', () => {
    let g = emptyGraph();
    g = put(g, { memberId: 'bare', x: 0, y: 0, text: 'Someday' });
    expect(csv(g).split('\r\n')[1]).toBe('Someday,,,,,');
  });

  it('quotes a title containing a comma or a quote (RFC 4180)', () => {
    let g = emptyGraph();
    g = put(g, { memberId: 'a', x: 0, y: 0, text: 'Plan A, B' });
    g = put(g, { memberId: 'b', x: 0, y: 100, text: 'She said "hi"' });
    const rows = csv(g).split('\r\n');
    expect(rows[1]).toBe('"Plan A, B",,,,,');
    expect(rows[2]).toBe('"She said ""hi""",,,,,');
  });

  it('sections, connectors, and furniture are not goal rows', () => {
    let g = emptyGraph();
    g = put(g, { memberId: 'real', x: 0, y: 0, text: 'Ship' });
    g = placeSection(g, PARENT, { memberId: 'sec', sectionNodeRef: { family: 's', parts: { id: 's' } }, x: 0, y: 200, text: 'Section' });
    g = put(g, { memberId: 'edge', x: 0, y: 0, kind: 'connector', extra: { fromMemberId: 'real', toMemberId: 'real' } });
    g = put(g, { memberId: `${AXIS_TICK_PREFIX}x:1`, x: 0, y: 9, text: '1', extra: { axisTick: true } });
    const rows = csv(g).split('\r\n');
    expect(rows).toHaveLength(2); // header + the one goal row
    expect(rows[1].startsWith('Ship,')).toBe(true);
  });
});
