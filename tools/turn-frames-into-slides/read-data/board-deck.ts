// tools/turn-frames-into-slides/read-data/board-deck.ts
//
// Export the board's PRESENTATION FRAMES as an ordered SLIDE DECK — one SVG per frame, in story
// order. The board already has (a) presentation frames with a story order (`boardFrames`), (b)
// frame membership by geometry (`itemsInsideFrame`), and (c) a faithful board→SVG serializer
// (`boardToSvg`, live==export). This is their COMPOSITION: for each frame, render just that frame +
// its contents to an SVG whose viewBox is the frame's own rect (the frame item spans it, so
// boardToSvg frames the slide automatically). Zero new geometry/serialization — a deck is the story
// path passed through the existing exporter (L069/L100). Pure: no I/O; the caller downloads/zips.

import type { BoardItem } from './group-board-model.ts';
import { itemIsConnector } from './group-board-model.ts';
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
 * Serialize a {@link BoardDeck} to ONE printable/openable HTML document — the downloadable deck
 * artifact. Each slide is a full-page `<section>` (its own SVG inline + label caption), page-breaking
 * for print/PDF so "Save as PDF" yields real slides. Pure string composition of the SVGs `boardToDeck`
 * already produced (no new geometry/serialization — same relationship as `boardToDeck` to `boardToSvg`,
 * L069/L100). An empty deck yields a valid document with an honest empty note (never a fake slide).
 */
export function deckToHtml(deck: BoardDeck, opts: DeckHtmlOptions = {}): string {
  const docTitle = escapeXml(opts.title ?? 'Board deck');
  // A look's stylesheet the document carries; one that could end the style element is left out.
  const lookCss = typeof opts.css === 'string' && !/<\/style/i.test(opts.css) ? opts.css : '';
  // Page mode: the same slides, each exactly one page, edge to edge, with no caption or frame chrome.
  const pageCss = opts.page
    ? [
        `@page{size:${Math.max(1, Math.round(opts.page.width))}px ${Math.max(1, Math.round(opts.page.height))}px;margin:0}`,
        'body{background:none}',
        `.slide{width:${Math.max(1, Math.round(opts.page.width))}px;height:${Math.max(1, Math.round(opts.page.height))}px;min-height:0;padding:0;display:block;overflow:hidden;break-after:page;page-break-after:always}`,
        '.slide:last-child{break-after:auto;page-break-after:auto}',
        '.slide figure{max-width:none;height:100%}',
        '.slide svg{display:block;height:100%;border:0;border-radius:0;box-shadow:none;background:none}',
        '.slide figcaption{display:none}',
      ].join('\n')
    : '';
  // The words on the slides as inert records, so a word template can be made from the printed deck itself.
  // `<` is escaped so no text can end the data block; it is JSON, never run.
  const words = (opts.words ?? []).map((w) => ({ id: w.id, fields: { text: w.text, slide: w.slide } }));
  const wordsBlock = words.length
    ? `<script type="application/json" id="slide-words">${JSON.stringify(words).replace(/</g, '\\u003c')}</script>`
    : '';
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
    ':root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}',
    'body{margin:0;background:#f1f5f9;color:#0f172a}',
    '.slide{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px;box-sizing:border-box}',
    '.slide figure{margin:0;max-width:1100px;width:100%}',
    '.slide svg{width:100%;height:auto;background:#fff;border:1px solid #cbd5e1;border-radius:8px;box-shadow:0 8px 30px rgba(15,23,42,.12)}',
    '.slide figcaption{margin-top:16px;text-align:center;font-size:15px;color:#475569}',
    '.slide.empty p{color:#64748b}',
    '@media print{body{background:#fff}.slide{page-break-after:always;min-height:auto}.slide svg{box-shadow:none}}',
    lookCss,
    pageCss,
    '</style>',
    wordsBlock,
    '</head><body>',
    body,
    '</body></html>',
  ].join('\n');
}

/** How {@link deckToHtml} lays the deck out. Every field absent → the browsable deck (one framed slide
 *  per screen, with its caption). */
export interface DeckHtmlOptions {
  readonly title?: string;
  /** Print as pages of exactly this size (CSS px): one slide per page, edge to edge, no caption. */
  readonly page?: { readonly width: number; readonly height: number };
  /** A stylesheet the document carries (a look's variables and font faces). */
  readonly css?: string;
  /** The words on the slides, one `{ id, text, slide }` per text item, kept as inert JSON records. */
  readonly words?: ReadonlyArray<{ readonly id: string; readonly text: string; readonly slide: number }>;
}
