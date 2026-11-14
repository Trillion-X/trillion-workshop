import { describe, it, expect } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { BOARD_TEMPLATES } from '../show/board-templates';
import { collectionIndexRef, saveCollection, archiveCollection, getCollection } from './collection-store';
import { applyTemplate } from './board-template-apply';
import { addBoard, boardIndexRef, boardRootRef, itemRef, placeItem, readBoards, readItems, boardToTemplate } from './group-board-model';
import { readSavedArrangementLibrary, duplicateSavedArrangement, saveBoardAsArrangement, resolveArrangementTemplate, readArrangementLensCatalog, searchArrangements, arrangementCategories, arrangementFacetValues, axisLensRow, timelineLensRow, lensRowFromSpec, BOARD_NUMERIC_FIELDS } from './saved-arrangement';
import type { SavedArrangement } from './saved-arrangement';
import type { TemplateItem, BoardTemplate } from './board-template-apply';

function mintSeq() {
  let n = 0;
  return () => `m${n++}`;
}
const tmpl = (id: string, name: string) => ({ id, name, items: [{ id: 'a', kind: 'note', x: 0, y: 0, w: 100, h: 100, text: id }] });

describe('readSavedArrangementLibrary — one projection over templates + collections', () => {
  it('includes every built-in template as an immutable, applicable row', () => {
    const cidx = collectionIndexRef('vb');
    const rows = readSavedArrangementLibrary(emptyGraph(), cidx);
    expect(rows.length).toBe(BOARD_TEMPLATES.length); // no collections yet → templates only
    const t = rows[0];
    expect(t.source).toBe('template');
    expect(t.id).toBe(`template:${BOARD_TEMPLATES[0].id}`);
    expect(t.capabilities).toEqual({ apply: true, rename: false, archive: false, duplicate: true });
    expect(t.payload).toBe(BOARD_TEMPLATES[0]); // the portable payload IS the template
  });

  it('merges saved collections after templates as mutable, store-backed rows', () => {
    const cidx = collectionIndexRef('vb');
    let g = saveCollection(emptyGraph(), cidx, { memberId: 'm1', collectionId: 'c1', name: 'My Stack', record: tmpl('c1', 'My Stack'), savedAt: 42 });
    const rows = readSavedArrangementLibrary(g, cidx);
    expect(rows.length).toBe(BOARD_TEMPLATES.length + 1);
    const col = rows.find((r) => r.source === 'collection')!;
    expect(col.id).toBe('collection:c1');
    expect(col.label).toBe('My Stack');
    expect(col.memberId).toBe('m1');
    expect(col.savedAt).toBe(42);
    expect(col.capabilities).toEqual({ apply: true, rename: true, archive: true, duplicate: true });
  });

  it('hides archived collections by default, includes them only when asked', () => {
    const cidx = collectionIndexRef('vb');
    let g = saveCollection(emptyGraph(), cidx, { memberId: 'm1', collectionId: 'c1', name: 'Live', record: tmpl('c1', 'Live') });
    g = saveCollection(g, cidx, { memberId: 'm2', collectionId: 'c2', name: 'Old', record: tmpl('c2', 'Old') });
    g = archiveCollection(g, cidx, 'm2');
    const active = readSavedArrangementLibrary(g, cidx, { includeTemplates: false });
    expect(active.map((r) => r.label)).toEqual(['Live']);
    const all = readSavedArrangementLibrary(g, cidx, { includeTemplates: false, includeArchived: true });
    expect(all.map((r) => r.label).sort()).toEqual(['Live', 'Old']);
    expect(all.find((r) => r.label === 'Old')!.archived).toBe(true);
  });

  it('includeTemplates:false yields only the store rows (collections library view)', () => {
    const cidx = collectionIndexRef('vb');
    const g = saveCollection(emptyGraph(), cidx, { memberId: 'm1', collectionId: 'c1', name: 'Solo', record: tmpl('c1', 'Solo') });
    const rows = readSavedArrangementLibrary(g, cidx, { includeTemplates: false });
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('collection');
  });
});

