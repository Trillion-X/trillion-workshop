// packages/group/do-work/nested-tree-xml.test.ts
//
// Proves b173's generative primitive: ONE nested-XML parser + serializer, configured by a NestedTreeSpec.
// Tested with TWO real dialects (OPML `<outline text>`, FreeMind `<node TEXT>`) AND a made-up dialect (the
// deletion test — a format the engine was never written for parses/serializes with zero engine change).

import { describe, it, expect } from '../../../../../test-helpers/vitest-shim.mjs';
import { parseNestedTree, outlineToNestedXml, escapeXml, unescapeXml, type NestedTreeSpec } from '../../../do-work/nested-tree-xml.ts';

const OPML: NestedTreeSpec = { tag: 'outline', textAttrs: ['text', 'title'] };
const FREEMIND: NestedTreeSpec = { tag: 'node', textAttrs: ['TEXT'] };

describe('parseNestedTree — one parser, many dialects', () => {
  it('OPML dialect: `<outline text>` nesting → depth-tagged lines', () => {
    const doc = '<opml><body><outline text="Root"><outline text="Child"/></outline></body></opml>';
    expect(parseNestedTree(doc, OPML)).toEqual([{ depth: 0, text: 'Root' }, { depth: 1, text: 'Child' }]);
  });

  it('FreeMind dialect: `<node TEXT>` nesting → the SAME shape, zero new parser code', () => {
    const doc = '<map version="1.0.1"><node TEXT="Root"><node TEXT="A"/><node TEXT="B"/></node></map>';
    expect(parseNestedTree(doc, FREEMIND)).toEqual([
      { depth: 0, text: 'Root' },
      { depth: 1, text: 'A' },
      { depth: 1, text: 'B' },
    ]);
  });

  it('textAttrs fallback order: OPML falls back to `title` when `text` is absent', () => {
    expect(parseNestedTree('<outline title="Only title"/>', OPML)).toEqual([{ depth: 0, text: 'Only title' }]);
  });

  it('DELETION TEST: a made-up dialect the engine never saw parses with zero engine change', () => {
    const spec: NestedTreeSpec = { tag: 'item', textAttrs: ['name'] };
    const doc = '<list><item name="Top"><item name="Sub"/></item></list>';
    expect(parseNestedTree(doc, spec)).toEqual([{ depth: 0, text: 'Top' }, { depth: 1, text: 'Sub' }]);
  });

  it('tolerates self-closing, reordered attrs, extra close tags (no negative depth), empty', () => {
    expect(parseNestedTree('</outline><outline text="ok"/>', OPML)).toEqual([{ depth: 0, text: 'ok' }]);
    expect(parseNestedTree('', OPML)).toEqual([]);
    expect(parseNestedTree(undefined as unknown as string, OPML)).toEqual([]);
  });
});

describe('outlineToNestedXml — the serializer (inverse of parseNestedTree)', () => {
  const lines = [
    { depth: 0, text: 'Root' },
    { depth: 1, text: 'Child A' },
    { depth: 2, text: 'Grandchild' },
    { depth: 1, text: 'Child B' },
  ];

  it('round-trips through EACH dialect: parse(serialize(lines)) === lines', () => {
    for (const spec of [OPML, FREEMIND]) {
      expect(parseNestedTree(outlineToNestedXml(lines, spec), spec)).toEqual(lines);
    }
  });

  it('writes the primary text attribute + the configured tag', () => {
    expect(outlineToNestedXml([{ depth: 0, text: 'X' }], FREEMIND)).toBe('<node TEXT="X">\n</node>');
    expect(outlineToNestedXml([{ depth: 0, text: 'X' }], OPML)).toBe('<outline text="X">\n</outline>');
  });

  it('XML-escapes special chars (round-trip safe)', () => {
    const l = [{ depth: 0, text: 'A & B <x> "q"' }];
    expect(parseNestedTree(outlineToNestedXml(l, OPML), OPML)).toEqual(l);
  });
});

describe('escapeXml / unescapeXml', () => {
  it('are inverse on the five predefined entities (no double-decode)', () => {
    const s = `A & B < > " ' &amp; already`;
    expect(unescapeXml(escapeXml(s))).toBe(s);
  });
});
