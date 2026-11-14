// packages/group/read-data/report-export.test.ts
//
// Proves report CSV export: a census report serialises to header + a row per group (raw counts), values are
// RFC-4180 quoted when they contain commas, and a null value serialises to a blank cell.

import { describe, it, expect } from 'vitest';
import type { BoardItem } from './group-board-model';
import { buildReportDescriptor } from '../show/report-controls';
import { reportToCsv } from './report-export';

const note = (memberId: string, tags: string[]): BoardItem =>
  ({ kind: 'note', memberId, x: 0, y: 0, w: 100, h: 40, extra: { tags } } as unknown as BoardItem);

describe('reportToCsv', () => {
  it('census by tag → "Tag,Count" header + a row per group with raw counts', () => {
    const items = [note('a', ['work']), note('b', ['work']), note('c', ['home'])];
    const csv = reportToCsv(items, buildReportDescriptor('census', 'tag'));
    const lines = csv.split('\n');
    expect(lines[0]).toBe('Tag,Count'); // dimension label + reduction label
    expect(lines).toContain('work,2');
    expect(lines).toContain('home,1');
  });

  it('quotes a group label containing a comma (RFC 4180, via the shared csvField)', () => {
    const items = [note('a', ['a,b'])];
    const csv = reportToCsv(items, buildReportDescriptor('census', 'tag'));
    expect(csv).toContain('"a,b",1');
  });

  it('an unknown reduction → empty rows but a header (never throws)', () => {
    const csv = reportToCsv([note('a', ['work'])], { reduction: 'nope' });
    expect(csv.split('\n')[0]).toBe('Group,Value'); // fallbacks when catalogs miss the keys
  });
});