describe('§9.2 live facet lenses — DATA-driven (SSOT: the arrangement-lens-catalog record)', () => {
  const cidx = collectionIndexRef('vb');
  const targetItems: TemplateItem[] = [
    { id: 'a', kind: 'note', x: 0, y: 0, w: 100, h: 60, extra: { tags: ['red'] } },
    { id: 'b', kind: 'note', x: 0, y: 0, w: 100, h: 60, extra: { tags: ['blue'] } },
    { id: 'c', kind: 'note', x: 0, y: 0, w: 100, h: 60, extra: { tags: ['red'] } },
  ];
  // The catalog EXACTLY as published in group's things-to-store-and-run.json.
  const CATALOG = [{ facet: 'tag', label: 'Grouped by tag' }, { facet: 'kind', label: 'Grouped by kind' }, { facet: 'color', label: 'Grouped by color' }];

  it('readArrangementLensCatalog extracts lens specs from published records (kind-filtered)', () => {
    const records = [
      { payload: { kind: 'inspection-field-descriptor-set', family: 'x' } }, // ignored (wrong kind)
      { payload: { kind: 'arrangement-lens-catalog', lenses: CATALOG } },
      { payload: null },
    ];
    expect(readArrangementLensCatalog(records)).toEqual(CATALOG.map((l) => ({ ...l, category: 'Live lenses' })));
  });

  it('a malformed lens row (null / primitive / missing field) is skipped, never crashes (L083)', () => {
    // Untrusted DATA: a stray null lens used to throw via `l.facet`. Now the good rows survive.
    const records = [
      { payload: { kind: 'arrangement-lens-catalog', lenses: [null, 'nope', 7, { facet: 'tag' }, { facet: 'kind', label: 'By kind' }] } },
      { payload: { kind: 'arrangement-lens-catalog', lenses: 'not-an-array' } }, // ignored, no throw
    ];
    expect(readArrangementLensCatalog(records)).toEqual([{ facet: 'kind', label: 'By kind', category: 'Live lenses' }]);
  });

  it('the library renders one lens row per catalog entry (no catalog → no lenses)', () => {
    expect(readSavedArrangementLibrary(emptyGraph(), cidx).filter((r) => r.source === 'lens')).toEqual([]); // DATA-driven, no default
    const rows = readSavedArrangementLibrary(emptyGraph(), cidx, { lensCatalog: CATALOG });
    const lenses = rows.filter((r) => r.source === 'lens');
    expect(lenses.map((r) => r.label)).toEqual(['Grouped by tag', 'Grouped by kind', 'Grouped by color']);
    expect(lenses.every((r) => r.payload === undefined)).toBe(true); // live, not a snapshot
    expect(lenses.every((r) => r.capabilities.apply && !r.capabilities.duplicate)).toBe(true);
  });

  it('resolving a lens re-clusters the TARGET board items (snapshot ignores them)', () => {
    const tagLens = readSavedArrangementLibrary(emptyGraph(), cidx, { lensCatalog: CATALOG }).find((r) => r.id === 'lens:tag')!;
    const out = resolveArrangementTemplate(tagLens, targetItems);
    expect(out.items.map((i) => i.id).sort()).toEqual(['a', 'b', 'c']);
    const y = Object.fromEntries(out.items.map((i) => [i.id, i.y]));
    expect(y.a).toBe(y.c); // same tag cluster
    expect(y.b).not.toBe(y.a); // different cluster
  });

  it('resolving a snapshot row returns its stored template unchanged regardless of target', () => {
    const template = readSavedArrangementLibrary(emptyGraph(), cidx)[0];
    const out = resolveArrangementTemplate(template, targetItems);
    expect(out).toBe(template.payload); // constant producer — byte-identical, target ignored
  });
});

