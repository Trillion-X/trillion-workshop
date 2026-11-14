// packages/group/do-work/board-svg.test.ts
//
// Pure proof of the board EXPORT CONTRACT (`boardToSvg`). Because the export
// contract is a deterministic string serializer (Codex's "model -> SVG, never
// DOM-snapshot" decision), the whole capability is provable here with zero DOM.

import { describe, expect, it } from 'vitest';
import { boardToSvg, escapeXml, exportFillOf, type BoardSvgStyle } from './board-svg';
import { shapeSvgPathById, shapeOutlineById } from '../show/board-shapes';
import type { BoardItem } from '../read-data/group-board-model';

function item(partial: Partial<BoardItem> & { memberId: string }): BoardItem {
  return {
    nodeRef: { family: 'group.board-item', parts: { board: 'b', item: partial.memberId } },
    kind: 'note',
    x: 0,
    y: 0,
    w: 200,
    h: 140,
    isSection: false,
    childCount: 0,
    extra: {},
    ...partial,
  };
}

describe('escapeXml', () => {
  it('escapes the five XML metacharacters', () => {
    expect(escapeXml(`a & b < c > d " e ' f`)).toBe('a &amp; b &lt; c &gt; d &quot; e &apos; f');
  });
});

describe('boardToSvg — viewBox', () => {
  it('frames the bounding box of all drawables plus padding', () => {
    const svg = boardToSvg(
      [
        item({ memberId: 'a', x: 100, y: 50, w: 200, h: 100 }),
        item({ memberId: 'b', x: 400, y: 300, w: 100, h: 100 }),
      ],
      { padding: 10 },
    );
    // bbox = x[100..500], y[50..400] => 400 x 350; +10 padding each side.
    expect(svg).toContain('viewBox="90 40 420 370"');
  });

  it('falls back to a default viewBox when there are no drawables', () => {
    const svg = boardToSvg([], { padding: 0 });
    expect(svg).toContain('viewBox="0 0 800 600"');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
  });
});

describe('boardToSvg — item facets (blind, kind-agnostic)', () => {
  it('always emits a rect at the item geometry', () => {
    const svg = boardToSvg([item({ memberId: 'a', x: 12, y: 34, w: 56, h: 78 })]);
    expect(svg).toContain('<rect x="12" y="34" width="56" height="78"');
  });

  it('emits escaped text content as tspans inside a text element', () => {
    const svg = boardToSvg([item({ memberId: 'a', text: 'Ship it <now> & soon' })]);
    expect(svg).toContain('<text');
    expect(svg).toContain('Ship it &lt;now&gt; &amp; soon');
  });

  it('emits an <image href> for an item carrying a src, with no text element', () => {
    const svg = boardToSvg([item({ memberId: 'a', kind: 'media', src: 'data:image/png;base64,AAAA' })]);
    expect(svg).toContain('<image href="data:image/png;base64,AAAA"');
    expect(svg).not.toContain('<text');
  });

  it('renders BOTH image and text when both facets are present (no kind branch)', () => {
    const svg = boardToSvg([item({ memberId: 'a', kind: 'whatever-new-kind', src: 'data:x', text: 'caption' })]);
    expect(svg).toContain('<image href="data:x"');
    expect(svg).toContain('caption');
  });

  it('escapes a memberId with XML metacharacters in the clipPath id (SSOT escaping)', () => {
    const svg = boardToSvg([item({ memberId: 'x<y>&z', src: 'data:x' })]);
    expect(svg).toContain('id="clip-x&lt;y&gt;&amp;z"');
    expect(svg).toContain('clip-path="url(#clip-x&lt;y&gt;&amp;z)"');
  });

  it('omits text for a whitespace-only string', () => {
    const svg = boardToSvg([item({ memberId: 'a', text: '   ' })]);
    expect(svg).not.toContain('<text');
  });

  it('#204: a stamp exports its emoji glyph as <text> for FREE (no exporter kind-branch)', () => {
    // The stamp tool stores its glyph in `text` precisely so the blind exporter draws
    // it — proving the #204 export-completeness claim end to end with a concrete glyph.
    const svg = boardToSvg([item({ memberId: 'a', kind: 'stamp', text: '🔥' })]);
    expect(svg).toContain('<text');
    expect(svg).toContain('🔥');
  });
});

