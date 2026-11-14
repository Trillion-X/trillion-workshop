// Proof for CSV IMPORT: parse an exported CSV back into card drafts (Title→text, Due→extra.dueDate,
// Progress %→extra.metric, Tags→extra.tags), match columns by header name, quote-aware RFC-4180 parsing,
// conservative detection, and a ROUND-TRIP with the b71 CSV export.
import { describe, expect, it } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import type { AddressRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { placeItem, readItems } from '../read-data/group-board-model';
import { setItemDueDate } from './board-due-date-actions';
import { setItemMetric } from './board-metric-actions';
import { boardToCsv } from './board-csv';
import { csvToDrafts, looksLikeCsv, parseCsvRows, MAX_CSV_ROWS } from './board-csv-import';

const PARENT: AddressRef = { family: 'test.board', parts: { board: 'b1' } };
const DUE_MS = Date.UTC(2026, 6, 8); // 2026-07-08

describe('board-csv-import — spreadsheet paste → cards', () => {
  it('parseCsvRows handles quoted fields (embedded comma / doubled quote), CRLF, and a missing final newline', () => {
    const rows = parseCsvRows('Title,Tags\r\n"a, b","x;y"\r\n"say ""hi""",z');
    expect(rows).toEqual([
      ['Title', 'Tags'],
      ['a, b', 'x;y'],
      ['say "hi"', 'z'],
    ]);
  });

  it('looksLikeCsv is true only for a titled header row (not a plain list or a Title-less CSV)', () => {
    expect(looksLikeCsv('Title,Due,Progress %\n Ship,,80')).toBe(true);
    expect(looksLikeCsv('buy milk\nwash car')).toBe(false); // no header / no comma
    expect(looksLikeCsv('Name,Age\nBob,3')).toBe(false); // comma but no Title column → not ours
  });

  it('maps Title→text, Due→dueDate, Progress %→metric, Tags→tags (columns matched by header name)', () => {
    const drafts = csvToDrafts('Title,Due,Progress %,Tags\r\nSave money,2026-07-08,80,finance; goals');
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toEqual({
      kind: 'note',
      text: 'Save money',
      extra: { dueDate: DUE_MS, metric: { current: 80, target: 100 }, tags: ['finance', 'goals'] },
    });
  });

  it('a reordered / extra-column CSV still imports (match by header, ignore unknown columns, blank cells)', () => {
    const drafts = csvToDrafts('Owner,Progress %,Title,Notes\r\nme,,Just a title,hi\r\nyou,25,With progress,ok');
    expect(drafts.map((d) => d.text)).toEqual(['Just a title', 'With progress']);
    expect(drafts[0].extra).toBeUndefined(); // no due/progress/tags → bare card
    expect(drafts[1].extra).toEqual({ metric: { current: 25, target: 100 } });
  });

  it('a row with a blank Title is skipped; the row count is capped', () => {
    expect(csvToDrafts('Title\n\nOnly one\n')).toHaveLength(1); // the empty-title row is dropped
    const many = ['Title', ...Array.from({ length: MAX_CSV_ROWS + 50 }, (_, i) => `item ${i}`)].join('\n');
    expect(csvToDrafts(many)).toHaveLength(MAX_CSV_ROWS);
  });

  it('a non-CSV / header-less text yields no drafts (caller falls through to plain paste)', () => {
    expect(csvToDrafts('just some text\nmore text')).toEqual([]);
    expect(csvToDrafts('')).toEqual([]);
  });

  it('ROUND-TRIP with the b71 export: place cards → boardToCsv → csvToDrafts recovers title/due/progress/tags', () => {
    let g = emptyGraph();
    g = placeItem(g, PARENT, { nodeRef: { family: 't', parts: { id: 'c' } }, memberId: 'c', x: 0, y: 0, w: 100, h: 60, kind: 'note', text: 'Save money', extra: { tags: ['finance', 'goals'] } } as never);
    g = setItemDueDate(g, PARENT, 'c', DUE_MS);
    g = setItemMetric(g, PARENT, 'c', { current: 8, target: 10 }); // 80%
    const csv = boardToCsv(readItems(g, PARENT));
    const drafts = csvToDrafts(csv);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].text).toBe('Save money');
    expect(drafts[0].extra).toEqual({ dueDate: DUE_MS, metric: { current: 80, target: 100 }, tags: ['finance', 'goals'] });
  });
});