describe('an arrangement row applies onto a fresh board (the apply capability is real)', () => {
  it('a template row payload places via applyTemplate', () => {
    const cidx = collectionIndexRef('vb');
    const row = readSavedArrangementLibrary(emptyGraph(), cidx)[0];
    const bidx = boardIndexRef('t');
    const g = applyTemplate(emptyGraph(), bidx, { template: row.payload!, newBoardId: 'B1', newMemberId: 'mem', mint: mintSeq() });
    expect(readBoards(g, bidx).map((b) => b.boardId)).toContain('B1');
    expect(readItems(g, boardRootRef('B1')).length).toBeGreaterThan(0);
  });

  // §9.2 END-TO-END: the EXACT path GroupBoardPanel runs when a user clicks Use on a live
  // lens — boardToTemplate(current) → resolveArrangementTemplate(lens) → applyTemplate. Proves
  // the loop re-clusters a real graph by tag, not just the pure resolver in isolation.
  it('applying a live tag-lens re-clusters the CURRENT board onto a fresh board (full loop)', () => {
    const cidx = collectionIndexRef('vb');
    const bidx = boardIndexRef('t');
    let n = 0;
    const mint = () => `k${n++}`;
    // A source board with tagged notes at scattered positions (red, blue, red).
    const seed: BoardTemplate = {
      id: 'seed', name: 'Seed', items: [
        { id: 's1', kind: 'note', x: 400, y: 30, w: 120, h: 70, text: 'A', extra: { tags: ['red'] } },
        { id: 's2', kind: 'note', x: 40, y: 300, w: 120, h: 70, text: 'B', extra: { tags: ['blue'] } },
        { id: 's3', kind: 'note', x: 700, y: 500, w: 120, h: 70, text: 'C', extra: { tags: ['red'] } },
      ],
    };
    let g = applyTemplate(emptyGraph(), bidx, { template: seed, newBoardId: 'SRC', newMemberId: 'msrc', mint });
    // Panel path: read the current board's items, resolve the tag lens, apply to a new board.
    const currentItems = boardToTemplate(g, 'SRC');
    const tagLens = readSavedArrangementLibrary(g, cidx, { lensCatalog: [{ facet: 'tag', label: 'Grouped by tag' }] }).find((r) => r.id === 'lens:tag')!;
    const clustered = resolveArrangementTemplate(tagLens, currentItems);
    g = applyTemplate(g, bidx, { template: clustered, newBoardId: 'DST', newMemberId: 'mdst', mint });
    // The destination board carries the same three notes, re-clustered by tag: the two 'red'
    // notes share a y-band, the 'blue' note sits on a different band. (readItems flattens
    // presentation → x/y/text/isSection live at the top level of each row.)
    const dst = readItems(g, boardRootRef('DST')).filter((i) => !i.isSection);
    const byText = Object.fromEntries(dst.map((i) => [i.text, { x: i.x, y: i.y }]));
    expect(Object.keys(byText).sort()).toEqual(['A', 'B', 'C']);
    expect(byText.A.y).toBe(byText.C.y); // both 'red' → same cluster band
    expect(byText.B.y).not.toBe(byText.A.y); // 'blue' → different band
  });
});

describe('duplicateSavedArrangement — any source becomes a new editable collection', () => {
  it('duplicates a static template into a store-backed collection with fresh ids', () => {
    const cidx = collectionIndexRef('vb');
    const template = readSavedArrangementLibrary(emptyGraph(), cidx)[0];
    const g = duplicateSavedArrangement(emptyGraph(), cidx, template, { memberId: 'd1', collectionId: 'dup1', name: 'Copy of ' + template.label });
    const stored = getCollection(g, cidx, 'd1')!;
    expect(stored.name).toBe('Copy of ' + template.label);
    expect(stored.record.id).toBe('dup1');
    // the duplicate now shows up as a mutable collection row
    const rows = readSavedArrangementLibrary(g, cidx, { includeTemplates: false });
    expect(rows).toHaveLength(1);
    expect(rows[0].capabilities.rename).toBe(true);
  });
});