describe('boardToSvg — connectors', () => {
  it('draws a routed <path> (not a naive center line) with the default end arrow (#224)', () => {
    const svg = boardToSvg([
      item({ memberId: 'A', x: 0, y: 0, w: 100, h: 100 }),
      item({ memberId: 'B', x: 200, y: 200, w: 100, h: 100 }),
      item({ memberId: 'c1', kind: 'connector', extra: { fromMemberId: 'A', toMemberId: 'B' } }),
    ]);
    // #224: exports the SAME connectorPath the live layer uses — a <path>, never a <line>.
    expect(svg).not.toContain('<line');
    expect(svg).toContain('<path d="');
    expect(svg).toContain('fill="none"');
    // Default weight 2px, default arrow 'end' → marker-end, no marker-start.
    expect(svg).toContain('stroke-width="2"');
    expect(svg).toContain('marker-end="url(#board-conn-arrow-0)"');
    expect(svg).not.toContain('marker-start=');
    // One per-color arrow marker def is emitted (explicit fill, not context-stroke).
    expect(svg).toContain('<marker id="board-conn-arrow-0"');
    expect(svg).toContain('<path d="M 0 0 L 10 5 L 0 10 z" fill="#6b7280"/>');
  });

  it('carries the connector line weight DATA into the exported path (#197/#224)', () => {
    const svg = boardToSvg([
      item({ memberId: 'A', x: 0, y: 0, w: 100, h: 100 }),
      item({ memberId: 'B', x: 200, y: 200, w: 100, h: 100 }),
      item({ memberId: 'c1', kind: 'connector', extra: { fromMemberId: 'A', toMemberId: 'B', thickness: 5 } }),
    ]);
    expect(svg).toContain('stroke-width="5"');
  });

  it('exports dashed / arrow / color / label connector DATA (#224 live == export)', () => {
    const svg = boardToSvg([
      item({ memberId: 'A', x: 0, y: 0, w: 100, h: 100 }),
      item({ memberId: 'B', x: 400, y: 0, w: 100, h: 100 }),
      item({
        memberId: 'c1',
        kind: 'connector',
        extra: { fromMemberId: 'A', toMemberId: 'B', dashed: true, arrow: 'both', color: '#ff0066', label: 'leads to' },
      }),
    ]);
    expect(svg).toContain('stroke-dasharray="7 5"');
    // arrow:'both' → BOTH markers, colored with the connector's own color.
    expect(svg).toContain('marker-end="url(#board-conn-arrow-0)"');
    expect(svg).toContain('marker-start="url(#board-conn-arrow-0)"');
    expect(svg).toContain('stroke="#ff0066"');
    expect(svg).toContain('<path d="M 0 0 L 10 5 L 0 10 z" fill="#ff0066"/>');
    // Label chip: a text element with the label + a rounded backing rect.
    expect(svg).toContain('>leads to</text>');
    expect(svg).toContain('text-anchor="middle"');
  });

  it('a TYPED connector (relationKind, NO explicit label) exports its catalog label — live == export (ML085)', () => {
    // Before cont.47 the export read only extra.label, so a depends-on line exported BARE while the
    // live layer showed "depends on". Now both resolve through connectorLabelOf → the label chip.
    const svg = boardToSvg([
      item({ memberId: 'A', x: 0, y: 0, w: 100, h: 100 }),
      item({ memberId: 'B', x: 400, y: 0, w: 100, h: 100 }),
      item({ memberId: 'c1', kind: 'connector', extra: { fromMemberId: 'A', toMemberId: 'B', relationKind: 'depends-on' } }),
    ]);
    expect(svg).toContain('>depends on</text>'); // the catalog label, resolved from relationKind
  });

  it('an explicit empty label SUPPRESSES the chip even with a relationKind (consistent live/export)', () => {
    const svg = boardToSvg([
      item({ memberId: 'A', x: 0, y: 0, w: 100, h: 100 }),
      item({ memberId: 'B', x: 400, y: 0, w: 100, h: 100 }),
      item({ memberId: 'c1', kind: 'connector', extra: { fromMemberId: 'A', toMemberId: 'B', relationKind: 'depends-on', label: '' } }),
    ]);
    expect(svg).not.toContain('</text>'); // no connector label chip (a note-less board → no text at all)
  });

  it("arrow:'none' emits neither marker", () => {
    const svg = boardToSvg([
      item({ memberId: 'A', x: 0, y: 0, w: 100, h: 100 }),
      item({ memberId: 'B', x: 400, y: 0, w: 100, h: 100 }),
      item({ memberId: 'c1', kind: 'connector', extra: { fromMemberId: 'A', toMemberId: 'B', arrow: 'none' } }),
    ]);
    expect(svg).not.toContain('marker-end=');
    expect(svg).not.toContain('marker-start=');
  });

  it('passes an UNKNOWN routing string straight through (enum-dissolution — no narrowing to a closed list)', () => {
    // A routing the export never heard of must not throw or be dropped — connectorPath
    // falls back to straight for unknown, and the export renders whatever path it returns.
    const svg = boardToSvg([
      item({ memberId: 'A', x: 0, y: 0, w: 100, h: 100 }),
      item({ memberId: 'B', x: 400, y: 0, w: 100, h: 100 }),
      item({ memberId: 'c1', kind: 'connector', extra: { fromMemberId: 'A', toMemberId: 'B', routing: 'some-future-routing' } }),
    ]);
    expect(svg).toContain('<path d="');
  });

  it('skips a connector with a dangling endpoint — no path, no marker def (honest degradation)', () => {
    const svg = boardToSvg([
      item({ memberId: 'A', x: 0, y: 0, w: 100, h: 100 }),
      item({ memberId: 'c1', kind: 'connector', extra: { fromMemberId: 'A', toMemberId: 'GONE' } }),
    ]);
    expect(svg).not.toContain('<line');
    expect(svg).not.toContain('marker-end');
    expect(svg).not.toContain('<defs>');
  });

  it('does not let a connector contribute to the bounding box (only drawables do)', () => {
    // The connector has default geometry 0,0,200,140 but must not expand the box
    // beyond the single drawable at 1000,1000.
    const svg = boardToSvg(
      [
        item({ memberId: 'A', x: 1000, y: 1000, w: 100, h: 100 }),
        item({ memberId: 'c1', kind: 'connector', x: 0, y: 0, extra: { fromMemberId: 'A', toMemberId: 'A' } }),
      ],
      { padding: 0 },
    );
    expect(svg).toContain('viewBox="1000 1000 100 100"');
  });
});

