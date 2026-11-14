// packages/group/read-data/saved-report-store.test.ts
//
// Proves b181's saved-report store (the second consumer of the generic named-record-index): the full save →
// read → RE-RUN pipeline (a persisted descriptor re-runs against the live board identically), fail-closed
// descriptor parsing, and that it is isolated from the collection store (different index family).

import { describe, it, expect } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import type { BoardItem } from './group-board-model';
import { runReport, type ReportDescriptor } from './board-report';
import {
  reportIndexRef, saveReport, readActiveReports, readArchivedReports, getReport, renameReport,
  archiveReport, restoreReport, parseReportDescriptor,
} from './saved-report-store';
import { readActiveCollections, collectionIndexRef } from './collection-store';

const INDEX = reportIndexRef();
const card = (memberId: string, tags: string[], metric?: { current: number; target: number }): BoardItem =>
  ({ memberId, kind: 'note', x: 0, y: 0, w: 100, h: 40, text: '', extra: { tags, ...(metric ? { metric } : {}) }, isSection: false } as unknown as BoardItem);
const board: BoardItem[] = [card('a', ['design'], { current: 8, target: 10 }), card('b', ['design'], { current: 4, target: 10 }), card('c', ['urgent'], { current: 3, target: 10 })];

describe('parseReportDescriptor — fail-closed', () => {
  it('requires a string reduction; other fields must be strings; drops unknown keys', () => {
    expect(parseReportDescriptor({ reduction: 'census', dimension: 'tag' })).toEqual({ reduction: 'census', dimension: 'tag' });
    expect(parseReportDescriptor({ reduction: 'pivot', dimension: 'tag', measure: 'progress', junk: 42 })).toEqual({ reduction: 'pivot', dimension: 'tag', measure: 'progress' });
    expect(parseReportDescriptor({ dimension: 'tag' })).toBeNull(); // no reduction
    expect(parseReportDescriptor({ reduction: 'census', dimension: 7 })).toBeNull(); // non-string field
    expect(parseReportDescriptor('nope')).toBeNull();
    expect(parseReportDescriptor(null)).toBeNull();
  });
});

describe('saved-report store — save → read → re-run pipeline', () => {
  it('a saved descriptor re-runs against the live board identically', () => {
    const desc: ReportDescriptor = { reduction: 'pivot', dimension: 'tag', measure: 'progress', aggregator: 'mean' };
    const g = saveReport(emptyGraph(), INDEX, { memberId: 'm1', reportId: 'r1', name: 'Progress by tag', descriptor: desc });
    const active = readActiveReports(g, INDEX);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ memberId: 'm1', reportId: 'r1', name: 'Progress by tag', archived: false });
    expect(active[0].descriptor).toEqual(desc); // round-trips exactly
    // the persisted descriptor produces the SAME report as the original when re-run
    expect(runReport(board, active[0].descriptor)).toBe(runReport(board, desc));
  });

  it('rename / archive / restore behave like any named record', () => {
    let g = saveReport(emptyGraph(), INDEX, { memberId: 'm1', reportId: 'r1', name: 'A', descriptor: { reduction: 'census', dimension: 'tag' } });
    g = renameReport(g, INDEX, 'm1', 'Renamed');
    expect(getReport(g, INDEX, 'm1')?.name).toBe('Renamed');
    g = archiveReport(g, INDEX, 'm1');
    expect(readActiveReports(g, INDEX)).toHaveLength(0);
    expect(readArchivedReports(g, INDEX).map((r) => r.name)).toEqual(['Renamed']);
    g = restoreReport(g, INDEX, 'm1');
    expect(readActiveReports(g, INDEX)).toHaveLength(1);
  });

  it('reports and collections are isolated (different index families)', () => {
    const g = saveReport(emptyGraph(), INDEX, { memberId: 'm1', reportId: 'r1', name: 'R', descriptor: { reduction: 'census', dimension: 'tag' } });
    // a report member does not leak into the collection store (which strictly parses BoardTemplates)
    expect(readActiveCollections(g, collectionIndexRef())).toHaveLength(0);
    expect(readActiveReports(g, INDEX)).toHaveLength(1);
  });
});