describe('saveBoardAsArrangement — snapshot a live board into the library (SSOT-engine payoff)', () => {
  const cidx = collectionIndexRef('vb');
  const bidx = boardIndexRef('vb');

  /** A live board: notes A,B + a connector A->B. */
  function liveBoard() {
    let g = emptyGraph();
    g = addBoard(g, bidx, { memberId: 'bm', boardId: 'live', title: 'Live' });
    const root = boardRootRef('live');
    g = placeItem(g, root, { memberId: 'A', nodeRef: itemRef('live', 'iA'), kind: 'note', x: 0, y: 0, w: 120, h: 80, text: 'A' });
    g = placeItem(g, root, { memberId: 'B', nodeRef: itemRef('live', 'iB'), kind: 'note', x: 200, y: 0, w: 120, h: 80, text: 'B' });
    g = placeItem(g, root, { memberId: 'C', nodeRef: itemRef('live', 'iC'), kind: 'connector', x: 0, y: 0, w: 1, h: 1, extra: { fromMemberId: 'A', toMemberId: 'B', label: 'rel' } });
    return g;
  }

  it('a snapshotted board becomes a mutable library row whose payload re-applies faithfully', () => {
    let g = liveBoard();
    g = saveBoardAsArrangement(g, cidx, 'live', { memberId: 'snap-m', collectionId: 'snap-c', name: 'My Board' });

    // It shows up in the library as a store-backed collection row (rename/archive/duplicate).
    const row = readSavedArrangementLibrary(g, cidx).find((r) => r.memberId === 'snap-m')!;
    expect(row).toBeTruthy();
    expect(row.label).toBe('My Board');
    expect(row.capabilities).toEqual({ apply: true, rename: true, archive: true, duplicate: true });
    // The payload captured the three items + the connector's from/to (by source id).
    expect(row.payload.items.map((i) => i.id).sort()).toEqual(['A', 'B', 'C']);
    const conn = row.payload.items.find((i) => i.id === 'C')!;
    expect(conn.from).toBe('A');
    expect(conn.to).toBe('B');

    // Re-apply the snapshot onto a FRESH board → the connector remaps to the new note ids.
    let n = 0;
    g = applyTemplate(g, bidx, { template: row.payload!, newBoardId: 're', newMemberId: 're-m', title: 'Reapplied', mint: () => `r${n++}` });
    const reItems = readItems(g, boardRootRef('re'));
    expect(reItems.filter((i) => !i.extra?.fromMemberId).map((i) => i.text).sort()).toEqual(['A', 'B']);
    const reConn = reItems.find((i) => i.extra?.fromMemberId)!;
    const reA = reItems.find((i) => i.text === 'A')!;
    expect(reConn.extra!.fromMemberId).toBe(reA.memberId);
    expect(reConn.extra!.fromMemberId).not.toBe('A'); // remapped, not dangling at the source
    expect(reConn.extra!.label).toBe('rel'); // non-id payload preserved

    // The SOURCE live board is untouched by the snapshot.
    expect(readItems(g, boardRootRef('live')).length).toBe(3);
  });
});