describe('boardToSvg — injected fillOf resolver', () => {
  it('honors the owner-supplied fill/stroke/opacity/radius', () => {
    const fillOf = (it: BoardItem): BoardSvgStyle | undefined =>
      it.memberId === 'a' ? { fill: '#ff0000', stroke: '#00ff00', strokeWidth: 3, cornerRadius: 20, opacity: 0.5 } : undefined;
    const svg = boardToSvg([item({ memberId: 'a' })], { fillOf });
    expect(svg).toContain('fill="#ff0000"');
    expect(svg).toContain('stroke="#00ff00"');
    expect(svg).toContain('stroke-width="3"');
    expect(svg).toContain('rx="20"');
    expect(svg).toContain('opacity="0.5"');
  });

  it('uses the neutral default style when fillOf is absent', () => {
    const svg = boardToSvg([item({ memberId: 'a' })]);
    expect(svg).toContain('fill="#fffdf5"');
    expect(svg).toContain('rx="8"');
  });
});

describe('boardToSvg — background', () => {
  it('paints a full-viewBox background rect when a background is supplied', () => {
    const svg = boardToSvg([item({ memberId: 'a', x: 0, y: 0, w: 100, h: 100 })], { padding: 0, background: '#101010' });
    expect(svg).toContain('<rect x="0" y="0" width="100" height="100" fill="#101010"/>');
  });
});

describe('boardToSvg — opaque overlay (#168, e.g. drawing ink)', () => {
  const INK = '<polyline points="10,10 90,90" stroke="#ef4444" stroke-width="3" fill="none"/>';

  it('composes the overlay fragment VERBATIM, ABOVE the items (last in the doc)', () => {
    const svg = boardToSvg([item({ memberId: 'a', x: 0, y: 0, w: 100, h: 100 })], { padding: 0, overlay: { svg: INK } });
    expect(svg).toContain(INK); // verbatim — the board never parses it (L090)
    // The overlay appears AFTER the item rect (drawn on top) and before </svg>.
    expect(svg.indexOf(INK)).toBeGreaterThan(svg.indexOf('width="100" height="100"'));
    expect(svg.indexOf(INK)).toBeLessThan(svg.indexOf('</svg>'));
  });

  it('expands the viewBox to include overlay bounds so ink outside the item box is not clipped', () => {
    // Item at 0,0,100,100; ink extends to 300,300 → viewBox must reach 300.
    const svg = boardToSvg([item({ memberId: 'a', x: 0, y: 0, w: 100, h: 100 })], {
      padding: 0,
      overlay: { svg: INK, bounds: { minX: 0, minY: 0, maxX: 300, maxY: 300 } },
    });
    expect(svg).toContain('viewBox="0 0 300 300"');
  });

  it('frames an INK-ONLY board (no items) from the overlay bounds alone', () => {
    const svg = boardToSvg([], { padding: 0, overlay: { svg: INK, bounds: { minX: 10, minY: 20, maxX: 110, maxY: 220 } } });
    expect(svg).toContain('viewBox="10 20 100 200"');
    expect(svg).toContain(INK);
  });

  it('no overlay → output carries no stray fragment (additive, opt-in)', () => {
    const svg = boardToSvg([item({ memberId: 'a', x: 0, y: 0, w: 100, h: 100 })], { padding: 0 });
    expect(svg).not.toContain('<polyline');
    expect(svg).toContain('viewBox="0 0 100 100"'); // unchanged box math
  });
});

