// Proof for the DOCUMENT-IMPORT registry: the paste funnel is blind over DATA rows — detectImport picks the
// first format that recognizes the text (markdown → a tree that may carry sections; csv → flat drafts), and
// a plain brain-dump matches nothing (falls through to one-note-per-line).
import { describe, expect, it } from 'vitest';
import { DOCUMENT_IMPORTS, detectImport, IMPORT_TEXT_EXTENSIONS, isImportableTextFile } from './document-imports';

describe('document-imports — blind import registry (L069/L090)', () => {
  it('lists the shipped formats as DATA rows', () => {
    expect(DOCUMENT_IMPORTS.map((i) => i.key)).toEqual(['markdown', 'csv', 'mermaid', 'graphml', 'opml', 'freemind', 'dot', 'icalendar']);
  });

  it('a FreeMind .mm document is detected as freemind and parses to a positioned node+connector ITEMS fragment (b173)', () => {
    const doc = '<map version="1.0.1"><node TEXT="Root"><node TEXT="Child"/></node></map>';
    const imp = detectImport(doc);
    expect(imp?.key).toBe('freemind');
    const result = imp!.parse(doc);
    expect('items' in result).toBe(true);
    if ('items' in result) {
      const cards = result.items.filter((i) => !(i.extra as Record<string, unknown>).fromMemberId);
      expect(cards.map((c) => c.text)).toEqual(['Root', 'Child']);
      expect(result.items.some((i) => (i.extra as Record<string, unknown>).fromMemberId)).toBe(true);
    }
    expect(isImportableTextFile('map.mm')).toBe(true);
  });

  it('an OPML document is detected as opml and parses to a positioned node+connector ITEMS fragment (b172)', () => {
    const doc = '<opml><body><outline text="Root"><outline text="Child"/></outline></body></opml>';
    const imp = detectImport(doc);
    expect(imp?.key).toBe('opml');
    const result = imp!.parse(doc);
    expect('items' in result).toBe(true);
    if ('items' in result) {
      const cards = result.items.filter((i) => !(i.extra as Record<string, unknown>).fromMemberId);
      expect(cards.map((c) => c.text)).toEqual(['Root', 'Child']);
      expect(result.items.some((i) => (i.extra as Record<string, unknown>).fromMemberId)).toBe(true);
    }
    expect(isImportableTextFile('mymap.opml')).toBe(true);
  });

  it('a GraphML document is detected as graphml and parses to a positioned node+connector ITEMS fragment (b171)', () => {
    const doc = '<graphml><node id="n0"><data key="label">A</data></node><node id="n1"><data key="label">B</data></node>' +
      '<edge source="n0" target="n1"/></graphml>';
    const imp = detectImport(doc);
    expect(imp?.key).toBe('graphml');
    const result = imp!.parse(doc);
    expect('items' in result).toBe(true);
    if ('items' in result) {
      const cards = result.items.filter((i) => !(i.extra as Record<string, unknown>).fromMemberId);
      expect(cards.map((c) => c.text)).toEqual(['A', 'B']);
      expect(result.items.some((i) => (i.extra as Record<string, unknown>).fromMemberId)).toBe(true);
    }
    expect(isImportableTextFile('graph.graphml')).toBe(true);
  });

  it('a DOT/Graphviz document is detected as dot and parses to a positioned node+connector ITEMS fragment (b174)', () => {
    const doc = 'digraph G { A [label="Root"]; A -> B [label="has"]; }';
    const imp = detectImport(doc);
    expect(imp?.key).toBe('dot');
    const result = imp!.parse(doc);
    expect('items' in result).toBe(true);
    if ('items' in result) {
      const cards = result.items.filter((i) => !(i.extra as Record<string, unknown>).fromMemberId);
      expect(cards.map((c) => c.text)).toEqual(['Root', 'B']);
      expect(result.items.some((i) => (i.extra as Record<string, unknown>).fromMemberId)).toBe(true);
    }
    expect(isImportableTextFile('graph.dot')).toBe(true);
    expect(isImportableTextFile('graph.gv')).toBe(true);
  });

  it('a markdown doc (heading/task) is detected as markdown and parses to a TREE', () => {
    const imp = detectImport('## Goals\n- Ship it');
    expect(imp?.key).toBe('markdown');
    const result = imp!.parse('## Goals\n- Ship it');
    expect('tree' in result).toBe(true);
    if ('tree' in result) {
      expect(result.tree[0]).toMatchObject({ kind: 'section', text: 'Goals' });
    }
  });

  it('a titled CSV is detected as csv and parses to flat DRAFTS', () => {
    const doc = 'Title,Progress %\nSave money,80';
    const imp = detectImport(doc);
    expect(imp?.key).toBe('csv');
    const result = imp!.parse(doc);
    expect('drafts' in result).toBe(true);
    if ('drafts' in result) {
      expect(result.drafts).toEqual([{ kind: 'note', text: 'Save money', extra: { metric: { current: 80, target: 100 } } }]);
    }
  });

  it('a Mermaid flowchart is detected as mermaid and parses to a positioned node+connector ITEMS fragment', () => {
    const doc = 'flowchart TD\n a["A"] --> b["B"]';
    const imp = detectImport(doc);
    expect(imp?.key).toBe('mermaid');
    const result = imp!.parse(doc);
    expect('items' in result).toBe(true);
    if ('items' in result) {
      const cards = result.items.filter((i) => !(i.extra as Record<string, unknown>).fromMemberId);
      expect(cards.map((c) => c.text)).toEqual(['A', 'B']);
      expect(result.items.some((i) => (i.extra as Record<string, unknown>).fromMemberId)).toBe(true);
    }
  });

  it('an iCalendar doc is detected as icalendar and parses to dated DRAFTS', () => {
    const doc = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART;VALUE=DATE:20260711\nSUMMARY:Ship it\nEND:VEVENT\nEND:VCALENDAR';
    const imp = detectImport(doc);
    expect(imp?.key).toBe('icalendar');
    const result = imp!.parse(doc);
    expect('drafts' in result).toBe(true);
    if ('drafts' in result) {
      expect(result.drafts).toEqual([{ kind: 'note', text: 'Ship it', extra: { dueDate: Date.UTC(2026, 6, 11) } }]);
    }
  });

  it('a plain brain-dump / plain bullet list matches NO format (falls through to plain paste)', () => {
    expect(detectImport('buy milk\nwash car')).toBeNull();
    expect(detectImport('- milk\n- eggs')).toBeNull(); // plain bullets, no checkbox, no Title header
  });

  it('every format row declares its file extensions (the SSOT for the picker + drop test)', () => {
    for (const imp of DOCUMENT_IMPORTS) expect(imp.extensions.length).toBeGreaterThan(0);
    // IMPORT_TEXT_EXTENSIONS = every row's extensions + plain txt, no dots.
    expect(IMPORT_TEXT_EXTENSIONS).toEqual(['md', 'markdown', 'csv', 'mmd', 'mermaid', 'graphml', 'xml', 'opml', 'mm', 'dot', 'gv', 'ics', 'ical', 'txt']);
  });

  it('isImportableTextFile matches registered extensions + txt, rejects media / extensionless', () => {
    expect(isImportableTextFile('goals.md')).toBe(true);
    expect(isImportableTextFile('deadlines.ics')).toBe(true);
    expect(isImportableTextFile('FLOW.MMD')).toBe(true); // case-insensitive
    expect(isImportableTextFile('braindump.txt')).toBe(true);
    expect(isImportableTextFile('photo.png')).toBe(false);
    expect(isImportableTextFile('README')).toBe(false); // no extension
  });
});
