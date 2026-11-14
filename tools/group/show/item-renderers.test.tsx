// packages/group/show/item-renderers.test.tsx
//
// Regression proof for #211 Bug A: a shaped node (extra.shape) keeps its
// bbox-filling silhouette in BOTH view and edit mode. Entering text (double-click
// → editing) must NEVER collapse a star/diamond into a square. The CanvasShape
// primitive renders a `<svg viewBox="0 0 100 100" preserveAspectRatio="none">`;
// its presence is the proof the silhouette survived.

import React from 'react';
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { rendererForKind } from './item-renderers';
import type { BoardItem } from '../read-data/group-board-model';

afterEach(() => cleanup());

/** The CanvasShape SVG is uniquely identified by its percent viewBox + non-scaling. */
const CANVAS_SHAPE = 'svg[viewBox="0 0 100 100"][preserveAspectRatio="none"]';

function noteItem(extra: Record<string, unknown>): BoardItem {
  return {
    kind: 'note',
    memberId: 'm-shape',
    x: 0, y: 0, w: 200, h: 200,
    text: 'hi',
    html: '<p>hi</p>',
    extra,
  } as unknown as BoardItem;
}

describe('#211 Bug A — shaped node keeps its silhouette across edit state', () => {
  it('renders the shape silhouette in VIEW mode', () => {
    const Note = rendererForKind('note');
    const { container } = render(<Note item={noteItem({ shape: 'star' })} selected={false} editing={false} />);
    expect(container.querySelector(CANVAS_SHAPE)).not.toBeNull();
  });

  it('KEEPS the shape silhouette in EDIT mode (the fix — star never becomes a square)', () => {
    const Note = rendererForKind('note');
    const { container } = render(<Note item={noteItem({ shape: 'star' })} selected={false} editing />);
    // The silhouette survives; the note is still editable ON TOP of the shape.
    expect(container.querySelector(CANVAS_SHAPE)).not.toBeNull();
    expect(container.querySelector('[contenteditable]')).not.toBeNull();
  });

  it('a plain (unshaped) note in edit mode renders NO shape silhouette (blind: no extra.shape → normal card)', () => {
    const Note = rendererForKind('note');
    const { container } = render(<Note item={noteItem({})} selected={false} editing />);
    expect(container.querySelector(CANVAS_SHAPE)).toBeNull();
    expect(container.querySelector('[contenteditable]')).not.toBeNull();
  });
});

// A note in VIEW mode with sizeMode:'scroll' resolved pins the box: the card style
// carries overflow:auto (sizeModeStyle('scroll')). `fit` (default) leaves no such style.
const hasScrollBox = (container: HTMLElement): boolean =>
  Array.from(container.querySelectorAll<HTMLElement>('*')).some((el) => el.style.overflow === 'auto');

describe('#225 P1 slice 2 — the BOARD tier of the appearance cascade reaches the renderer', () => {
  it('a board default sizeMode:"scroll" pins the note box when the item has no override', () => {
    const Note = rendererForKind('note');
    const { container } = render(
      <Note item={noteItem({})} selected={false} editing={false} boardAppearance={{ sizeMode: 'scroll' }} />,
    );
    expect(hasScrollBox(container)).toBe(true);
  });

  it('an ITEM override beats the board default (cascade order: item → board → global)', () => {
    const Note = rendererForKind('note');
    const { container } = render(
      <Note
        item={noteItem({ sizeMode: 'fit' })}
        selected={false}
        editing={false}
        boardAppearance={{ sizeMode: 'scroll' }}
      />,
    );
    expect(hasScrollBox(container)).toBe(false); // fit → auto-height owns the box
  });

  it('NO board profile → the pre-slice render (zero-regression default)', () => {
    const Note = rendererForKind('note');
    const { container } = render(<Note item={noteItem({})} selected={false} editing={false} />);
    expect(hasScrollBox(container)).toBe(false);
  });
});