describe('exportFillOf — the default frame→style resolver', () => {
  const withFrame = (frame: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    item({ memberId: 'x', extra: { visualLayerStack: { frame }, ...extra } });

  it('a bare item (no visualLayerStack) → undefined (no style attributes emitted)', () => {
    expect(exportFillOf(item({ memberId: 'x' }))).toBeUndefined();
  });

  it('maps frame.opacity and frame.cornerRadius through', () => {
    expect(exportFillOf(withFrame({ opacity: 0.5, cornerRadius: 12 }))).toEqual({ opacity: 0.5, cornerRadius: 12 });
  });

  it('maps a frame border → stroke (+ strokeWidth when numeric)', () => {
    expect(exportFillOf(withFrame({ border: { color: '#ef4444', width: 3 } }))).toEqual({ stroke: '#ef4444', strokeWidth: 3 });
    // color without a numeric width → stroke only (no strokeWidth).
    expect(exportFillOf(withFrame({ border: { color: '#000' } }))).toEqual({ stroke: '#000' });
  });

  it('ignores non-numeric / malformed frame fields (fail-soft)', () => {
    expect(exportFillOf(withFrame({ opacity: 'nope', border: { color: 42 } }))).toBeUndefined();
  });

  it('a media item (src set) gets fill:none so the <image> shows through', () => {
    expect(exportFillOf(item({ memberId: 'x', src: 'https://example.com/a.png' }))).toEqual({ fill: 'none' });
  });

  it('composes: a media item WITH a frame carries fill:none + the frame style', () => {
    const it = item({ memberId: 'x', src: 'blob:abc', extra: { visualLayerStack: { frame: { opacity: 0.8 } } } });
    expect(exportFillOf(it)).toEqual({ opacity: 0.8, fill: 'none' });
  });

  it('is the resolver boardToSvg uses — a bordered item renders that stroke', () => {
    const it = withFrame({ border: { color: '#22c55e', width: 2 } });
    const svg = boardToSvg([it], { padding: 0, fillOf: exportFillOf });
    expect(svg).toContain('#22c55e'); // the frame border reached the SVG via the default resolver
  });

  // #169 — a presentation frame must export as a transparent OUTLINE, never the opaque
  // paper box that would hide the content it frames. Shape-predicate, not a kind literal.
  it('a presentation frame exports as fill:none + a default outline stroke', () => {
    const f = item({ memberId: 'F', kind: 'frame', extra: { presentationFrame: { order: 0 } } });
    expect(exportFillOf(f)).toEqual({ fill: 'none', stroke: '#94a3b8', strokeWidth: 2 });
  });

  it("a presentation frame's explicit border overrides the default outline (still fill:none)", () => {
    const f = item({ memberId: 'F', kind: 'frame', extra: { presentationFrame: { order: 1 }, visualLayerStack: { frame: { border: { color: '#ef4444', width: 3 } } } } });
    expect(exportFillOf(f)).toEqual({ fill: 'none', stroke: '#ef4444', strokeWidth: 3 });
  });

  it('a frame with a title still exports that title text over the transparent frame', () => {
    const f = item({ memberId: 'F', kind: 'frame', text: 'Chapter 1', extra: { presentationFrame: { order: 0 } } });
    const svg = boardToSvg([f], { padding: 0, fillOf: exportFillOf });
    expect(svg).toContain('fill="none"'); // outline, not an opaque box
    expect(svg).toContain('Chapter 1'); // the frame name is still in the export
  });
});

// ---------------------------------------------------------------------------
// #213 (P5) — a self-describing `extra.shape` exports as a bbox-FILLING path,
// the SAME geometry the live surface uses (live == export). The serializer stays
// BLIND: the shape path arrives via the injected `shapePathById` resolver (same
// DI as `fillOf`), so board-svg never imports the shape catalog.
// ---------------------------------------------------------------------------
import { shapeSvgPathById } from '../show/board-shapes';

describe('#213 board-svg — shaped items export as a filling path, not a <rect>', () => {
  it('an ellipse item emits a scaled <path> (full-box arc) when the resolver is injected', () => {
    const svg = boardToSvg([item({ memberId: 'c', x: 10, y: 20, w: 200, h: 200, extra: { shape: 'ellipse' } })], {
      shapePathById: shapeSvgPathById,
    });
    expect(svg).toContain('<path d="M 0,50 A 50,50'); // the full ellipse path (not a dome)
    expect(svg).toContain('translate(10 20) scale(2 2)'); // placed at the item rect
    expect(svg).toContain('vector-effect="non-scaling-stroke"'); // crisp border under scale
  });

  it('a diamond item emits its exact polygon path', () => {
    const svg = boardToSvg([item({ memberId: 'd', x: 0, y: 0, w: 100, h: 100, extra: { shape: 'diamond' } })], {
      shapePathById: shapeSvgPathById,
    });
    expect(svg).toContain('<path d="M 50,0 L 100,50 L 50,100 L 0,50 Z"');
  });

  it('BLIND fallback: without the resolver, a shaped item still emits a <rect> (no catalog coupling)', () => {
    const svg = boardToSvg([item({ memberId: 'c', extra: { shape: 'ellipse' } })]);
    expect(svg).toContain('<rect');
    expect(svg).not.toContain('<path d="M 0,50 A');
  });

  it('a plain (no-shape) item is unchanged — still a <rect>', () => {
    const svg = boardToSvg([item({ memberId: 'n' })], { shapePathById: shapeSvgPathById });
    expect(svg).toContain('<rect');
  });

  it('DELETION TEST: a formula shape the catalog never listed exports through the SAME path (zero export code)', () => {
    // The resolver is generic — a caller can resolve ANY id to a path. Here we prove
    // the export renders whatever path it is handed, so a new shape needs zero board-svg change.
    const svg = boardToSvg([item({ memberId: 'p', x: 0, y: 0, w: 100, h: 100, extra: { shape: 'heptagon' } })], {
      shapePathById: (id) => (id === 'heptagon' ? 'M 50,0 L 90,20 L 100,60 L 75,95 L 25,95 L 0,60 L 10,20 Z' : ''),
    });
    expect(svg).toContain('<path d="M 50,0 L 90,20');
  });
});

describe('boardToSvg — item transform facet (#222: rotation / flip / crop / filter fidelity)', () => {
  it('a plain item (no rotation/flip) emits a <g> with NO transform (byte-identical to before)', () => {
    const svg = boardToSvg([item({ memberId: 'a' })]);
    expect(svg).toContain('<g>');
    expect(svg).not.toContain('transform=');
  });

  it('rotates the whole item <g> about its center', () => {
    // center of x0 y0 w200 h140 = (100, 70)
    const svg = boardToSvg([item({ memberId: 'a', extra: { rotation: 30 } })]);
    expect(svg).toContain('<g transform="rotate(30 100 70)">');
  });

  it('mirrors a flipped item about its center (scale)', () => {
    const svg = boardToSvg([item({ memberId: 'a', extra: { flipX: true } })]);
    expect(svg).toContain('<g transform="translate(100 70) scale(-1 1) translate(-100 -70)">');
  });

  it('composes rotation opacity and flip on the same group', () => {
    const svg = boardToSvg(
      [item({ memberId: 'a', extra: { rotation: 45, flipY: true, visualLayerStack: { frame: { opacity: 0.5 } } } })],
      { fillOf: exportFillOf },
    );
    expect(svg).toContain('<g opacity="0.5" transform="rotate(45 100 70) translate(100 70) scale(1 -1) translate(-100 -70)">');
  });

  it('cropped image: the <image> is enlarged + offset (clip stays the item rect)', () => {
    // item at (0,0,200,140), crop the middle half {0.25,0.25,0.5,0.5} => image 2x, shifted by half a frame.
    const svg = boardToSvg([item({ memberId: 'a', kind: 'media', src: 'img.png', extra: { crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } } })]);
    expect(svg).toContain('<image href="img.png" x="-100" y="-70" width="400" height="280"');
    // the clip rect is still the item rect (the crop shows THROUGH it)
    expect(svg).toContain('<clipPath id="clip-a"><rect x="0" y="0" width="200" height="140"');
  });

  it('uncropped image is byte-identical (plain item rect, no offset)', () => {
    const svg = boardToSvg([item({ memberId: 'a', kind: 'media', src: 'img.png' })]);
    expect(svg).toContain('<image href="img.png" x="0" y="0" width="200" height="140"');
  });

  it('applies the image color filter as a CSS style (same string the live surface uses)', () => {
    const svg = boardToSvg([item({ memberId: 'a', kind: 'media', src: 'img.png', extra: { imageFilter: 'saturate(1.4) contrast(1.1)' } })]);
    expect(svg).toContain('style="filter:saturate(1.4) contrast(1.1)"');
  });

  it('an unfiltered image has no style attribute', () => {
    const svg = boardToSvg([item({ memberId: 'a', kind: 'media', src: 'img.png' })]);
    expect(svg).not.toContain('style="filter:');
  });
});

