// Proof for the board -> MARKDOWN export: sections become ## headings, cards become - bullets with
// DATA-registry annotations (metric % / due), checklists become nested - [ ]/- [x] task lines, items emit
// in reading order (y then x), connectors + furniture are skipped, and a title becomes a leading # line.
import { describe, expect, it } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import type { AddressRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { placeItem, placeSection, readItems } from '../read-data/group-board-model';
import { AXIS_TICK_PREFIX } from './batch-actions';
import { setItemMetric } from './board-metric-actions';
import { setItemDueDate } from './board-due-date-actions';
import { addStepToItem, toggleStepOnItem } from './board-checklist-actions';
import { boardToMarkdown, boardTreeToMarkdown, cardAnnotations } from './board-markdown';

const DAY = 86_400_000;
const NOW = 1_760_000_000_000;
const PARENT: AddressRef = { family: 'test.board', parts: { board: 'b1' } };
const md = (g: ReturnType<typeof emptyGraph>, opts = {}) => boardToMarkdown(readItems(g, PARENT), NOW, opts);
const byId = (g: ReturnType<typeof emptyGraph>, id: string) => readItems(g, PARENT).find((it) => it.memberId === id)!;

function put(g: ReturnType<typeof emptyGraph>, a: Record<string, unknown>) {
  return placeItem(g, PARENT, { nodeRef: { family: 't', parts: { id: a.memberId } }, w: 100, h: 60, kind: 'note', ...a } as never);
}

describe('board-markdown — portable Markdown export', () => {
  it('an empty board exports an empty string', () => {
    expect(boardToMarkdown([], NOW)).toBe('');
  });

  it('a section is a ## heading and a note is a - bullet, in reading order (y then x)', () => {
    let g = emptyGraph();
    g = put(g, { memberId: 'b', x: 10, y: 200, text: 'Second' });
    g = placeSection(g, PARENT, { memberId: 'sec', sectionNodeRef: { family: 'sec', parts: { id: 'sec' } }, x: 0, y: 0, text: 'Goals' });
    g = put(g, { memberId: 'a', x: 10, y: 100, text: 'First' });
    expect(md(g)).toBe('## Goals\n\n- First\n- Second');
  });

  it('a checklist becomes nested - [ ] / - [x] task lines under its card', () => {
    let g = emptyGraph();
    g = put(g, { memberId: 'c', x: 0, y: 0, text: 'Launch' });
    for (const s of ['plan', 'build', 'ship']) g = addStepToItem(g, PARENT, 'c', { id: s, text: s, done: false });
    g = toggleStepOnItem(g, PARENT, 'c', 'plan'); // done
    expect(md(g)).toBe('- Launch\n  - [x] plan\n  - [ ] build\n  - [ ] ship');
  });

  it('metric % and due annotations come from the DATA registry, inline in parens', () => {
    let g = emptyGraph();
    g = put(g, { memberId: 'c', x: 0, y: 0, text: 'Save' });
    g = setItemMetric(g, PARENT, 'c', { current: 8, target: 10 }); // 80%
    g = setItemDueDate(g, PARENT, 'c', NOW + 3 * DAY); // in 3 days
    expect(md(g)).toBe('- Save (80% · due in 3 days)');
    // the annotation reader is the same list the line uses
    expect(cardAnnotations(byId(g, 'c'), NOW)).toEqual(['80%', 'due in 3 days']);
  });

  it('connectors and furniture (axis ticks) are skipped — content only', () => {
    let g = emptyGraph();
    g = put(g, { memberId: 'a', x: 0, y: 0, text: 'Keep' });
    g = put(g, { memberId: 'edge', x: 0, y: 0, kind: 'connector', extra: { fromMemberId: 'a', toMemberId: 'a' } });
    g = put(g, { memberId: `${AXIS_TICK_PREFIX}x:10`, x: 0, y: 400, text: '10', extra: { axisTick: true } });
    expect(md(g)).toBe('- Keep');
  });

  it('a title renders as a leading # line; an untitled card falls back to (untitled)', () => {
    let g = emptyGraph();
    g = put(g, { memberId: 'a', x: 0, y: 0, text: '   ' }); // blank -> (untitled)
    expect(md(g, { title: 'My Vision' })).toBe('# My Vision\n\n- (untitled)');
  });
});

describe('board-tree-markdown — hierarchy-correct export (section-nested cards stay under their heading)', () => {
  const ROOT: AddressRef = { family: 'test.board', parts: { board: 'tree' } };
  const put2 = (g: ReturnType<typeof emptyGraph>, ref: AddressRef, a: Record<string, unknown>) =>
    placeItem(g, ref, { nodeRef: { family: 't', parts: { id: a.memberId } }, w: 100, h: 60, kind: 'note', ...a } as never);

  it('a card nested inside a drill-in section lands UNDER its ## heading, not orphaned above it', () => {
    // The exact shape that broke the flat serializer: a root goal, a section below it, and a goal INSIDE
    // the section (its own local y is 0). A flat cross-level y-sort would emit the nested bullet before the
    // heading; the tree walker recurses per level so it lands after.
    const SEC: AddressRef = { family: 'test.section', parts: { id: 'sec' } };
    let g = emptyGraph();
    g = put2(g, ROOT, { memberId: 'root-goal', x: 0, y: 0, text: 'Root goal' });
    g = placeSection(g, ROOT, { memberId: 'sec', sectionNodeRef: SEC, x: 0, y: 200, text: 'This year' });
    g = put2(g, SEC, { memberId: 'nested-goal', x: 0, y: 0, text: 'Nested goal' });

    expect(boardTreeToMarkdown(g, ROOT, NOW)).toBe('- Root goal\n\n## This year\n\n- Nested goal');
    // the flat serializer over the same-level items would DROP the nested goal entirely (the b73 bug):
    expect(boardToMarkdown(readItems(g, ROOT), NOW)).toBe('- Root goal\n\n## This year');
  });

  it('nesting deepens the heading level (## -> ### ...) while cards stay at - regardless of depth', () => {
    const OUTER: AddressRef = { family: 'test.section', parts: { id: 'outer' } };
    const INNER: AddressRef = { family: 'test.section', parts: { id: 'inner' } };
    let g = emptyGraph();
    g = placeSection(g, ROOT, { memberId: 'outer', sectionNodeRef: OUTER, x: 0, y: 0, text: 'Life' });
    g = placeSection(g, OUTER, { memberId: 'inner', sectionNodeRef: INNER, x: 0, y: 0, text: 'Health' });
    g = put2(g, INNER, { memberId: 'g', x: 0, y: 0, text: 'Run a 10k' });
    expect(boardTreeToMarkdown(g, ROOT, NOW)).toBe('## Life\n\n### Health\n\n- Run a 10k');
  });

  it('a title becomes the # line and top-level sections start at ##', () => {
    const SEC: AddressRef = { family: 'test.section', parts: { id: 's' } };
    let g = emptyGraph();
    g = placeSection(g, ROOT, { memberId: 's', sectionNodeRef: SEC, x: 0, y: 0, text: 'Goals' });
    g = put2(g, SEC, { memberId: 'g', x: 0, y: 0, text: 'Ship it' });
    expect(boardTreeToMarkdown(g, ROOT, NOW, { title: 'My Vision' })).toBe('# My Vision\n\n## Goals\n\n- Ship it');
  });

  it('an empty board exports an empty string', () => {
    expect(boardTreeToMarkdown(emptyGraph(), ROOT, NOW)).toBe('');
  });
});
