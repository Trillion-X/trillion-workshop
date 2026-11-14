// Proof that the document exports must be fed the FLATTENED board tree, not just the current level:
// a card nested inside a drill-in section is MISSING when exporting `readItems(current level)` and PRESENT
// when exporting `flattenBoardTree(root)`. This is the mechanism behind the GroupBoardPanel wiring fix
// (BoardExportPanel now receives flattenBoardTree(graph, currentRef), matching the SVG export path) — so
// Markdown / CSV / iCalendar / Status no longer silently drop section contents.
import { describe, expect, it } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import type { AddressRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { placeItem, placeSection, readItems } from '../read-data/group-board-model';
import { flattenBoardTree } from '../read-data/board-tree';
import { boardToMarkdown } from './board-markdown';
import { boardToCsv } from './board-csv';

const NOW = 1_760_000_000_000;
const ROOT: AddressRef = { family: 'test.board', parts: { board: 'b1' } };
const SEC: AddressRef = { family: 'test.section', parts: { id: 'sec' } };

function boardWithSectionChild() {
  let g = emptyGraph();
  // a root-level goal
  g = placeItem(g, ROOT, { nodeRef: { family: 't', parts: { id: 'root-goal' } }, memberId: 'root-goal', x: 0, y: 0, w: 100, h: 60, kind: 'note', text: 'Root goal' } as never);
  // a section, and a goal nested INSIDE it (placed into the section's child group)
  g = placeSection(g, ROOT, { memberId: 'sec', sectionNodeRef: SEC, x: 0, y: 200, text: 'This year' });
  g = placeItem(g, SEC, { nodeRef: { family: 't', parts: { id: 'nested-goal' } }, memberId: 'nested-goal', x: 0, y: 0, w: 100, h: 60, kind: 'note', text: 'Nested goal' } as never);
  return g;
}

describe('document exports over the board TREE (section children)', () => {
  it('current-level items DROP the nested goal; the flattened tree INCLUDES it (Markdown)', () => {
    const g = boardWithSectionChild();
    const currentLevel = readItems(g, ROOT);
    const flattened = flattenBoardTree(g, ROOT);

    // sanity: the nested goal is not at the current level, but is in the flattened tree
    expect(currentLevel.some((i) => i.memberId === 'nested-goal')).toBe(false);
    expect(flattened.some((i) => i.memberId === 'nested-goal')).toBe(true);

    expect(boardToMarkdown(currentLevel, NOW)).not.toContain('Nested goal'); // the BUG
    const md = boardToMarkdown(flattened, NOW); // the FIX
    expect(md).toContain('## This year');
    expect(md).toContain('- Nested goal');
    expect(md).toContain('- Root goal');
  });

  it('the flattened tree includes the nested goal as a CSV row (current level does not)', () => {
    const g = boardWithSectionChild();
    expect(boardToCsv(readItems(g, ROOT))).not.toContain('Nested goal');
    const csv = boardToCsv(flattenBoardTree(g, ROOT));
    expect(csv).toContain('Nested goal');
    expect(csv).toContain('Root goal');
  });
});
