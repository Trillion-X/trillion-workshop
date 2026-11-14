// packages/group/do-work/board-diff-actions.test.ts
import { describe, it, expect } from 'vitest';
import { boardStateFromTemplateItems, diffTemplates, templateDiffText } from 'trillion-workshop/tools/organize-the-sidebar/do-work/board-diff-actions.ts';
import type { TemplateItem } from '../read-data/board-template-apply';

const card = (id: string, text: string, x = 0, y = 0, extra?: Record<string, unknown>): TemplateItem =>
  ({ id, kind: 'note', x, y, w: 100, h: 40, text, ...(extra ? { extra } : {}) } as TemplateItem);
const section = (id: string, children: TemplateItem[]): TemplateItem =>
  ({ id, kind: 'note', x: 0, y: 0, w: 200, h: 200, children } as TemplateItem);

describe('boardStateFromTemplateItems', () => {
  it('keys by id with only defined fields (two textless cards compare equal)', () => {
    const st = boardStateFromTemplateItems([{ id: 'a', kind: 'note', x: 1, y: 2, w: 3, h: 4 } as TemplateItem]);
    expect(st.a).toEqual({ kind: 'note', x: 1, y: 2, w: 3, h: 4 });
  });
  it('flattens nested section children with a parent field', () => {
    const st = boardStateFromTemplateItems([section('s', [card('c', 'inside')])]);
    expect(st.s).toBeDefined();
    expect((st.c as Record<string, unknown>).parent).toBe('s');
  });
});

describe('diffTemplates', () => {
  it('detects add / remove / move / edit across two portable item lists', () => {
    const before = [card('a', 'Alpha', 0, 0), card('b', 'Beta', 10, 0), card('c', 'Gamma', 20, 0)];
    const after = [card('a', 'Alpha', 0, 0), card('b', 'Beta', 99, 0), card('c', 'Gamma renamed', 20, 0), card('d', 'Delta', 30, 0)];
    const diff = diffTemplates(before, after);
    expect(diff.added).toEqual(['d']);
    expect(diff.removed).toEqual([]);
    expect(diff.changed.find((x) => x.memberId === 'b')?.changedFields).toEqual(['x']);
    expect(diff.changed.find((x) => x.memberId === 'c')?.changedFields).toEqual(['text']);
  });
  it('a card moved into a section reads as a parent change', () => {
    const before = [card('c', 'wander'), section('s', [])];
    const after = [section('s', [card('c', 'wander')])];
    expect(diffTemplates(before, after).changed.find((x) => x.memberId === 'c')?.changedFields).toEqual(['parent']);
  });
});

describe('templateDiffText', () => {
  it('renders headline + Added/Removed/Changed sections by human field labels', () => {
    const before = [card('a', 'Alpha', 0, 0), card('gone', 'Old idea')];
    const after = [card('a', 'Alpha', 50, 60), card('new', 'Fresh idea')]; // a moved (x+y), gone removed, new added
    const text = templateDiffText(before, after, 'Since v1');
    expect(text).toContain('# Since v1');
    expect(text).toContain('1 added · 1 removed · 1 changed');
    expect(text).toContain('## Added (1)');
    expect(text).toContain('- Fresh idea');
    expect(text).toContain('## Removed (1)');
    expect(text).toContain('- Old idea');
    expect(text).toContain('## Changed (1)');
    expect(text).toContain('- Alpha — position'); // x+y collapse to one "position" label
  });
  it('is the honest "No changes" when identical', () => {
    const items = [card('a', 'Alpha')];
    expect(templateDiffText(items, items)).toBe('No changes');
    expect(templateDiffText(items, items, 'V')).toBe('# V\n\nNo changes');
  });
  it('style-only edit reads as "style"', () => {
    const before = [card('a', 'Alpha', 0, 0, { fill: 'red' })];
    const after = [card('a', 'Alpha', 0, 0, { fill: 'blue' })];
    expect(templateDiffText(before, after)).toContain('- Alpha — style');
  });
});
