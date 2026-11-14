// Proof for the DOCUMENT-EXPORT registry: both formats are present, each is a self-describing row
// {key,label,ext,mime,serialize}, and exportBoardAs dispatches to the right serializer (markdown vs ics)
// by DATA key — the generic dispatch never names a format.
import { describe, expect, it } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import type { AddressRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { placeItem, readItems } from '../read-data/group-board-model';
import { setItemDueDate } from './board-due-date-actions';
import { DOCUMENT_EXPORTS, documentExport, exportBoardAs, exportFilename } from './board-document-exports';

const NOW = 1_760_000_000_000;
const PARENT: AddressRef = { family: 'test.board', parts: { board: 'b1' } };

function board() {
  let g = emptyGraph();
  g = placeItem(g, PARENT, { nodeRef: { family: 't', parts: { id: 'a' } }, memberId: 'a', x: 0, y: 0, w: 100, h: 60, kind: 'note', text: 'Ship v1' } as never);
  g = setItemDueDate(g, PARENT, 'a', NOW + 86_400_000);
  return readItems(g, PARENT);
}

describe('board-document-exports — the export format registry', () => {
  it('carries the markdown + ics formats, each self-describing', () => {
    expect(DOCUMENT_EXPORTS.map((e) => e.key)).toEqual(['markdown', 'ics', 'csv', 'mermaid', 'status', 'summary', 'agenda', 'next-actions', 'graphml', 'questions', 'duplicate-titles', 'tag-hygiene', 'clusters', 'duplicate-connectors', 'opml', 'freemind', 'dot', 'sources-sinks', 'date-coverage', 'themes', 'links', 'split-candidates', 'tag-coverage', 'connector-legend', 'board-health', 'numbered-outline', 'color-legend', 'type-census', 'reading-order', 'tag-affinity', 'tag-balance', 'color-balance', 'tag-lift', 'tag-progress', 'color-progress', 'tag-deadline', 'progress-distribution', 'size-distribution', 'tag-color-matrix', 'kind-progress-matrix', 'cluster-sizes', 'cluster-progress']);
    for (const e of DOCUMENT_EXPORTS) {
      expect(typeof e.label).toBe('string');
      expect(typeof e.ext).toBe('string');
      expect(typeof e.mime).toBe('string');
      expect(typeof e.serialize).toBe('function');
    }
    expect(documentExport('ics')?.mime).toBe('text/calendar');
    expect(documentExport('nope')).toBeNull();
  });

  it('exportBoardAs dispatches to the right serializer by key', () => {
    const items = board();
    const md = exportBoardAs('markdown', items, NOW, { title: 'My Vision' });
    const ics = exportBoardAs('ics', items, NOW);
    expect(md.startsWith('# My Vision')).toBe(true);
    expect(md).toContain('- Ship v1');
    expect(ics.startsWith('BEGIN:VCALENDAR')).toBe(true);
    expect(ics).toContain('SUMMARY:Ship v1');
    expect(exportBoardAs('unknown', items, NOW)).toBe(''); // unknown format -> empty, no throw
  });

  it('exportFilename slugifies the title + appends the format extension', () => {
    expect(exportFilename('My Vision', 'md')).toBe('my-vision.md');
    expect(exportFilename('  A/B: C!! ', 'ics')).toBe('a-b-c.ics'); // non-alphanumerics collapse to dashes
    expect(exportFilename('', 'ics')).toBe('board.ics'); // blank -> fallback
    expect(exportFilename(undefined, 'md')).toBe('board.md');
  });
});
