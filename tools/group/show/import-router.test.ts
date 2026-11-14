// Proof for the ONE import router shared by paste + file drop: routeImport maps text → a placement
// instruction (tree for markdown sections, drafts for section-less markdown / csv, null for unrecognized).
import { describe, expect, it } from 'vitest';
import { routeImport } from './import-router';

describe('import-router — the single paste/drop placement decision (L063)', () => {
  it('markdown WITH sections → a tree placement (placed hierarchically)', () => {
    const p = routeImport('## Goals\n- Ship it');
    expect(p?.kind).toBe('tree');
    if (p?.kind === 'tree') expect(p.nodes[0]).toMatchObject({ kind: 'section', text: 'Goals' });
  });

  it('section-less markdown (a task list) → a flat drafts placement (leading task = card, rest = its checklist)', () => {
    const p = routeImport('- [ ] milk\n- [x] eggs');
    expect(p?.kind).toBe('drafts');
    if (p?.kind === 'drafts') {
      expect(p.drafts).toHaveLength(1);
      expect(p.drafts[0].text).toBe('milk');
      expect(p.drafts[0].extra).toEqual({ checklist: [{ id: 'md-s1', text: 'eggs', done: true }] });
    }
  });

  it('a titled CSV → a flat drafts placement with mapped fields', () => {
    const p = routeImport('Title,Progress %\nSave money,80');
    expect(p?.kind).toBe('drafts');
    if (p?.kind === 'drafts') {
      expect(p.drafts).toEqual([{ kind: 'note', text: 'Save money', extra: { metric: { current: 80, target: 100 } } }]);
    }
  });

  it('a Mermaid flowchart → an items placement (a positioned node+connector board fragment)', () => {
    const p = routeImport('flowchart LR\n a["A"] --> b["B"]');
    expect(p?.kind).toBe('items');
    if (p?.kind === 'items') {
      const cards = p.items.filter((i) => !(i.extra as Record<string, unknown>).fromMemberId);
      const conns = p.items.filter((i) => (i.extra as Record<string, unknown>).fromMemberId);
      expect(cards.map((c) => c.text)).toEqual(['A', 'B']);
      expect(conns).toHaveLength(1);
    }
  });

  it('an iCalendar doc → a flat drafts placement (one dated card per VEVENT)', () => {
    const p = routeImport('BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART;VALUE=DATE:20260711\nSUMMARY:Buy a house\nEND:VEVENT\nEND:VCALENDAR');
    expect(p?.kind).toBe('drafts');
    if (p?.kind === 'drafts') {
      expect(p.drafts).toEqual([{ kind: 'note', text: 'Buy a house', extra: { dueDate: Date.UTC(2026, 6, 11) } }]);
    }
  });

  it('a plain brain-dump / plain bullet list → null (caller falls through to plain paste)', () => {
    expect(routeImport('buy milk\nwash car')).toBeNull();
    expect(routeImport('- milk\n- eggs')).toBeNull();
    expect(routeImport('')).toBeNull();
  });
});