describe('cont.26 — export honors the SKETCH look (what-you-see-is-what-you-export)', () => {
  const conn = (from: string, to: string, extra: Record<string, unknown> = {}) =>
    item({ memberId: `c-${from}-${to}`, kind: 'connector', extra: { fromMemberId: from, toMemberId: to, ...extra } });

  it('fontFamily is a DATA option — a handwritten board exports in its font (the old hardcode is gone)', () => {
    const hand = "'Comic Sans MS', cursive";
    // the board-level font-family is an XML-escaped attribute value (safe for any font stack)
    expect(boardToSvg([item({ memberId: 'a' })], { fontFamily: hand })).toContain(`font-family="${escapeXml(hand)}"`);
    // default falls back to the system stack (zero regression for un-themed exports).
    expect(boardToSvg([item({ memberId: 'a' })])).toContain('font-family="-apple-system');
  });

  it('PER-ITEM fontFamily (extra.fontFamily) exports on that item — a sketch box keeps its font even on a plain board', () => {
    const hand = "'Comic Sans MS', cursive";
    // A board with NO board-level font, but one note carries its own font (as the sketch/infra-stack
    // template sets on its boxes). That note's <text> must carry its own font-family.
    const svg = boardToSvg([
      item({ memberId: 'plain', x: 0, y: 0, text: 'plain' }),
      item({ memberId: 'sketch', x: 300, y: 0, text: 'sketchy', extra: { fontFamily: hand } }),
    ]);
    // the per-item font appears on the sketch note's text element (XML-escaped attribute value)
    expect(svg).toContain(`font-family="${escapeXml(hand)}"`);
    // the plain note does NOT get a per-item font-family (it inherits the group's board font)
    const sketchText = svg.slice(svg.indexOf('sketchy') - 200, svg.indexOf('sketchy'));
    expect(sketchText).toContain('font-family=');
    const plainText = svg.slice(svg.indexOf('>plain<') - 200, svg.indexOf('>plain<'));
    expect(plainText.includes('font-family=')).toBe(false);
  });

  it('a board with no per-item fonts is byte-identical (zero regression)', () => {
    const before = boardToSvg([item({ memberId: 'a', text: 'hi' })]);
    // an item whose extra.fontFamily is absent emits the same text element as before this feature.
    expect(before).toContain('<text font-size="15" fill=');
    expect(before.includes('<text font-size="15" font-family=')).toBe(false);
  });

  it('a connector exports as a PENCIL stroke (bowed Q path) when roughness is set; crisp otherwise', () => {
    const board = [item({ memberId: 'a', x: 0, y: 0 }), item({ memberId: 'b', x: 400, y: 300 }), conn('a', 'b')];
    expect(boardToSvg(board, { roughness: 2 })).toContain('Q'); // hand-drawn bows
    expect(boardToSvg(board).includes('Q')).toBe(false); // crisp routed line, no bows
  });

  it('Line-style — a connectorStrokeStyle option exports the edge in that brushstroke; per-line strokeStyle wins; solid is crisp', () => {
    const board = [item({ memberId: 'a', x: 0, y: 0 }), item({ memberId: 'b', x: 400, y: 300 }), conn('a', 'b')];
    expect(boardToSvg(board, { connectorStrokeStyle: 'pencil' })).toContain('Q'); // named pencil bows
    expect(boardToSvg(board, { connectorStrokeStyle: 'solid' }).includes('Q')).toBe(false); // solid = crisp
    // a dashed style exports a dash but stays crisp (roughness 0).
    const dashedSvg = boardToSvg(board, { connectorStrokeStyle: 'dashed' });
    expect(dashedSvg).toContain('stroke-dasharray');
    expect(/<path d="[^"]*Q[^"]*"[^>]*stroke-linecap/.test(dashedSvg)).toBe(false);
    // per-line strokeStyle wins over an un-styled board.
    const perLine = [item({ memberId: 'a', x: 0, y: 0 }), item({ memberId: 'b', x: 400, y: 300 }), conn('a', 'b', { strokeStyle: 'sketch' })];
    expect(boardToSvg(perLine)).toContain('Q');
  });

  it('Line-style border — a borderStrokeStyle option exports the note border in that brushstroke; per-item wins; solid is crisp', () => {
    const one = [item({ memberId: 'a' })];
    expect(boardToSvg(one, { borderStrokeStyle: 'pencil' })).toContain('Q'); // pencil border bows
    expect(boardToSvg(one, { borderStrokeStyle: 'dashed' })).toContain('stroke-dasharray'); // dashed crisp outline
    const solid = boardToSvg(one, { borderStrokeStyle: 'solid' });
    expect(/<rect[^>]*stroke="/.test(solid)).toBe(true); // solid → the crisp stroked <rect>
    expect(solid.includes('Q')).toBe(false);
    // per-item borderStrokeStyle wins over an un-styled board.
    expect(boardToSvg([item({ memberId: 'a', extra: { borderStrokeStyle: 'sketch' } })])).toContain('Q');
  });

  it('a hand-drawn connector EXPORTS a hand-drawn arrowhead (no marker-end); a crisp one keeps the marker', () => {
    const board = (rough: boolean) => [
      item({ memberId: 'a', x: 0, y: 0 }),
      item({ memberId: 'b', x: 400, y: 300 }),
      conn('a', 'b', rough ? { strokeStyle: 'pencil' } : {}),
    ];
    expect(boardToSvg(board(true))).not.toContain('marker-end'); // rough → hand-drawn V head, no crisp triangle
    expect(boardToSvg(board(false))).toContain('marker-end'); // crisp → the marker triangle
  });

  it('Line-style SHAPE — a shaped note with a border brushstroke exports a rough/dashed OUTLINE (live == export); solid/no-resolver stays crisp', () => {
    const opts = { shapePathById: shapeSvgPathById, shapeOutlineById };
    const diamond = (styleId?: string) => [item({ memberId: 'a', extra: { shape: 'diamond', ...(styleId ? { borderStrokeStyle: styleId } : {}) } })];
    // pencil shape → the shape outline bows (Q), fill kept, crisp stroke suppressed.
    expect(boardToSvg(diamond('pencil'), opts)).toContain('Q');
    // dashed shape → a crisp dashed outline (no bows).
    const dashed = boardToSvg(diamond('dashed'), opts);
    expect(dashed).toContain('stroke-dasharray');
    // solid shape → the crisp filling <path>, no bowed outline (byte-identical).
    expect(boardToSvg(diamond(), opts).includes('Q')).toBe(false);
    // WITHOUT the injected outline resolver, even a pencil shape falls back to the crisp path (blind, safe).
    expect(boardToSvg(diamond('pencil'), { shapePathById: shapeSvgPathById }).includes('Q')).toBe(false);
  });

  it('a note exports a rough pencil border (fill rect + bowed stroke path) when roughness is set', () => {
    expect(boardToSvg([item({ memberId: 'a' })], { roughness: 2 })).toContain('Q');
    // a per-item borderRoughness works without a board-level option too.
    expect(boardToSvg([item({ memberId: 'a', extra: { borderRoughness: 2 } })])).toContain('Q');
    // no roughness → a plain crisp <rect> (byte-identical).
    expect(boardToSvg([item({ memberId: 'a' })])).toContain('<rect');
    expect(boardToSvg([item({ memberId: 'a' })]).includes('Q')).toBe(false);
  });

  it('the TWO roughness axes are independent — connectorRoughness bows only edges, borderRoughness only borders', () => {
    // A board with a distinctly-stroked note (#111111) + a default connector (#6b7280).
    const board = [
      item({ memberId: 'a', x: 0, y: 0 }),
      item({ memberId: 'b', x: 400, y: 300 }),
      conn('a', 'b', { color: '#3355ff' }), // an explicit edge color, distinct from the note border below
    ];
    const fillOf = (): BoardSvgStyle => ({ stroke: '#111111', strokeWidth: 2 });
    // The `d` of the first <path> carrying a given stroke color (the connector vs the note border path).
    const pathD = (svg: string, color: string): string =>
      new RegExp(`<path d="([^"]*)"[^>]*stroke="${color}"`).exec(svg)?.[1] ?? '';

    // connectorRoughness ONLY → connector bows, note border stays a CRISP stroked <rect>.
    const connOnly = boardToSvg(board, { connectorRoughness: 2, fillOf });
    expect(pathD(connOnly, '#3355ff')).toContain('Q'); // edge bowed
    expect(connOnly).toContain('stroke="#111111"'); // note border still a crisp stroked rect
    expect(connOnly).toMatch(/<rect[^>]*stroke="#111111"/);

    // borderRoughness ONLY → note border bows (Q on its #111111 path), connector stays CRISP (no Q in its d).
    const borderOnly = boardToSvg(board, { borderRoughness: 2, fillOf });
    expect(pathD(borderOnly, '#111111')).toContain('Q'); // border bowed
    expect(pathD(borderOnly, '#3355ff').includes('Q')).toBe(false); // edge still crisp
    expect(borderOnly).not.toMatch(/<rect[^>]*stroke="#111111"/); // rough border → fill-only rect
  });
});

describe('boardToSvg — text wrap ellipsis fires ONLY on real truncation (cont.98)', () => {
  // A note whose text FITS exactly must render every line intact. The old wrapLines ellipsized
  // whenever it reached maxLines, so text that fit perfectly lost its last line to a spurious
  // "…" (Codex batch-5 finding, independently verified). At w=200,h=60,fontSize=15 → maxLines=2.
  it('text that fills exactly maxLines keeps its last line (NO spurious ellipsis)', () => {
    const svg = boardToSvg([item({ memberId: 'a', w: 200, h: 60, text: 'aa\nbb' })]);
    expect(svg).toContain('>aa</tspan>');
    expect(svg).toContain('>bb</tspan>'); // the last line survives intact
    expect(svg).not.toContain('…'); // nothing was truncated → no ellipsis
  });

  it('text with MORE lines than fit is truncated with an ellipsis on the last visible line', () => {
    const svg = boardToSvg([item({ memberId: 'b', w: 200, h: 60, text: 'aa\nbb\ncc' })]);
    expect(svg).toContain('>aa</tspan>'); // first line intact
    expect(svg).toContain('…'); // genuinely truncated → ellipsis present
    expect(svg).not.toContain('>cc</tspan>'); // the overflow line is dropped
  });

  it('a single line that fits is untouched (no ellipsis, no clipping)', () => {
    const svg = boardToSvg([item({ memberId: 'c', w: 200, h: 60, text: 'hello' })]);
    expect(svg).toContain('>hello</tspan>');
    expect(svg).not.toContain('…');
  });
});

describe('board-svg — cont.98 batch-26 hardening (finite geometry + text DoS cap)', () => {
  it('#3 a Number.MAX_VALUE coordinate never emits an Infinity/NaN viewBox or rect', () => {
    const svg = boardToSvg([item({ memberId: 'a', x: Number.MAX_VALUE, y: 0, w: Number.MAX_VALUE, h: 1 })]);
    expect(svg.includes('Infinity')).toBe(false);
    expect(svg.includes('NaN')).toBe(false);
    expect(svg.startsWith('<svg')).toBe(true);
  });

  it('#4 a 10M-character note text completes quickly and does not blow up the output', () => {
    const svg = boardToSvg([item({ memberId: 'a', x: 0, y: 0, w: 200, h: 100, text: 'x\n'.repeat(10_000_000) })]);
    // capped before split → the emitted SVG is bounded, not hundreds of MB
    expect(svg.length).toBeLessThan(200_000);
    expect(svg.includes('<text')).toBe(true);
  });

  it('#4 a giant connector label is capped, not emitted verbatim', () => {
    const a = item({ memberId: 'a', x: 0, y: 0, w: 50, h: 50 });
    const b = item({ memberId: 'b', x: 300, y: 0, w: 50, h: 50 });
    const conn = item({ memberId: 'c', x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: 'a', toMemberId: 'b', label: 'L'.repeat(5_000_000) } });
    const svg = boardToSvg([a, b, conn]);
    expect(svg.length).toBeLessThan(200_000); // label sliced to MAX_SVG_TEXT, not 5M chars
  });
});