describe('searchArrangements + arrangementCategories (R4 library search/filter)', () => {
  const rows = [
    { id: 'r1', label: 'Kanban', source: 'template', archived: false, capabilities: { apply: true, rename: false, archive: false, duplicate: true }, category: 'Planning', description: 'Track work across columns', tags: ['tasks', 'agile'] },
    { id: 'r2', label: 'Brainstorm', source: 'template', archived: false, capabilities: { apply: true, rename: false, archive: false, duplicate: true }, category: 'Ideation', description: 'Rapid idea dump', tags: ['ideas', 'divergent'] },
    { id: 'r3', label: 'Weekly plan', source: 'template', archived: false, capabilities: { apply: true, rename: false, archive: false, duplicate: true }, category: 'Planning', description: 'Lay out the week', tags: ['schedule', 'agile'] },
  ] as const;

  it('arrangementCategories returns the distinct, sorted categories the rows carry (DATA, not hardcoded)', () => {
    expect(arrangementCategories(rows as unknown as SavedArrangement[])).toEqual(['Ideation', 'Planning']);
  });

  it('empty query → every row in original order', () => {
    expect(searchArrangements(rows as unknown as SavedArrangement[], {}).map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
  });

  it('keyword ranks a name hit above a tag/description hit', () => {
    // "plan" hits r3 name ("Weekly plan", weight 3) and r1 description? no. Only r3 name.
    expect(searchArrangements(rows as unknown as SavedArrangement[], { text: 'plan' }).map((r) => r.id)).toEqual(['r3']);
  });

  it('a keyword in a TAG surfaces the row (search hits tags, not just the label)', () => {
    const ids = searchArrangements(rows as unknown as SavedArrangement[], { text: 'agile' }).map((r) => r.id);
    expect(ids.sort()).toEqual(['r1', 'r3']); // both tagged 'agile'
  });

  it('a keyword in a DESCRIPTION surfaces the row', () => {
    expect(searchArrangements(rows as unknown as SavedArrangement[], { text: 'idea' }).map((r) => r.id)).toEqual(['r2']);
  });

  it('category filter narrows to that category (exact)', () => {
    expect(searchArrangements(rows as unknown as SavedArrangement[], { facets: { category: ['Planning'] } }).map((r) => r.id).sort()).toEqual(['r1', 'r3']);
  });

  it('category filter + keyword compose', () => {
    // 'agile' matches r1 + r3; Planning keeps both; but 'schedule' only r3.
    expect(searchArrangements(rows as unknown as SavedArrangement[], { text: 'schedule', facets: { category: ['Planning'] } }).map((r) => r.id)).toEqual(['r3']);
  });

  it('no match → empty', () => {
    expect(searchArrangements(rows as unknown as SavedArrangement[], { text: 'zzz' })).toEqual([]);
  });

  it('arrangementFacetValues(tag) lists the distinct tags the rows carry (the tag filter facet)', () => {
    expect(arrangementFacetValues(rows as unknown as SavedArrangement[], 'tag')).toEqual(['agile', 'divergent', 'ideas', 'schedule', 'tasks']);
  });

  it('arrangementFacetValues(category) matches arrangementCategories (one SSOT)', () => {
    const r = rows as unknown as SavedArrangement[];
    expect(arrangementFacetValues(r, 'category')).toEqual(arrangementCategories(r));
  });

  it('TAG facet — multi-value OR (Sam: searchable by tags, not just keywords)', () => {
    // tag ∈ {ideas, schedule} → r2 (ideas) OR r3 (schedule)
    expect(searchArrangements(rows as unknown as SavedArrangement[], { facets: { tag: ['ideas', 'schedule'] } }).map((r) => r.id).sort())
      .toEqual(['r2', 'r3']);
  });

  it('category AND tag compose (AND across facet keys)', () => {
    // Planning AND agile → r1, r3 (both Planning + agile-tagged)
    expect(searchArrangements(rows as unknown as SavedArrangement[], { facets: { category: ['Planning'], tag: ['agile'] } }).map((r) => r.id).sort())
      .toEqual(['r1', 'r3']);
    // Planning AND ideas → none (ideas is only on the Ideation row)
    expect(searchArrangements(rows as unknown as SavedArrangement[], { facets: { category: ['Planning'], tag: ['ideas'] } })).toEqual([]);
  });

  it('unknown facet key fails closed (no row silently passes)', () => {
    expect(searchArrangements(rows as unknown as SavedArrangement[], { facets: { author: ['nobody'] } })).toEqual([]);
  });
});

describe('§9.4/§9.5 continuous lenses — saveable + resolvable through the DEFAULT producers', () => {
  const cidx = collectionIndexRef();
  // A live board (portable TemplateItems) with varying size + kind, the target a lens re-lays.
  const targetItems: TemplateItem[] = [
    { id: 'a', kind: 'note', x: 0, y: 0, w: 40, h: 40, text: 'hi' },
    { id: 'b', kind: 'note', x: 0, y: 0, w: 200, h: 120, text: 'a much longer note body' },
    { id: 'c', kind: 'frame', x: 0, y: 0, w: 100, h: 60 },
  ];

  it('an AXIS lens row re-plots the board by size via DEFAULT_ARRANGEMENT_PRODUCERS (end-to-end)', () => {
    const row = axisLensRow('size');
    const tpl = resolveArrangementTemplate(row, targetItems); // uses the real default producer map
    const by = Object.fromEntries(tpl.items.map((i) => [i.id, i]));
    expect(tpl.items.map((i) => i.id).sort()).toEqual(['a', 'b', 'c']); // same items
    expect(by.b.x).toBeGreaterThan(by.a.x); // bigger area → further right
    expect(row.artifact?.producer.capability).toBe('axis-lens');
  });

  it('a ROADMAP lens row lays swimlanes by kind via the default producers (end-to-end)', () => {
    const row = timelineLensRow('size', 'kind');
    const tpl = resolveArrangementTemplate(row, targetItems);
    // cards are CENTRED on their lane band, so compare band centres (y + h/2), not top-left y.
    const cy = Object.fromEntries(tpl.items.map((i) => [i.id, i.y + i.h / 2]));
    expect(cy.a).toBe(cy.b); // both notes → same lane band centre
    expect(cy.c).not.toBe(cy.a); // frame → different lane band
    expect(row.artifact?.producer.capability).toBe('timeline-lens');
  });

  it('lens catalog DATA surfaces a generic {capability,input} lens (enum-dissolved, L090)', () => {
    // A DATA-authored roadmap lens (no code path per kind — the capability is DATA).
    const specs = readArrangementLensCatalog([
      { payload: { kind: 'arrangement-lens-catalog', lenses: [
        { facet: 'tag', label: 'By tag' }, // legacy shape still parses
        { capability: 'axis-lens', input: { xField: 'size' }, label: 'By size' }, // generic
      ] } },
    ]);
    expect(specs).toHaveLength(2);
    const rows = readSavedArrangementLibrary(emptyGraph(), cidx, { lensCatalog: specs });
    const bySize = rows.find((r) => r.label === 'By size')!;
    expect(bySize.source).toBe('lens');
    expect(bySize.artifact?.producer.capability).toBe('axis-lens');
    expect(bySize.artifact?.producer.input).toMatchObject({ xField: 'size' });
    // and it resolves end-to-end through the default producers
    const tpl = resolveArrangementTemplate(bySize, targetItems);
    expect(tpl.items).toHaveLength(3);
  });

  it('lensRowFromSpec drops a spec with neither facet nor capability (fail-closed)', () => {
    expect(lensRowFromSpec({ label: 'bad' })).toBeNull();
  });

  it('the lens rows are fully JSON-serialisable (persistable library rows)', () => {
    const row = timelineLensRow('size', 'kind', { label: 'Sprint roadmap' });
    expect(JSON.parse(JSON.stringify(row.artifact))).toEqual(row.artifact);
  });
});

describe('saved-arrangement red-team — untrusted persisted DATA hardening (cont.98 batch-30)', () => {
  const mkRow = (id: string, label: string): SavedArrangement => ({
    id, label, source: 'collection', archived: false,
    capabilities: { apply: true, rename: true, archive: true, duplicate: true },
  });

  // #1: a hostile arrangement-lens-catalog with millions of lenses must NOT `push(...spread)` (RangeError)
  // and is capped at MAX_LENSES.
  it('readArrangementLensCatalog caps a huge lenses array without RangeError', () => {
    const lenses = Array.from({ length: 20_000 }, (_, i) => ({ label: 'L' + i, facet: 'tag' }));
    const records = [{ payload: { kind: 'arrangement-lens-catalog', lenses } }];
    let specs: ReturnType<typeof readArrangementLensCatalog> | undefined;
    expect(() => { specs = readArrangementLensCatalog(records); }).not.toThrow();
    expect(specs!.length).toBeLessThanOrEqual(5000);
  });

  // #2: a huge lens catalog fed to the library is bounded by MAX_LIBRARY_ROWS (proves the no-spread
  // pushRow cap that also guards the persisted-collection spread).
  it('readSavedArrangementLibrary bounds a huge lens catalog to MAX_LIBRARY_ROWS without RangeError', () => {
    const lensCatalog = Array.from({ length: 200_000 }, (_, i) => ({ label: 'Lens ' + i, facet: 'tag' }));
    let rows: SavedArrangement[] = [];
    expect(() => { rows = readSavedArrangementLibrary(emptyGraph(), collectionIndexRef, { includeTemplates: false, lensCatalog }); }).not.toThrow();
    expect(rows.length).toBeLessThanOrEqual(100_000);
  });

  // #3: a persisted Number.MAX_VALUE geometry doesn't overflow the numeric `size` field to Infinity.
  it('BOARD_NUMERIC_FIELDS.size clamps a MAX_VALUE geometry to a finite coord', () => {
    const size = BOARD_NUMERIC_FIELDS.size({ kind: 'note', w: Number.MAX_VALUE, h: Number.MAX_VALUE } as unknown as TemplateItem);
    expect(size).not.toBeNull();
    expect(Number.isFinite(size as number)).toBe(true);
    expect(size as number).toBeLessThanOrEqual(1e7);
  });

  // #4: two rows sharing a raw id (a corrupted store can duplicate collectionId) both survive search —
  // neither is silently collapsed nor returned twice.
  it('searchArrangements does not collapse two rows that share an id', () => {
    const rows = [mkRow('collection:x', 'First'), mkRow('collection:x', 'Second')];
    const out = searchArrangements(rows, { text: '' }); // empty query → every row, order preserved
    expect(out.map((r) => r.label)).toEqual(['First', 'Second']);
  });

  // #5: a prototype-named facet key fails closed to [] (own-key lookup), never crashes on an inherited member.
  it('arrangementFacetValues fails closed on a prototype-named facet key', () => {
    const rows = [mkRow('a', 'A')];
    for (const facet of ['__proto__', 'constructor', 'hasOwnProperty', 'toString']) {
      expect(arrangementFacetValues(rows, facet)).toEqual([]);
    }
    // a real facet still resolves (zero regression)
    expect(Array.isArray(arrangementFacetValues(rows, 'category'))).toBe(true);
  });
});
