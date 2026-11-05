// packages/group/do-work/board-deck.ts
//
// Export the board's PRESENTATION FRAMES as an ordered SLIDE DECK — one SVG per frame, in story
// order. The board already has (a) presentation frames with a story order (`boardFrames`), (b)
// frame membership by geometry (`itemsInsideFrame`), and (c) a faithful board→SVG serializer
// (`boardToSvg`, live==export). This is their COMPOSITION: for each frame, render just that frame +
// its contents to an SVG whose viewBox is the frame's own rect (the frame item spans it, so
// boardToSvg frames the slide automatically). Zero new geometry/serialization — a deck is the story
// path passed through the existing exporter (L069/L100). Pure: no I/O; the caller downloads/zips.

import type { BoardItem } from '../read-data/group-board-model.ts';
import type { MediaCarouselItem } from '../../ui/show/media-carousel/MediaCarousel';
import { svgDataUrl } from '../../ui/show/raster/svg-to-png';
import { itemIsConnector } from '../read-data/group-board-model.ts';
import { boardFrames, itemsInsideFrame } from './board-frames.ts';
import { boardToSvg, escapeXml, type BoardSvgOptions } from './board-svg.ts';

export interface DeckSlide {
  readonly order: number; // 1-based slide number in story order
  readonly frameId: string;
  readonly label: string; // the frame's own text, else "Slide N"
  readonly svg: string; // the frame + its contents, viewBox = the frame rect
  readonly itemCount: number; // content items on the slide (the frame itself excluded)
}

export interface BoardDeck {
  readonly slides: DeckSlide[];
}

export interface BoardDeckOptions extends BoardSvgOptions {
  /** Label prefix for a frame with no text of its own (default "Slide"). */
  readonly emptyLabel?: string;
}

/**
 * Build the slide deck: one {@link DeckSlide} per presentation frame, in `boardFrames` story order.
 * Each slide renders the frame + every item CENTRED inside it (`itemsInsideFrame`) + any connector
 * whose BOTH endpoints are on that slide (so arrows between slide items export; a connector crossing
 * frames is dropped from both). No presentation frames → `{ slides: [] }` (honest empty — a board
 * with no frames simply has no deck). Pure composition — the SVG faithfulness (fills, borders,
 * brushstrokes, typed connector labels) is whatever `boardToSvg` already produces (live == export).
 */
export function boardToDeck(items: readonly BoardItem[], opts: BoardDeckOptions = {}): BoardDeck {
  const frames = boardFrames(items);
  const slides = frames.map((frame, i): DeckSlide => {
    const contents = itemsInsideFrame(items, frame);
    const contentIds = new Set(contents.map((c) => c.memberId));
    const connectors = items.filter((it) => {
      if (!itemIsConnector(it)) return false;
      const from = it.extra?.fromMemberId;
      const to = it.extra?.toMemberId;
      return typeof from === 'string' && typeof to === 'string' && contentIds.has(from) && contentIds.has(to);
    });
    const svg = boardToSvg([frame, ...contents, ...connectors], opts);
    const rawLabel = typeof frame.text === 'string' ? frame.text.trim() : '';
    return {
      order: i + 1,
      frameId: frame.memberId,
      label: rawLabel !== '' ? rawLabel : `${opts.emptyLabel ?? 'Slide'} ${i + 1}`,
      svg,
      itemCount: contents.length,
    };
  });
  return { slides };
}

/** The ordered slide labels — the DATA behind a thumbnail strip / slide index / deck outline. */
export function deckSlideLabels(deck: BoardDeck): string[] {
  return deck.slides.map((s) => s.label);
}

/**
 * Adapt the existing ordered deck to the shared image-carousel contract. Frame identity and story
 * order remain owned by the deck; the carousel receives one inline SVG image per existing slide.
 * This is useful for an immediate preview. A public publisher that needs reusable URLs can persist
 * each `svg` from the deck through its existing media owner instead of authoring another frame model.
 */
export function deckToMediaCarouselItems(deck: BoardDeck): MediaCarouselItem[] {
  return deck.slides.map((slide) => ({
    id: slide.frameId,
    src: svgDataUrl(slide.svg),
    alt: slide.label,
    label: `${slide.order}. ${slide.label}`,
  }));
}

/**
 * Serialize a {@link BoardDeck} to ONE printable/openable HTML document — the downloadable deck
 * artifact. Each slide is a full-page `<section>` (its own SVG inline + label caption), page-breaking
 * for print/PDF so "Save as PDF" yields real slides. Pure string composition of the SVGs `boardToDeck`
 * already produced (no new geometry/serialization — same relationship as `boardToDeck` to `boardToSvg`,
 * L069/L100). `font` is the look's text face it is set in. An empty deck yields a valid document with an honest empty note (never a fake slide).
 */
export function deckToHtml(deck: BoardDeck, opts: { title?: string; font?: string } = {}): string {
  const docTitle = escapeXml(opts.title ?? 'Board deck');
  // The deck is set in the look's text face (`font`: the screen's --font-primary, read where it is downloaded), so the
  // file reads in the same face away from the screen; without one it keeps the face of whatever opens it.
  const font = typeof opts.font === 'string' && /^[\w\s,'"-]+$/.test(opts.font.trim()) ? opts.font.trim() : 'inherit';
  const sections = deck.slides
    .map(
      (s) =>
        `<section class="slide"><figure>${s.svg}<figcaption>${s.order}. ${escapeXml(s.label)}</figcaption></figure></section>`,
    )
    .join('\n');
  const body = sections !== '' ? sections : `<section class="slide empty"><p>This board has no presentation frames yet.</p></section>`;
  return [
    '<!doctype html>',
    `<html lang="en"><head><meta charset="utf-8"><title>${docTitle}</title>`,
    '<style>',
    `:root{font-family:${font}}`,
    'body{margin:0;background:#f1f5f9;color:#0f172a}',
    '.slide{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px;box-sizing:border-box}',
    '.slide figure{margin:0;max-width:1100px;width:100%}',
    '.slide svg{width:100%;height:auto;background:#fff;border:1px solid #cbd5e1;border-radius:8px;box-shadow:0 8px 30px rgba(15,23,42,.12)}',
    '.slide figcaption{margin-top:16px;text-align:center;font-size:15px;color:#475569}',
    '.slide.empty p{color:#64748b}',
    '@media print{body{background:#fff}.slide{page-break-after:always;min-height:auto}.slide svg{box-shadow:none}}',
    '</style></head><body>',
    body,
    '</body></html>',
  ].join('\n');
}
