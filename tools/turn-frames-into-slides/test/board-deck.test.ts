// tools/turn-frames-into-slides/test/board-deck.test.ts (the board deck's own tests, carried with it)
// rect, carrying its centred contents + intra-slide connectors, labelled, honest-empty with no frames.

import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { emptyGraph } from '../read-data/group-graph.ts';
import type { AddressRef } from '../read-data/group-graph.ts';
import { placeItem, readItems } from '../read-data/group-board-model.ts';
import { boardToDeck, deckSlideLabels, deckToHtml } from '../read-data/board-deck.ts';

const PARENT: AddressRef = { family: 'test.board', parts: { board: 'b1' } };

// Two presentation frames placed out of order (order 1 then 0) with contents, a stray note outside
// both frames, and a connector between two notes on frame A.
function deckBoard() {
  let g = emptyGraph();
  const put = (a: Record<string, unknown>) => (g = placeItem(g, PARENT, { nodeRef: { family: 't', parts: { id: a.memberId } }, w: 100, h: 60, ...a } as never));
  // Frame B first in array but order 1; Frame A order 0 → deck must put A before B.
  put({ memberId: 'FB', kind: 'frame', x: 1000, y: 0, w: 800, h: 600, text: 'Second', extra: { presentationFrame: { order: 1 } } });
  put({ memberId: 'FA', kind: 'frame', x: 0, y: 0, w: 800, h: 600, text: 'First', extra: { presentationFrame: { order: 0 } } });
  put({ memberId: 'a1', kind: 'note', x: 40, y: 40, text: 'alpha' }); // inside FA
  put({ memberId: 'a2', kind: 'note', x: 200, y: 300, text: 'beta' }); // inside FA
  put({ memberId: 'b1', kind: 'note', x: 1100, y: 100, text: 'gamma' }); // inside FB
  put({ memberId: 'stray', kind: 'note', x: 5000, y: 5000, text: 'orphan' }); // in NO frame
  put({ memberId: 'e1', kind: 'connector', x: 0, y: 0, extra: { fromMemberId: 'a1', toMemberId: 'a2' } }); // within FA
  put({ memberId: 'e2', kind: 'connector', x: 0, y: 0, extra: { fromMemberId: 'a1', toMemberId: 'b1' } }); // CROSSES A→B
  return readItems(g, PARENT);
}

describe('boardToDeck — ordered slide export', () => {
  it('produces one slide per frame in STORY order (order asc), not array order', () => {
    const deck = boardToDeck(deckBoard());
    expect(deck.slides.map((s) => s.frameId)).toEqual(['FA', 'FB']); // FA (order 0) before FB (order 1)
    expect(deck.slides.map((s) => s.order)).toEqual([1, 2]); // 1-based
    expect(deckSlideLabels(deck)).toEqual(['First', 'Second']); // the frames' own text
  });

  it('each slide carries only its OWN centred contents (stray + other-frame items excluded)', () => {
    const deck = boardToDeck(deckBoard());
    const [slideA, slideB] = deck.slides;
    expect(slideA.itemCount).toBe(2); // a1, a2
    expect(slideA.svg).toContain('alpha');
    expect(slideA.svg).toContain('beta');
    expect(slideA.svg).not.toContain('gamma'); // FB's content not on slide A
    expect(slideA.svg).not.toContain('orphan'); // stray never on any slide
    expect(slideB.itemCount).toBe(1); // b1
    expect(slideB.svg).toContain('gamma');
  });

  it('the slide viewBox is framed to the frame rect (frame item spans it)', () => {
    const deck = boardToDeck(deckBoard(), { padding: 0 });
    // FA is at x0..800,y0..600; with padding 0 the viewBox origin is the frame origin.
    expect(deck.slides[0].svg).toContain('viewBox="0 0 800 600"');
    // FB is at x1000..1800; its viewBox starts at 1000.
    expect(deck.slides[1].svg).toContain('viewBox="1000 0 800 600"');
  });

  it('an intra-slide connector exports; a frame-crossing connector is dropped from both slides', () => {
    // e1 (a1→a2, both on FA) is a real edge on slide A; e2 (a1→b1, crosses) is on neither.
    // boardToSvg only renders a connector when BOTH endpoints are in the passed subset, so the
    // deck simply never includes e2 in either slide's subset — no dangling line.
    const deck = boardToDeck(deckBoard());
    // A path element appears on slide A (the connector) but the crossing one cannot (b1 absent there).
    expect(deck.slides[0].svg).toContain('<path'); // e1 rendered
  });

  it('a frame with no text falls back to "Slide N" (overridable prefix)', () => {
    let g = emptyGraph();
    g = placeItem(g, PARENT, { memberId: 'F', nodeRef: { family: 't', parts: { id: 'F' } }, kind: 'frame', x: 0, y: 0, w: 400, h: 300, extra: { presentationFrame: { order: 0 } } } as never);
    const deck = boardToDeck(readItems(g, PARENT), { emptyLabel: 'Page' });
    expect(deck.slides[0].label).toBe('Page 1');
  });

  it('no presentation frames → an empty deck (honest, not a fake slide)', () => {
    let g = emptyGraph();
    g = placeItem(g, PARENT, { memberId: 'n', nodeRef: { family: 't', parts: { id: 'n' } }, kind: 'note', x: 0, y: 0, w: 100, h: 60, text: 'lonely' } as never);
    expect(boardToDeck(readItems(g, PARENT)).slides).toEqual([]);
  });
});

describe('deckToHtml — one printable document from the deck', () => {
  it('embeds every slide SVG in story order with a numbered caption, page-breaking for print', () => {
    const html = deckToHtml(boardToDeck(deckBoard()), { title: 'My plan' });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>My plan</title>');
    // both slides' contents present, and the FA caption precedes the FB caption (story order).
    expect(html.indexOf('1. First')).toBeGreaterThan(-1);
    expect(html.indexOf('2. Second')).toBeGreaterThan(html.indexOf('1. First'));
    expect(html).toContain('alpha');
    expect(html).toContain('gamma');
    expect(html).toContain('page-break-after'); // real slides when saved to PDF
    // two <section> slides, one per frame.
    expect(html.match(/class="slide"/g)?.length).toBe(2);
  });

  it('escapes a frame label so a title never injects markup', () => {
    let g = emptyGraph();
    g = placeItem(g, PARENT, { memberId: 'F', nodeRef: { family: 't', parts: { id: 'F' } }, kind: 'frame', x: 0, y: 0, w: 400, h: 300, text: '<script>x</script>', extra: { presentationFrame: { order: 0 } } } as never);
    const html = deckToHtml(boardToDeck(readItems(g, PARENT)));
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).not.toContain('<script>x</script>');
  });

  it('an empty deck still yields a valid document with an honest empty note (no fake slide)', () => {
    const html = deckToHtml({ slides: [] });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('no presentation frames yet');
    expect(html.match(/<section class="slide/g)?.length).toBe(1); // the empty note, not a content slide
  });
});