describe('R3/P2 — a note renders its list marker (extra.marker) before the text', () => {
  it('a glyph marker (star) draws its char before the note body in VIEW mode', () => {
    const Note = rendererForKind('note');
    const { container } = render(<Note item={noteItem({ marker: 'star' })} selected={false} editing={false} />);
    expect(container.textContent).toContain('★');
    expect(container.textContent).toContain('hi'); // body still shows
  });

  it('an emoji marker is just a glyph — no special path (🔥 renders)', () => {
    const Note = rendererForKind('note');
    const { container } = render(<Note item={noteItem({ marker: 'fire' })} selected={false} editing={false} />);
    expect(container.textContent).toContain('🔥');
  });

  it('an ordinal marker uses markerIndex — "3." at sibling position 2', () => {
    const Note = rendererForKind('note');
    const { container } = render(
      <Note item={noteItem({ marker: 'decimal' })} selected={false} editing={false} markerIndex={2} />,
    );
    expect(container.textContent).toContain('3.');
  });

  it('a cycle marker rotates by markerIndex — moon phase at position 4 is 🌕', () => {
    const Note = rendererForKind('note');
    const { container } = render(
      <Note item={noteItem({ marker: 'moon' })} selected={false} editing={false} markerIndex={4} />,
    );
    expect(container.textContent).toContain('🌕');
  });

  it('a CUSTOM marker draws the per-item glyph override (Sam: "whatever they want" — ♥)', () => {
    const Note = rendererForKind('note');
    const { container } = render(
      <Note item={noteItem({ marker: 'custom', markerGlyph: '♥' })} selected={false} editing={false} />,
    );
    expect(container.textContent).toContain('♥');
    expect(container.textContent).toContain('hi');
  });

  it('any emoji works as a custom glyph with ZERO new catalog rows (🌈)', () => {
    const Note = rendererForKind('note');
    const { container } = render(
      <Note item={noteItem({ marker: 'custom', markerGlyph: '🌈' })} selected={false} editing={false} />,
    );
    expect(container.textContent).toContain('🌈');
  });

  it('a custom marker with NO glyph override → no prefix (fail-safe)', () => {
    const Note = rendererForKind('note');
    const { container } = render(<Note item={noteItem({ marker: 'custom' })} selected={false} editing={false} />);
    expect(container.textContent).toBe('hi');
  });

  it('NO marker → no prefix (zero regression: body renders exactly as before)', () => {
    const Note = rendererForKind('note');
    const { container } = render(<Note item={noteItem({})} selected={false} editing={false} />);
    expect(container.textContent).toBe('hi');
  });

  it('an unknown marker id → no prefix (safe, never throws)', () => {
    const Note = rendererForKind('note');
    const { container } = render(<Note item={noteItem({ marker: 'nope' })} selected={false} editing={false} />);
    expect(container.textContent).toBe('hi');
  });

  it('MEDIA BULLET: an image marker + item URL draws a bullet-sized image before the text (Sam\'s image bullet)', () => {
    const Note = rendererForKind('note');
    const { container } = render(
      <Note item={noteItem({ marker: 'image', markerMediaUrl: 'https://x/pic.png' })} selected={false} editing={false} />,
    );
    expect(container.querySelector('img[src="https://x/pic.png"]')).not.toBeNull();
    expect(container.textContent).toContain('hi'); // body still shows beside the image bullet
  });

  it('an image marker with NO URL → no bullet (fail-closed, never a broken image)', () => {
    const Note = rendererForKind('note');
    const { container } = render(<Note item={noteItem({ marker: 'image' })} selected={false} editing={false} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('hi');
  });
});

describe('R11 — a link card renders its enriched embed (og:video / og:site_name)', () => {
  const linkItem = (linkPreview: Record<string, unknown>): BoardItem => ({
    kind: 'link', memberId: 'l', x: 0, y: 0, w: 300, h: 120,
    src: 'https://lakeside.example.com/clip', text: '', extra: { linkPreview },
  } as unknown as BoardItem);

  it('a video preview plays a <video> embed (not the still image)', () => {
    const Link = rendererForKind('link');
    const { container } = render(
      <Link item={linkItem({ video: 'https://x/clip.mp4', image: 'https://x/poster.jpg', title: 'Serve slow-mo' })} selected={false} editing={false} />,
    );
    expect(container.querySelector('video')).not.toBeNull();
    expect(container.textContent).toContain('Serve slow-mo');
  });

  it('the site name renders as the source label', () => {
    const Link = rendererForKind('link');
    const { container } = render(
      <Link item={linkItem({ siteName: 'Lakeside Pottery', title: 'A page' })} selected={false} editing={false} />,
    );
    expect(container.textContent).toContain('Lakeside Pottery');
  });

  it('image-only preview shows an <img>, no <video> (fail-open, no fake video)', () => {
    const Link = rendererForKind('link');
    const { container } = render(
      <Link item={linkItem({ image: 'https://x/i.png', title: 'Pic' })} selected={false} editing={false} />,
    );
    expect(container.querySelector('img')).not.toBeNull();
    expect(container.querySelector('video')).toBeNull();
  });
});

describe('item #9 — a note streams a freshly-produced result in (revealText)', () => {
  let rafQueue: FrameRequestCallback[] = [];
  beforeEach(() => {
    rafQueue = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { rafQueue.push(cb); return rafQueue.length; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });
  afterEach(() => vi.unstubAllGlobals());
  const pump = () => act(() => { for (let i = 0; i < 300 && rafQueue.length; i += 1) rafQueue.shift()!(0); });

  const RESULT = 'The produced answer that should type itself in progressively.';
  function producedNote(): BoardItem {
    return { kind: 'note', memberId: 'm-gen', x: 0, y: 0, w: 200, h: 200, text: RESULT, html: `<p>${RESULT}</p>`, extra: {} } as unknown as BoardItem;
  }

  it('starts hidden then settles on the full produced text', () => {
    const Note = rendererForKind('note');
    const { container } = render(<Note item={producedNote()} selected={false} editing={false} revealText={RESULT} />);
    // count 0 → the note renders no result text yet (revealing an empty slice).
    expect(container.textContent).not.toContain(RESULT);
    pump();
    expect(container.textContent).toContain(RESULT); // settled to the whole result
  });

  it('without revealText the note shows its text immediately (zero change for every note)', () => {
    const Note = rendererForKind('note');
    const { container } = render(<Note item={producedNote()} selected={false} editing={false} />);
    expect(container.textContent).toContain(RESULT);
    expect(rafQueue.length).toBe(0); // no reveal scheduled
  });
});

// cont.26 (E2) — the note FONT flows through the appearance cascade to the card root; the
// RichTextEditor + marker inherit it. A "handwritten" font is one DATA value, no code branch.
describe('cont.26 (E2) — note fontFamily via the appearance cascade', () => {
  const fontNote = (extra: Record<string, unknown>): BoardItem => ({
    kind: 'note', memberId: 'm-font', x: 0, y: 0, w: 200, h: 100, text: 'hi', html: '<p>hi</p>', extra,
  } as unknown as BoardItem);
  const hasFont = (c: HTMLElement, needle: string) =>
    [...c.querySelectorAll<HTMLElement>('[style]')].some((el) => (el.getAttribute('style') ?? '').includes(needle));

  it('applies a per-item fontFamily to the card root', () => {
    const Note = rendererForKind('note');
    const { container } = render(<Note item={fontNote({ fontFamily: 'Comic Sans MS' })} selected={false} editing={false} />);
    expect(hasFont(container, 'Comic Sans MS')).toBe(true);
  });

  it('resolves fontFamily from the BOARD default when the item has none', () => {
    const Note = rendererForKind('note');
    const { container } = render(
      <Note item={fontNote({})} selected={false} editing={false} boardAppearance={{ fontFamily: 'Patrick Hand' }} />,
    );
    expect(hasFont(container, 'Patrick Hand')).toBe(true);
  });

  it('no fontFamily anywhere → no font-family override (system font, zero regression)', () => {
    const Note = rendererForKind('note');
    const { container } = render(<Note item={fontNote({})} selected={false} editing={false} />);
    expect(hasFont(container, 'font-family')).toBe(false);
  });
});

// cont.26 (E3) — a PENCIL BORDER is a hand-drawn SVG outline over the card via the same stroke leaf.
describe('cont.26 (E3) — note borderRoughness pencil outline', () => {
  const bItem = (extra: Record<string, unknown>): BoardItem => ({
    kind: 'note', memberId: 'm-b', x: 0, y: 0, w: 200, h: 100, text: 'hi', extra,
  } as unknown as BoardItem);
  // The rough border is the only SVG whose path `d` carries quadratic bows (Q).
  const roughBorder = (c: HTMLElement) =>
    [...c.querySelectorAll('svg path')].some((p) => (p.getAttribute('d') ?? '').includes('Q'));

  it('draws a bowed pencil outline when borderRoughness is set (per-item)', () => {
    const Note = rendererForKind('note');
    const { container } = render(<Note item={bItem({ borderRoughness: 2 })} selected={false} editing={false} />);
    expect(roughBorder(container)).toBe(true);
  });

  it('resolves borderRoughness from the BOARD default', () => {
    const Note = rendererForKind('note');
    const { container } = render(
      <Note item={bItem({})} selected={false} editing={false} boardAppearance={{ borderRoughness: 2 }} />,
    );
    expect(roughBorder(container)).toBe(true);
  });

  it('no borderRoughness → no pencil outline (plain card, zero regression)', () => {
    const Note = rendererForKind('note');
    const { container } = render(<Note item={bItem({})} selected={false} editing={false} />);
    expect(roughBorder(container)).toBe(false);
  });

  it('cont.26 (rough shapes) — a SHAPED note with borderRoughness traces a hand-drawn shape outline', () => {
    const Note = rendererForKind('note');
    const { container } = render(<Note item={bItem({ shape: 'diamond', borderRoughness: 2 })} selected={false} editing={false} />);
    // the CanvasShape silhouette still renders (the fill), plus a bowed (Q) outline overlay.
    expect(container.querySelector(CANVAS_SHAPE)).not.toBeNull();
    expect(roughBorder(container)).toBe(true);
  });

  it('cont.26 — a SHAPED note without borderRoughness renders the plain crisp shape (zero regression)', () => {
    const Note = rendererForKind('note');
    const { container } = render(<Note item={bItem({ shape: 'diamond' })} selected={false} editing={false} />);
    expect(container.querySelector(CANVAS_SHAPE)).not.toBeNull();
    expect(roughBorder(container)).toBe(false); // no bowed overlay
  });

  // The named Line-style axis for borders — the outline path with (or without) a dash.
  const outlinePath = (c: HTMLElement) => c.querySelector('svg path');
  it('Line-style — a named PENCIL border style bows (per-item) and resolves from the BOARD default', () => {
    const Note = rendererForKind('note');
    const perItem = render(<Note item={bItem({ borderStrokeStyle: 'pencil' })} selected={false} editing={false} />);
    expect(roughBorder(perItem.container)).toBe(true);
    const boardDefault = render(<Note item={bItem({})} selected={false} editing={false} boardAppearance={{ borderStrokeStyle: 'sketch' }} />);
    expect(roughBorder(boardDefault.container)).toBe(true);
  });

  it('Line-style — a DASHED border draws a CRISP dashed outline (no bows), unlike pencil', () => {
    const Note = rendererForKind('note');
    const { container } = render(<Note item={bItem({ borderStrokeStyle: 'dashed' })} selected={false} editing={false} />);
    const p = outlinePath(container);
    expect(p).not.toBeNull();
    expect(p!.getAttribute('d')).not.toContain('Q'); // dashed = roughness 0 → crisp outline
    expect(p!.getAttribute('stroke-dasharray')).toBeTruthy(); // …but dashed
  });

  it('Line-style — a SOLID border style → the plain card, no outline overlay (byte-identical)', () => {
    const Note = rendererForKind('note');
    const { container } = render(<Note item={bItem({ borderStrokeStyle: 'solid' })} selected={false} editing={false} />);
    expect(outlinePath(container)).toBeNull();
  });

  it('red-team (cont.98 batch-39): a prototype-key item kind renders the fallback, never crashes React', () => {
    // A plain ITEM_RENDERERS[kind] would resolve '__proto__' -> Object.prototype / 'constructor' -> the
    // Object constructor (both truthy), so React would try to render a non-component -> "Element type is
    // invalid". ownValue routes any prototype/unmapped kind to FallbackItem, so render must not throw.
    const Node = rendererForKind('note');
    for (const bad of ['__proto__', 'constructor', 'hasOwnProperty', 'toString', 'unmapped-kind']) {
      const item = { kind: bad, memberId: `m-${bad}`, x: 0, y: 0, w: 100, h: 100, text: 't' } as unknown as BoardItem;
      expect(() => render(<Node item={item} selected={false} editing={false} />)).not.toThrow();
    }
  });
});
