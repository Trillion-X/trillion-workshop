// packages/group/show/item-renderers.tsx
//
// The kind→renderer registry for group board canvas items (UI plan v2.0 §3).
// Item `kind` is a RAW DATA KEY (L090); the canvas renders ITEM_RENDERERS[kind]
// — never a closed union, never `if(kind===)` in the canvas. Adding a new item
// kind = ONE registry DATA row here, ZERO canvas/panel edits (L069 acceptance).
// An unknown kind renders a safe fallback chip, never a crash (blind tolerance).
//
// L065: visuals via ui/ components only (Card/Text/Container/Icon/MediaFrame).

import React from 'react';
import { isRelationAddress } from '../../content-media-evidence/read-data/content-media-evidence';
import { Button, Card, Container, Icon, Spinner, Text, AnchoredOverlay, Input } from '../../ui/index.ts';
import { CanvasFrame } from '../../ui/show/canvas-frame/CanvasFrame';
import { CanvasShape } from '../../ui/show/canvas-shape';
import { DisplayMark } from '../../ui/show/display-mark';
import { RichTextEditor } from '../../ui/show/rich-text-editor/RichTextEditor';
import { readLayoutTogether } from '../../ui/show/read-layout-together/read-layout-together';
import { RichTextToolbar, RICH_FORMAT_COMMANDS } from '../../ui/show/rich-text-toolbar';
import { RichTextPaintControl } from '../../ui/show/rich-text-paint';
import { WorkSkeletonRows } from '../../ui/show/work-start-state';
import { NativeColorInput } from '../../ui/show/native-color-picker';
import { VisualLayerStack, createCapabilityMap, builtinVisualLayerCapabilities } from '../../ui/show/visual-layer-stack';
import { MediaFrame } from '../../ui/show/media-frame/MediaFrame';
import type { VisualLayerDescriptor, CapabilityInvocation } from '../../ui/show/visual-layer-stack';
import type { FormatCommand } from '../../ui/show/rich-text-toolbar';
import { StickyNote, Image as ImageIcon, Film, Sparkles, HelpCircle, ListPlus, FolderOpen, Link as LinkIcon, ExternalLink, Shapes, ChevronDown, Sticker } from 'lucide-react';
import { NamedIcon } from '../../ui/show/icon/NamedIcon';
import { ColorDot } from '../../ui/index.ts';
import { boardItemContentType, readPlaceableSurface, type BoardItem } from '../read-data/group-board-model.ts';
import { PlaceableSurfaceHost } from '../../ui/show/placeable-surface-host';
import { hostFromHref, faviconUrl, readLinkPreview, linkPreviewImages } from '../do-work/link-preview.ts';
import { LinkGallery } from './LinkGallery.tsx';
import { readFrameBorder } from '../do-work/frame-border.ts';
import { openExternalHref } from '../do-work/open-external.ts';
import { isCrop } from './crop-rect.ts';
import { BOARD_SHAPES, shapeSvgPathById, shapeGeometryById } from './board-shapes.ts';
import { shapeOutlinePoints } from '../do-work/shape-geometry.ts';
import { BOARD_STAMPS, stampEmojiById, STAMP_CATALOG_KIND, type BoardStamp } from './board-stamps.ts';
import { markerById, markerCellForIndex, resolveLevelMarkers, type BoardMarker } from './board-marker-catalog.ts';
import { OutlineDisplay } from './OutlineDisplay.tsx';
import { BOARD_FILL_SWATCHES, seededFillStack, BOARD_ITEM_LAYER_REGISTRY, itemFillColor, FILL_SWATCH_CATALOG_KIND } from './item-fill.ts';
import { readableInkFor } from './item-ink.ts';
import { ownValue } from '../read-data/facet-filter.ts';
import { cardProgressView } from '../read-data/card-progress-view.ts';
import { highlightHtml } from '../read-data/highlight-html.ts';
import { linkifyHtml } from '../read-data/linkify-html.ts';
import { noteDisplayTags } from './item-tags.ts';
import { TagChipStrip } from './TagChipStrip.tsx';
import { MediaPaletteStrip } from './MediaPaletteStrip.tsx';
import { CardProgressStrip } from './CardProgressStrip.tsx';
import type { AddShelfEntry } from './item-add-strategies';
import type {
  ActionAffordance,
  ActionAffordanceTrigger,
  AskField,
} from '../../ui/show/action-affordance';
import { useRevealedLength } from '../../ui/show/text-reveal';
import { fitNoteHeight, noteHeightChanged } from './note-autofit.ts';
import { resolveAppearanceKey, sizeModeStyle, sizeModeIsAutoHeight } from './item-appearance.ts';
import { useElapsedSeconds, formatElapsed } from './use-elapsed.ts';
import { contentPlacement, contentAnchorFrom } from '../do-work/content-placement.ts';
import { elevationShadow } from '../do-work/elevation-shadow.ts';
import { shadowCss, type TuningShadow } from '../../ui/show/tuning-panel';
import { filterCssById } from './filter-presets.ts';
import { strokePathD, hashSeed, resolveStroke, type Point } from './stroke-style.ts';
import { sendRequestToBitfieldTarget } from '#workspace-records';
import {
  readGuardedArtifactObjectUrl,
  type GuardedArtifactObjectUrl,
} from '../../ui/show/media-bytes/read-guarded-artifact-blob';

// Card `padding="md"` is p-4 (16px) top+bottom → 32px of vertical chrome around the
// measured note content (#217).
const NOTE_CARD_CHROME_Y = 32;

export interface ItemRendererProps {
  readonly item: BoardItem;
  readonly selected: boolean;
  /** True iff this item is in inline edit mode — the panel owns the toggle. */
  readonly editing?: boolean;
  /** Commit a rich edit: the HTML body + its plain-text projection (preview/search). */
  readonly onEditHtml?: (html: string, text: string) => void;
  /** Leave edit mode (the panel clears its editing id). */
  readonly onEndEdit?: () => void;
  /** True iff this item is the ACTIVE embedded surface — a live placeable-surface
   *  node the user has "entered" (double-click). While active, the mounted surface
   *  receives pointer events (interactive); otherwise it is pointer-inert so the
   *  canvas owns drag/select/marquee. Ignored by non-placeable items. */
  readonly embeddedActive?: boolean;
  /** True iff a custom visual-layer-stack supplies this item's surface — the
   *  renderer drops its own opaque card chrome so the stack (paper/fill/effect)
   *  shows through. Set by {@link LayeredItem} when the item carries layers. */
  readonly bare?: boolean;
  /** The rich-text toolbar commands for a NOTE editor — the panel injects this so a
   *  surface can add its saved-text-styles "Styles" command (DATA + persist) on top of
   *  the defaults. Absent → the built-in {@link RICH_FORMAT_COMMANDS}. */
  readonly noteCommands?: ReadonlyArray<FormatCommand>;
  /** #217 — a note derives its height from its text so content is never clipped. The
   *  renderer measures the rendered content and reports the height the node should take
   *  at its current width; the panel patches the item's `h` (a layout write, not undoable).
   *  Absent → no auto-height (e.g. non-note renderers). */
  readonly onAutoHeight?: (memberId: string, height: number) => void;
  /** #225 (P1) — the active board's appearance-defaults profile (the MIDDLE cascade
   *  tier: item override → THIS → global). An opaque key bag handed verbatim to
   *  `resolveAppearanceKey`; the renderer never enumerates its keys (L090).
   *  Absent → item override or global default only (today's behavior). */
  readonly boardAppearance?: Record<string, unknown>;
  /** R3/P2 — the note's 0-based position among its list siblings, used ONLY by
   *  index-derived markers (ordinal `1. 2. 3.`, cycle glyph rotation). Glyph markers
   *  ignore it. Absent → 0 (a single note's decimal marker reads "1."). The caller
   *  (layout that knows sibling order) supplies the real index; the renderer stays blind. */
  readonly markerIndex?: number;
  /** R3/P2 — the board's EFFECTIVE marker catalog (built-ins + user-defined DATA rows, from
   *  `readMarkerCatalog`). The note resolves `extra.marker` against THIS, so a DATA-defined
   *  marker renders on the real note (not just the picker). Absent → built-in catalog only. */
  readonly markerCatalog?: readonly BoardMarker[];
  /** STREAMING REVEAL (item #9): when set (a freshly-produced AI result's text), the
   *  note types it in progressively on first render — the "characters coming out" effect
   *  — via the shared `useRevealedLength` scheduler (SSOT with composition), settling to
   *  the persisted html. Absent → the note renders whole (every existing note, zero
   *  change). The board fills this for members that just landed a producer result. */
  readonly revealText?: string;
  /** The active board SEARCH query. While non-empty, the note's matching text is wrapped in `<mark>`
   *  (display only — the read-only `RichTextEditor`) so the hit GLOWS in the card, completing the find
   *  UX (count → step → reveal → HIGHLIGHT). Absent/empty → the note renders unmarked (zero change). */
  readonly highlightQuery?: string;
}

/** A board card always keeps its own surface — selection is NOT expressed by
 *  swapping the background (that made selected cards look like they vanished).
 *  Selection chrome is the generic accent ring drawn by CanvasNode.
 *  #225 (P1): the variant resolves through the appearance CASCADE (item override →
 *  board default → global 'surface') for EVERY card-backed renderer — one rule,
 *  not a per-renderer hardcode (L063). Selection still never swaps the surface. */
function cardVariant(
  item: BoardItem,
  boardAppearance: Record<string, unknown> | undefined,
): 'surface' | 'ghost' | 'elevated' | 'panel' {
  return resolveAppearanceKey('containerVariant', item.extra?.containerVariant, boardAppearance) as
    | 'surface'
    | 'ghost'
    | 'elevated'
    | 'panel';
}

/** Escape + line-break a plain-text body into safe seed HTML (legacy plain notes).
 *  Exported so a text WRITE (e.g. rename) can keep a note's `html` in sync with its
 *  `text` — the read-only render prefers `item.html`, so writing `text` alone would
 *  leave a stale `html` showing the OLD value (#154). */
export function textToHtml(text: string): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

/** Strip tags to test whether rich HTML actually carries content (vs empty markup). */
/** A shadow kept on an item by the inspector, or null when it has none (or it is unreadable). */
function readShadowValue(value: unknown): TuningShadow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const n = (key: string) => (typeof row[key] === 'number' && Number.isFinite(row[key]) ? (row[key] as number) : 0);
  return { x: n('x'), y: n('y'), blur: n('blur'), spread: n('spread'), colour: typeof row.colour === 'string' ? row.colour : '#000000', opacity: typeof row.opacity === 'number' ? row.opacity : 1 };
}

function htmlHasContent(html: string): boolean {
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim().length > 0;
}

/**
 * A note: composition-grade rich text. The panel toggles `editing`; in edit mode the
 * shared `RichTextEditor` owns the contentEditable and commits its HTML + plain-text
 * projection on blur. In view mode the SAME primitive renders the HTML read-only (one
 * component, two states — no bespoke display markup, L065). A note with no content
 * shows a muted placeholder. Backward-compatible: a legacy plain-`text` note seeds from
 * its escaped text and is upgraded to `html` on first edit.
 */
/** Registry stamped onto note-text paint layers (provenance; lookup is by id). */
const NOTE_TEXT_LAYER_REGISTRY = { family: 'group.note-text-layers', parts: {} } as const;

function NoteItem({ item, selected, editing, onEditHtml, onEndEdit, bare, noteCommands, onAutoHeight, boardAppearance, markerIndex, markerCatalog, revealText, highlightQuery }: ItemRendererProps) {
  const editorRef = React.useRef<HTMLDivElement | null>(null);
  const seedHtml = item.html ?? textToHtml(item.text ?? '');
  // Search-match highlight (display only): while a board search is active, wrap the note's matching text
  // in <mark> so the hit glows in the card. Memoised so the DOMParser walk runs only when the html or the
  // query changes, not every render; empty query → seedHtml verbatim (zero churn). The read-only editor
  // re-seeds innerHTML when this changes, so toggling the query lights/clears the marks live.
  const displayHtml = React.useMemo(
    // Read-only decoration only (never the edit path): search-highlight the matches, then linkify bare
    // URLs/emails/phones into safe anchors. Both walk text nodes of the already-sanitised html; linkify runs
    // AFTER highlight and skips <mark>/<a>, so a hit inside a link and a link inside a hit never double-wrap.
    () => linkifyHtml(highlightQuery ? highlightHtml(seedHtml, highlightQuery) : seedHtml),
    [seedHtml, highlightQuery],
  );
  const commitHtml = React.useCallback(
    (root: HTMLElement) => onEditHtml?.(root.innerHTML, root.textContent ?? ''),
    [onEditHtml],
  );

  // Entering edit mode focuses the editor with the caret at the end, ready to type.
  React.useEffect(() => {
    if (!editing) return;
    const root = editorRef.current;
    if (!root) return;
    root.focus();
    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.selectNodeContents(root);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }, [editing]);

  // #217 — a note's height follows its text so content is never clipped. This hook is
  // declared unconditionally (Rules of Hooks) but only measures in VIEW mode: it reads the
  // read-only content root's natural height (height:auto → scrollHeight is the full text
  // height even when the card box clips it) and reports the height the node should take at
  // its current width. GROW-ONLY (minH = current h): a note that already fits is never
  // touched; only a note whose text overflows its box grows. The measure→patch cycle
  // converges in one step. Skipped while editing (the editor owns the box) and for
  // shaped/bare nodes (their silhouette owns the box).
  // #225 (P1): only the `fit` size mode grows the box to its text. `fill`/`scroll` PIN the box
  // to the user's height (content stretches or scrolls inside), so auto-height must not fire.
  // The size mode flows through the FULL cascade: item extra → board default → global 'fit'.
  const sizeMode = resolveAppearanceKey('sizeMode', item.extra?.sizeMode, boardAppearance);
  const autoHeights = sizeModeIsAutoHeight(sizeMode);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  // STREAMING REVEAL: a freshly-produced AI result (revealText set) types in via the
  // shared React scheduler — the note renders `revealText.slice(0, revealCount)` while
  // revealing, then settles to its persisted html. One-shot per landing; not while editing.
  const revealActive = !!revealText && !editing;
  const revealCount = useRevealedLength(revealText?.length ?? 0, revealActive);
  const revealing = revealActive && revealCount < (revealText?.length ?? 0);
  React.useLayoutEffect(() => {
    if (editing || bare || !autoHeights || !onAutoHeight) return;
    // Read with every other note's read of this render, once the render has written the page: one layout for the
    // whole board instead of one per note (a note's text written after another note measured made the browser lay
    // the board out again for each).
    return readLayoutTogether(() => {
      const el = contentRef.current;
      if (!el) return;
      const fitH = fitNoteHeight(el.scrollHeight, { minH: item.h, chrome: NOTE_CARD_CHROME_Y });
      if (noteHeightChanged(item.h, fitH)) onAutoHeight(item.memberId, fitH);
    });
    // `revealCount` is a dep so the note re-measures + grows each reveal frame as the
    // typed-in text wraps to more lines (the streaming reflow — grow-only, so it never
    // collapses; it settles at the full height when the reveal completes).
  }, [editing, bare, autoHeights, item.html, item.text, item.w, item.h, item.memberId, onAutoHeight, revealCount]);

  if (editing) {
    // `bare` (a shaped node) → a transparent card so the shape fill shows through
    // while its text is edited; otherwise the standard elevated editor card.
    return (
      <Card variant={bare ? 'ghost' : 'elevated'} padding="md">
        {/* The toolbar floats ABOVE the editor in a portal (AnchoredOverlay), so it
            can NEVER be clipped by the note card's bounds (a user's bug 2). It carries
            the full rich controls (emphasis/headings/align/lists/link/font) PLUS the
            infinite text Paint control (colour/gradient/mesh/edge clipped to the
            glyphs — even one selected letter). All fire on pointer-down with
            preventDefault, so the editor keeps focus and never blur-commits. */}
        <AnchoredOverlay
          anchorRef={editorRef}
          open={!!editing}
          placement="above"
          matchAnchorWidth
          flagAttr="data-rich-text-toolbar-panel"
        >
          <Card variant="panel" padding="sm" radius="lg">
            <Container layout="horizontal" gap="xs" wrap alignItems="center">
              <RichTextToolbar commands={noteCommands ?? RICH_FORMAT_COMMANDS} />
              <RichTextPaintControl
                editorRootRef={editorRef}
                capabilities={builtinVisualLayerCapabilities}
                registry={NOTE_TEXT_LAYER_REGISTRY}
                onCommit={commitHtml}
                label="Paint text (color / gradient / mesh)"
              />
            </Container>
          </Card>
        </AnchoredOverlay>
        <RichTextEditor
          editorHtml={seedHtml}
          editorRef={editorRef}
          placeholder="Write…"
          onInput={(root) => {
            // #219 — grow the note to fit the text WHILE typing (FigJam sticky model), so
            // content is never clipped mid-type — the edit-time twin of the on-blur/view
            // measurement above. Reuses the same fit primitives. Safe: this patches only
            // the node `h`, which never changes `seedHtml` (the editor's `editorHtml`), so
            // RichTextEditor's `[editorHtml]`-gated re-seed never fires and the caret/live
            // text are preserved. Grow-only (minH = item.h); converges once the box fits.
            if (!onAutoHeight || !autoHeights) return; // #225: fill/scroll pin the box
            const fitH = fitNoteHeight(root.scrollHeight, { minH: item.h, chrome: NOTE_CARD_CHROME_Y });
            if (noteHeightChanged(item.h, fitH)) onAutoHeight(item.memberId, fitH);
          }}
          onBlur={(e) => {
            // Commit is idempotent — always persist the current HTML on any blur.
            const root = editorRef.current;
            if (root && onEditHtml) onEditHtml(root.innerHTML, root.textContent ?? '');
            // The edit session spans MANY portaled layers: the toolbar, the paint
            // panel, and their OWN nested popovers (the Add-layer menu, a colour
            // picker). All carry the shared `data-floating-layer` marker, and focus
            // inside the editor's own DOM is also in-session. Ask ONE question — did
            // focus settle inside any of those — instead of enumerating each panel.
            const inSession = (el: Element | null): boolean =>
              !!el && (!!root?.contains(el) || !!el.closest?.('[data-floating-layer]'));
            if (inSession(e.relatedTarget as Element | null)) return;
            // A Radix-portaled popover juggles focus (often a blur with a null or
            // foreign relatedTarget mid-transition), so decide only AFTER focus
            // settles. End the session solely when focus has landed OUTSIDE the editor
            // and every floating layer. `onEndEdit` is id-scoped in the host, so a
            // deferred end can never clear a note that started editing meanwhile.
            requestAnimationFrame(() => {
              if (inSession(document.activeElement)) return;
              onEndEdit?.();
            });
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') e.currentTarget.blur();
          }}
        />
      </Card>
    );
  }

  const hasContent = item.html ? htmlHasContent(item.html) : !!item.text;
  // #225 (P1) — the container variant flows through the appearance CASCADE (item override →
  // board default → global 'surface'), not the hardcoded `surfaceVariant()`. The size mode
  // (fit/fill/scroll) is applied to the Card: `fit` → no extra style (auto-height owns it, zero
  // change for every existing note); `fill`/`scroll` fill the node box (pinned, since auto-height
  // is gated off above) so content stretches (fill) or scrolls (scroll) inside it. sizeModeStyle
  // is spread LAST so its overflow wins over frameCardProps' rounded-corner overflow:hidden.
  const containerVariant = resolveAppearanceKey('containerVariant', item.extra?.containerVariant, boardAppearance) as
    | 'surface'
    | 'ghost'
    | 'elevated'
    | 'panel';
  // #225 (P1) — note-card DENSITY flows through the SAME cascade (item override → board default →
  // global 'md'), dissolving the last hardcoded `padding="md"`. Card's padding scale is the value
  // domain, so the resolved value passes straight through — a new density is one PADDING_OPTIONS row.
  const padding = resolveAppearanceKey('padding', item.extra?.padding, boardAppearance) as
    | 'none'
    | 'xs'
    | 'sm'
    | 'md'
    | 'lg';
  const fp = frameCardProps(item);
  const fills = !autoHeights;
  // cont.21 — READABLE INK: when the note carries a fill, set the card's base text colour to the
  // WCAG-max-contrast ink (dark fill → light text, light fill → dark text) so its words stay legible
  // on ANY fill, via ONE luminance fn (zero per-colour code, L069). Inherited by the RichTextEditor
  // + marker; an explicit rich-text span colour still wins by specificity. No fill → no override →
  // byte-identical (zero regression). Reads the SAME itemFillColor accessor the swatch editor writes.
  const noteInk = readableInkFor(itemFillColor(item));
  // cont.26 (E2) — FONT FAMILY flows through the SAME appearance CASCADE (item override → board
  // default → global). Set on the card root so the RichTextEditor (font: inherit) + marker + Text
  // all pick it up — a "handwritten"/sketch font is one DATA value, never a code branch (L090).
  // GLOBAL has no fontFamily key → absent → undefined → system font (byte-identical, zero regression).
  const fontFamily = resolveAppearanceKey('fontFamily', item.extra?.fontFamily, boardAppearance);
  // cont.26 (Line-style for BORDERS) — resolve the note's NAMED border brushstroke (`borderStrokeStyle`)
  // + raw `borderRoughness` into {roughness, bowing, dash} through the SAME `resolveStroke` SSOT the
  // connectors use. A pencil/marker/sketch style draws a rough overlay; a pure-dash style (dashed/dotted,
  // roughness 0) draws a CRISP dashed outline and suppresses the card's own solid border (borderColor
  // transparent below) so only the dashed border shows; solid → the plain card (byte-identical).
  const borderStyleId = resolveAppearanceKey('borderStrokeStyle', item.extra?.borderStrokeStyle, boardAppearance);
  const borderStroke = resolveStroke(
    typeof borderStyleId === 'string' ? borderStyleId : undefined,
    Number(resolveAppearanceKey('borderRoughness', item.extra?.borderRoughness, boardAppearance)) || undefined,
  );
  const borderActive = borderStroke.roughness > 0 || Boolean(borderStroke.dash);
  const borderDashOnly = borderStroke.roughness <= 0 && Boolean(borderStroke.dash);
  // Content placement (Figma/FigJam sticky-note canon): WHERE the note's text sits in its box, flowing
  // through the SAME appearance cascade (item override → board default → global). The value is a preset id
  // OR a raw {nx,ny}; the blind `content-placement` leaf maps it to justify/align/text-align. Absent → null
  // → no placement style at all (top-left flow, byte-identical, zero regression). Applied as an OPTIONAL
  // flex wrapper around the content so vertical alignment works when the card is taller than its text.
  const contentAnchor = contentAnchorFrom(
    resolveAppearanceKey('contentAnchor', item.extra?.contentAnchor, boardAppearance),
  );
  const placement = contentAnchor ? contentPlacement(contentAnchor.nx, contentAnchor.ny) : null;
  // Card ELEVATION (Miro/FigJam depth cue): a signed level flows through the SAME cascade → the blind
  // `elevationShadow` formula (raised >0 / flat 0 / pressed <0). Absent/0 → no inline box-shadow (the
  // card's own variant shadow, if any, shows through) → byte-identical, zero regression.
  const elevation = Number(resolveAppearanceKey('elevation', item.extra?.elevation, boardAppearance)) || 0;
  const ownShadow = readShadowValue(item.extra?.shadow);
  const cardStyle = {
    ...(fills ? { ...fp.style, height: '100%', boxSizing: 'border-box' as const, ...sizeModeStyle(sizeMode) } : fp.style),
    ...(noteInk ? { color: noteInk } : {}),
    ...(typeof fontFamily === 'string' && fontFamily ? { fontFamily } : {}),
    // A pure-dash border replaces the card's solid border — hide it so the two don't double up.
    ...(borderDashOnly ? { borderColor: 'transparent' as const } : {}),
    ...(placement ? { textAlign: placement.textAlign } : {}),
    // A shadow set in the inspector (already in the frame style) wins over the elevation level.
    ...(elevation && !ownShadow ? { boxShadow: elevationShadow(elevation) } : {}),
  };
  // R3/P2 — a note's list marker is self-describing DATA: `extra.marker` is a marker id
  // resolved by the pure catalog to a MarkerCell — the renderable to draw before the text.
  // A text cell (glyph/emoji/ordinal/cycle) draws a Text; a media cell (image/video) draws a
  // bullet-sized MediaFrame (which dispatches img/video by mediaType, L090). All via the
  // injected producer map — ZERO branch on marker kind here. Absent/unknown → empty cell →
  // no prefix (today's behavior, zero regression). Blind renderer (L090). "A bullet can be
  // literally anything" (a user) — char, number, emoji, image, or video, one descriptor.
  // Per-item marker overrides are user content (a user's "whatever they want it to be"): the
  // catalog row carries the KIND, the item carries the user's value — a media URL (image/video)
  // OR a custom glyph (ANY char/emoji, produce:'glyph' + needsGlyph). Overlay both onto the
  // resolved catalog marker before producing the cell; the catalog is unchanged (L090).
  // The marker id flows through the appearance CASCADE (item override → board default → global):
  // a list/checklist board can default EVERY note to a glyph (`board.appearance.marker`), while a
  // per-item `extra.marker` still wins and "Default"/absent falls back to no marker (GLOBAL has no
  // marker key → zero-regression). Same generic resolver every other appearance key uses (L090).
  const resolvedMarkerId = resolveAppearanceKey('marker', item.extra?.marker, boardAppearance);
  const resolvedMarker = markerById(typeof resolvedMarkerId === 'string' ? resolvedMarkerId : undefined, markerCatalog);
  const markerMediaUrl = typeof item.extra?.markerMediaUrl === 'string' ? item.extra.markerMediaUrl : undefined;
  const markerGlyph = typeof item.extra?.markerGlyph === 'string' ? item.extra.markerGlyph : undefined;
  const overlaidMarker = resolvedMarker
    ? {
        ...resolvedMarker,
        ...(markerMediaUrl ? { mediaUrl: markerMediaUrl } : {}),
        ...(markerGlyph ? { glyph: markerGlyph } : {}),
      }
    : resolvedMarker;
  const markerCell = markerCellForIndex(overlaidMarker, markerIndex ?? 0);
  const hasMarker = !!(markerCell.text || markerCell.mediaUrl);
  // R3 outline mode (opt-in DATA, zero regression): when the note carries
  // `extra.contentMode === 'outline'`, its text renders as a nested marked outline — each row
  // numbered within its level and prefixed by the note's OWN list marker (same DATA that draws
  // its board bullet). A note without contentMode renders exactly as before (RichTextEditor).
  const isOutlineMode = item.extra?.contentMode === 'outline' && hasContent;
  // Multi-level outline (opt-in DATA): `extra.outlineMarkers` is an ordered list of marker ids,
  // one per nesting level (`1.`/`a)`/`i.` — the legal-outline convention). Resolved against the
  // effective catalog and handed to OutlineDisplay; absent → the single marker on every level.
  const outlineLevelMarkers =
    isOutlineMode && Array.isArray(item.extra?.outlineMarkers)
      ? resolveLevelMarkers((item.extra.outlineMarkers as unknown[]).filter((x): x is string => typeof x === 'string'), markerCatalog)
      : undefined;
  const body = isOutlineMode ? (
    <OutlineDisplay text={item.text ?? ''} marker={overlaidMarker} levelMarkers={outlineLevelMarkers} />
  ) : hasContent ? (
    <RichTextEditor
      readOnly
      editorHtml={revealing ? textToHtml(revealText!.slice(0, revealCount)) : displayHtml}
      editorRef={contentRef}
    />
  ) : (
    <Text variant="body-sm" color="muted">New note</Text>
  );
  // TAG CHIPS (b101): a note's stored tags UNIFIED with the #hashtags in its body (b100 detection) render as
  // stably-coloured chips below the text — #gardening is the SAME colour on every note (content-hashed, not by
  // order). Part of the measured content, so #217 auto-height grows to include it. Skipped for a bare shaped
  // node (silhouette owns the box) and during a streaming reveal; a tag-less note → no strip → byte-identical.
  const displayTags = bare || revealing ? [] : noteDisplayTags(item, item.text);
  const bodyWithTags = displayTags.length > 0 ? (
    <Container layout="vertical" gap="xs">
      {body}
      <TagChipStrip tags={displayTags} />
    </Container>
  ) : (
    body
  );
  const cardInner = hasMarker ? (
    <Container layout="horizontal" gap="xs" alignItems="start">
      {markerCell.mediaUrl ? (
        <Container minWidth="22px">
          <MediaFrame
            url={markerCell.mediaUrl}
            mediaType={markerCell.mediaType ?? 'image/*'}
            label="List marker"
            transform={{ width: 22, height: 22 }}
          />
        </Container>
      ) : (
        <Text variant="body-sm">{markerCell.text}</Text>
      )}
      <Container layout="vertical" gap="none" flex={1} minWidth="0">{bodyWithTags}</Container>
    </Container>
  ) : (
    bodyWithTags
  );
  // When a content anchor is set, place the content with a full-size flex column (vertical placement needs
  // a definite height to bite); absent → the content flows exactly as before (no wrapper, zero regression).
  const placedInner = placement ? (
    <Container
      layout="vertical"
      style={{ height: '100%', width: '100%', justifyContent: placement.justifyContent, alignItems: placement.alignItems }}
    >
      {cardInner}
    </Container>
  ) : (
    cardInner
  );
  const card = (
    <Card variant={bare ? 'ghost' : containerVariant} padding={padding} {...fp} style={cardStyle}>
      {placedInner}
    </Card>
  );
  // At-a-glance PROGRESS: a card tracking completion (metric or checklist) shows a thin fill strip
  // pinned to its bottom edge (Trello/Asana pattern) — an ABSOLUTE overlay, so it never consumes
  // content height (no clip, no fight with #217 auto-height) and never overlaps the text. Only when
  // `cardProgressView` is non-null (a plain note → no strip → byte-identical, zero regression); not on
  // `bare` shaped nodes (their silhouette owns the box). The strip is blind — the metric-vs-checklist
  // choice lives in the `cardCompletion` SSOT the sort + rollup also read (L090).
  const progress = bare ? null : cardProgressView(item);
  const progressStrip = progress ? <CardProgressStrip percent={progress.percent} complete={progress.complete} /> : null;
  // cont.26 (Line-style BORDER) — a NAMED border brushstroke draws the note's outline OVER the card via
  // `strokePathD` (a viewBox-scaled rect, stable per memberId): pencil/marker/sketch bow (bowing now
  // flows), dashed/dotted draw a crisp dashed outline. `strokePathD` returns ONE crisp path at roughness
  // 0 and TWO bowed paths above it, so both cases share this overlay. A solid style → the plain card,
  // byte-identical. The overlay is pointer-transparent so it never affects hit-testing.
  if (!borderActive) {
    // No border overlay: return the bare card unchanged (zero regression) unless a progress strip
    // needs a positioning context, in which case wrap it in the same relative container the border
    // path uses.
    return progressStrip ? (
      <Container position="relative" style={{ width: '100%', height: '100%' }}>
        {card}
        {progressStrip}
      </Container>
    ) : (
      card
    );
  }
  const m = 2.5;
  const rectPts: Point[] = [
    { x: m, y: m }, { x: item.w - m, y: m }, { x: item.w - m, y: item.h - m }, { x: m, y: item.h - m }, { x: m, y: m },
  ];
  const borderPaths = strokePathD(rectPts, { roughness: borderStroke.roughness, bowing: borderStroke.bowing, doubleStroke: true }, hashSeed(item.memberId));
  return (
    <Container position="relative" style={{ width: '100%', height: '100%' }}>
      {card}
      {progressStrip}
      <svg
        viewBox={`0 0 ${Math.max(1, item.w)} ${Math.max(1, item.h)}`}
        preserveAspectRatio="none"
        width="100%"
        height="100%"
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'visible' }}
        aria-hidden
      >
        {borderPaths.map((d, i) => (
          <path key={i} d={d} fill="none" stroke="var(--ink-strong, #1f2937)" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={borderStroke.dash} opacity={borderPaths.length > 1 && i === 1 ? 0.6 : 1} />
        ))}
      </svg>
    </Container>
  );
}

/**
 * Any uploaded media — image, video, or audio. ONE renderer: `MediaFrame`
 * dispatches the right element by the real `contentType` (L090), so dropping a
 * `.mp4` plays a video and an image renders an image with zero kind branch here.
 */
type BoardMediaSource =
  | { readonly kind: 'guarded-relation'; readonly relationRef: string }
  | { readonly kind: 'public-url'; readonly url: string }
  | { readonly kind: 'unavailable' };

/** Board-persisted uploads are opaque relation identities. Public browser URLs
 * are the only non-owner source MediaFrame may receive; unrecognized source
 * text stays unavailable rather than being reinterpreted as storage. */
export function boardMediaSource(src: string): BoardMediaSource {
  const value = src.trim();
  if (isRelationAddress(value)) return { kind: 'guarded-relation', relationRef: value };
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'blob:') {
      return { kind: 'public-url', url: value };
    }
  } catch {
    // A non-URL is never safe to reinterpret as a media source.
  }
  return { kind: 'unavailable' };
}

function UnavailableMedia({ label }: { readonly label: string }) {
  return (
    <Container height="full" layout="vertical" alignItems="center" justifyContent="center" padding="md">
      <Text variant="body-sm" color="faint">{label}</Text>
    </Container>
  );
}

function GuardedMediaFrame({
  relationRef,
  label,
  transform,
  showPalette,
}: {
  readonly relationRef: string;
  readonly label: string;
  readonly transform: React.ComponentProps<typeof MediaFrame>['transform'];
  readonly showPalette: boolean;
}) {
  const [opened, setOpened] = React.useState<GuardedArtifactObjectUrl | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    let delivery: GuardedArtifactObjectUrl | null = null;
    setOpened(null);
    setFailed(false);
    void readGuardedArtifactObjectUrl(relationRef, sendRequestToBitfieldTarget)
      .then((result) => {
        delivery = result;
        if (cancelled) {
          result.revoke();
          return;
        }
        setOpened(result);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      delivery?.revoke();
    };
  }, [relationRef]);

  if (failed) return <UnavailableMedia label="Media could not be safely displayed." />;
  if (!opened) return <UnavailableMedia label="Loading media…" />;
  return (
    <>
      <MediaFrame url={opened.url} mediaType={opened.mediaType} label={opened.displayName || label} transform={transform} />
      {showPalette ? <MediaPaletteStrip url={opened.url} /> : null}
    </>
  );
}

function MediaItem({ item, selected, boardAppearance }: ItemRendererProps) {
  if (!item.src)
    return (
      <PlaceholderItem icon={ImageIcon} label={item.text ?? 'Media'} selected={selected} variant={cardVariant(item, boardAppearance)} />
    );
  // Crop + color filter ride self-describing DATA (`extra.crop` 0..1, `extra.imageFilter`
  // a CSS filter string); the blind MediaFrame applies them (absent → the whole, unfiltered
  // image). Both compose on the same <img> (crop = sizing, filter = CSS `filter`).
  const crop = isCrop(item.extra?.crop) ? (item.extra.crop as { x: number; y: number; w: number; h: number }) : undefined;
  // Filter resolution (b97): a per-item RAW `extra.imageFilter` CSS string wins (backward-compatible); else
  // a preset id flows through the SAME appearance cascade every other key uses (per-item `extra.photoFilter`
  // → board default `photoFilter` → global), resolved to CSS by the shared `filter-presets` catalog. So a
  // board can theme EVERY image at once (a whole mood board in B&W/Sepia) while a per-item look still wins.
  // Absent everywhere → no filter (GLOBAL has no photoFilter key → byte-identical, zero regression).
  const rawFilter = typeof item.extra?.imageFilter === 'string' && item.extra.imageFilter ? item.extra.imageFilter : undefined;
  const presetId = resolveAppearanceKey('photoFilter', item.extra?.photoFilter, boardAppearance);
  const cascadeFilter = typeof presetId === 'string' && presetId ? filterCssById(presetId) || undefined : undefined;
  const filter = rawFilter ?? cascadeFilter;
  const transform = crop || filter ? { ...(crop ? { crop } : {}), ...(filter ? { filter } : {}) } : undefined;
  // b102 — opt-in image colour palette: when the board turns `showPalette` on (cascade, off by default), an
  // absolute swatch strip of the image's median-cut palette rides the bottom edge (never resizes the media).
  // Off/absent → no strip → byte-identical, zero regression. The strip fails closed on a CORS-tainted image.
  const showPalette = !!resolveAppearanceKey('showPalette', item.extra?.showPalette, boardAppearance);
  const fcp = frameCardProps(item);
  const source = boardMediaSource(item.src);
  return (
    <Card
      variant={cardVariant(item, boardAppearance)}
      padding="none"
      {...fcp}
      style={showPalette ? { ...fcp.style, position: 'relative' } : fcp.style}
    >
      {source.kind === 'guarded-relation' ? (
        <GuardedMediaFrame
          relationRef={source.relationRef}
          label={item.text ?? 'Board media'}
          transform={transform}
          showPalette={showPalette}
        />
      ) : source.kind === 'public-url' ? (
        <>
          <MediaFrame url={source.url} mediaType={boardItemContentType(item)} label={item.text ?? 'Board media'} transform={transform} />
          {showPalette ? <MediaPaletteStrip url={source.url} /> : null}
        </>
      ) : <UnavailableMedia label="Media could not be safely displayed." />}
    </Card>
  );
}

/**
 * A producer placeholder — the visible in-flight state for ANY producer (single-artifact
 * or multi-item). While a job is running (`extra.status === 'pending'`) it shows a LIVE
 * animated spinner. On completion the placeholder is either filled (single `src`) or
 * REPLACED by the produced items (multi-item). On error or unconfigured state it shows
 * the owner-supplied copy from DATA — no leaks of product vocabulary are authored here.
 * We never fake progress (L117): no spinner unless a real job is actually running.
 */
function PendingItem({ item, selected, boardAppearance }: ItemRendererProps) {
  // Hook FIRST (Rules of Hooks) — before any conditional return below.
  const elapsedSeconds = useElapsedSeconds(item.extra?.started_at);
  if (item.src) return <MediaItem item={item} selected={selected} boardAppearance={boardAppearance} />;
  const status = typeof item.extra?.status === 'string' ? item.extra.status : undefined;
  const message = typeof item.extra?.message === 'string' ? item.extra.message : undefined;
  const toolCopy = item.extra?.toolCopy && typeof item.extra.toolCopy === 'object'
    ? (item.extra.toolCopy as Record<string, unknown>)
    : undefined;
  const unconfiguredLabel = typeof toolCopy?.unconfiguredLabel === 'string' ? toolCopy.unconfiguredLabel : '';
  const connectLabel = typeof toolCopy?.connectLabel === 'string' ? toolCopy.connectLabel : '';
  const pending = status === 'pending';
  if (pending) {
    // Live-production state (Mobbin-grounded: Gamma skeleton-ahead + Jasper status line).
    // The owner DATA decides how many slots are coming (`total_hint`) and the live copy
    // (`message`/`toolCopy.workingLabel`); the board renders blind. A single-artifact
    // producer hints 1; a multi-item producer (e.g. one that yields several steps)
    // hints N, so the user sees the SHAPE of what's coming instead of a dead spinner.
    // `total_hint: 0` → NO skeleton-ahead rows at all (a compact status chip): the honest
    // in-flight state for a RECONCILE/reorganize that edits existing notes in place rather
    // than producing N new artifacts — skeleton-ahead ("N new things coming") would be a
    // lie there. Absent → 1 (unchanged for every existing single-artifact producer).
    const hintRaw = typeof item.extra?.total_hint === 'number' ? item.extra.total_hint : 1;
    const rows = Math.max(0, Math.min(hintRaw, 9));
    const workingLabel = message
      ?? (typeof toolCopy?.workingLabel === 'string' ? toolCopy.workingLabel : 'Working…');
    return (
      <Card variant="elevated" padding="md">
        <Container layout="vertical" gap="sm">
          <Container layout="horizontal" gap="xs" alignItems="center">
            <Spinner size="sm" />
            <Text variant="body-sm" color="accent">{workingLabel}</Text>
            {elapsedSeconds != null ? (
              <Text variant="body-xs" color="muted">· {formatElapsed(elapsedSeconds)}</Text>
            ) : null}
            {item.text ? <Text variant="body-xs" color="muted">· {item.text}</Text> : null}
          </Container>
          {elapsedSeconds != null && elapsedSeconds >= 45 ? (
            <Text variant="body-xs" color="muted">Still working — this one is taking a little longer than usual.</Text>
          ) : null}
          {rows > 0 ? <WorkSkeletonRows rows={rows} /> : null}
        </Container>
      </Card>
    );
  }
  // Owner-supplied copy for error / unconfigured states — the board never authors words.
  const headline = status === 'error'
    ? (message ?? "That didn't work — try again")
    : (item.extra?.message ?? unconfiguredLabel) as string;
  const connectAction = typeof item.extra?.connect_action === 'string' ? item.extra.connect_action : undefined;
  const hasConnectAction = status === 'error' && connectAction;
  return (
    <Card variant={cardVariant(item, boardAppearance)} padding="md">
      <Container layout="vertical" gap="sm" alignItems="center" justifyContent="center">
        <Icon icon={Sparkles} size="md" color="muted" />
        {headline ? <Text variant="body-xs" color="muted">{headline}</Text> : null}
        {item.text ? <Text variant="body-xs" color="muted">{item.text}</Text> : null}
        {hasConnectAction && connectLabel ? (
          <Text variant="body-xs" color="accent">{connectLabel}</Text>
        ) : null}
      </Container>
    </Card>
  );
}

function PlaceholderItem({
  icon,
  label,
  selected,
  variant = 'surface',
}: {
  icon: React.ComponentType<{ size?: number }>;
  label: string;
  selected: boolean;
  /** #225 — the caller resolves the cascade (it has the item + board profile); the
   *  label-only placeholder itself stays item-blind. Absent → the global default. */
  variant?: 'surface' | 'ghost' | 'elevated' | 'panel';
}) {
  return (
    <Card variant={variant} padding="md">
      <Container layout="vertical" gap="sm" alignItems="center" justifyContent="center">
        <Icon icon={icon} size="md" color="muted" />
        <Text variant="body-xs" color="muted">{label}</Text>
      </Container>
    </Card>
  );
}

/**
 * A nested section (a group member that is itself a group — leaf I2). Renders as
 * a labeled folder showing how many items live inside; double-click drills in
 * (the panel owns the navigation, this only presents). Content-blind: the section
 * never knows what kinds it contains, only the count the model computed.
 */
function SectionItem({ item, selected, boardAppearance }: ItemRendererProps) {
  const n = item.childCount;
  return (
    <Card variant={cardVariant(item, boardAppearance)} padding="md">
      <Container layout="vertical" gap="sm" alignItems="center" justifyContent="center">
        <Icon icon={FolderOpen} size="md" color={selected ? 'accent' : 'muted'} />
        <Text variant="body-sm">{item.text || 'Section'}</Text>
        <Text variant="body-xs" color="muted">{n === 1 ? '1 item' : `${n} items`}</Text>
      </Container>
    </Card>
  );
}

/**
 * A saved link / bookmark — the credential-free, manual instance of a source pull, and
 * the Milanote/Bento-class link CARD. The card shows the page TITLE (bold) with the
 * DOMAIN beneath it and an optional DESCRIPTION, then an explicit "Open" control. Title
 * and description come from the self-describing `extra.linkPreview` DATA (L090) written
 * by the OG-enrichment workflow (an external generic package — this renderer never
 * fetches); until enrichment lands, the card degrades to domain + the typed text, no
 * fake values (L117). The control stops propagation so it never starts a node drag, and
 * the renderer owns its own activation — the panel never branches on kind (L090).
 */
function LinkItem({ item, selected, boardAppearance }: ItemRendererProps) {
  const href = item.src;
  const domain = hostFromHref(href, item.text || 'Link');
  const preview = readLinkPreview(item.extra);
  const galleryImages = linkPreviewImages(preview);
  // Title = the enriched page title if fetched, else the domain (never invented).
  const title = preview?.title ?? domain;
  const showDomainLine = !!preview?.title && domain !== preview.title; // domain as subtitle
  const secondary = preview?.description ?? (item.text && item.text !== title ? item.text : undefined);
  return (
    <Card variant={cardVariant(item, boardAppearance)} padding="md">
      <Container layout="vertical" gap="sm">
        {/* Thumbnail — the enriched embed (Bento/Hashnode large-thumb variant), a 16:9 cover
            frame via the blind MediaFrame. A playable og:video (a user's "…or a video") wins over
            the still og:image; MediaFrame dispatches <video> vs <img> by mediaType (L090). Only
            shown once enrichment wrote extra.linkPreview; absent → the card is text-only (no fake). */}
        {preview?.video ? (
          <MediaFrame
            url={preview.video}
            mediaType="video/*"
            label={title}
            transform={{ aspectRatio: '16:9', keepAspectRatio: false }}
          />
        ) : galleryImages.length > 1 ? (
          // A multi-photo link (Pinterest board / IG carousel, b195/b196) → the whole gallery as a carousel,
          // not just the hero. Each tile renders through the same MediaFrame as the single-image case.
          <LinkGallery images={galleryImages} label={title} />
        ) : preview?.image ? (
          <MediaFrame
            url={preview.image}
            mediaType="image"
            label={title}
            transform={{ aspectRatio: '16:9', keepAspectRatio: false }}
          />
        ) : null}
        {/* Source label — the publisher (og:site_name), the Bento/Milanote provenance chip. */}
        {preview?.siteName ? (
          <Text variant="body-xs" color="muted">{preview.siteName}</Text>
        ) : null}
        <Container layout="horizontal" gap="sm" alignItems="center">
          {/* Favicon — the site's own mark, the Bento/Hashnode recognition anchor. Reuses
              DisplayMark (image → glyph → monogram, graceful onError, L093): the favicon
              is DERIVED from the href (no fetch we own); a broken/missing icon falls back
              to a Link glyph, then a domain monogram — never a broken-image glyph. */}
          <DisplayMark
            spec={{ name: domain, image: faviconUrl(href) ?? undefined, glyph: 'Link' }}
            size="md"
            shape="tile"
          />
          <Text variant="body-sm">{title}</Text>
        </Container>
        {showDomainLine ? (
          <Text variant="body-xs" color="muted">{domain}</Text>
        ) : null}
        {secondary ? (
          <Text variant="body-xs" color="muted">{secondary}</Text>
        ) : null}
        {href ? (
          <Button
            variant="ghost"
            size="sm"
            aria-label="Open link"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              openExternalHref(href); // #210: anchor-click, never navigates the shell frame
            }}
          >
            <Icon icon={ExternalLink} size="sm" />
            Open
          </Button>
        ) : null}
      </Container>
    </Card>
  );
}

function FallbackItem({ item, selected }: ItemRendererProps) {
  return <PlaceholderItem icon={HelpCircle} label={item.kind} selected={selected} />;
}

/** The DATA registry: kind (raw key) → renderer. Owner-extensible (L069/L090).
 * `image` and `media` share ONE renderer — MediaFrame dispatches by contentType. */
/** A presentation FRAME (#169) — a named region on the canvas. Blind: hands the item's
 *  text as the title + the selection flag to the shared `CanvasFrame` ui primitive, which
 *  fills the node box with a titled outline + transparent interior. Geometry/selection/z are
 *  the board's; the frame member drags/resizes/locks/z-orders like any item (zero new path). */
function FrameItem({ item, selected }: ItemRendererProps) {
  return <CanvasFrame title={item.text ?? 'Frame'} selected={selected} />;
}

/** An emoji STAMP (#204) — a chrome-less reaction marker (FigJam/Miro sticker). Renders
 *  the glyph carried in the item's `text` (the SAME universal blind field a note uses),
 *  centered and large, filling the node box — no card, no border (it floats on the
 *  canvas). Storing the glyph in `text` (not a stamp-specific `extra`) means the blind
 *  board-svg exporter renders it for FREE (it serializes `text`) — the new kind exports
 *  with zero exporter edits (L063/L090). An empty text falls back to the catalog default
 *  so a stamp is never invisible. */
function StampItem({ item }: ItemRendererProps) {
  const emoji = typeof item.text === 'string' && item.text.length > 0 ? item.text : stampEmojiById(undefined);
  return (
    <Container height="full" layout="vertical" alignItems="center" justifyContent="center">
      <Text variant="display" aria-label={`Stamp ${emoji}`}>{emoji}</Text>
    </Container>
  );
}

export const ITEM_RENDERERS: Readonly<Record<string, React.ComponentType<ItemRendererProps>>> = {
  note: NoteItem,
  image: MediaItem,
  media: MediaItem,
  pending: PendingItem,
  section: SectionItem,
  link: LinkItem,
  frame: FrameItem,
  stamp: StampItem,
};

// ── Per-item visual-layer-stack (reuse the screen-arrangement primitive) ────────
// A board item can carry its own visual-layer-stack on `presentation.visualLayerStack`
// (DATA) — background fills (paper/color/gradient/mesh), effects (grain/tint), and the
// torn-paper edge — rendered through the SAME ui/ <VisualLayerStack> + capability
// registry the regions use. Blind (L090): never enumerates capability kinds; a new
// capability is a registry row, never an edit here. No stack → zero change (regression-safe).
// The content layer + the fill layers share ONE registry (the board item-layer registry,
// owned by item-fill — L030): a registry is a provenance host, not a per-layer meaning.
const ITEM_CONTENT_CAPABILITY_ID = 'surface-content';

function itemLayers(item: BoardItem): VisualLayerDescriptor[] | null {
  const stack = (item.extra as Record<string, unknown> | undefined)?.visualLayerStack;
  const layers = stack && typeof stack === 'object' ? (stack as { layers?: unknown }).layers : undefined;
  return Array.isArray(layers) && layers.length > 0 ? (layers as VisualLayerDescriptor[]) : null;
}

/** The card-level silhouette operator (torn/scalloped edge), if the item set one. */
function itemStackClip(item: BoardItem): CapabilityInvocation | undefined {
  const stack = (item.extra as Record<string, unknown> | undefined)?.visualLayerStack;
  const clip = stack && typeof stack === 'object' ? (stack as { clip?: unknown }).clip : undefined;
  return clip && typeof clip === 'object' ? (clip as CapabilityInvocation) : undefined;
}

/** The plain card-frame chrome (corner radius + border show/hide + opacity) the item
 *  set in its stack DATA, resolved into ordinary <Card> props so ANY card renderer can
 *  spread it. No frame → empty object (host default chrome). This is the user's direct
 *  "round the card / hide the extra border / fade the item" control. `opacity` (0..1)
 *  is applied at the node level (see GroupBoardPanel), not on the card. */
export function itemFrame(item: BoardItem): { cornerRadius?: number; border?: unknown; opacity?: number } | undefined {
  const stack = (item.extra as Record<string, unknown> | undefined)?.visualLayerStack;
  const frame = stack && typeof stack === 'object'
    ? (stack as { frame?: { cornerRadius?: number; border?: unknown; opacity?: number } }).frame
    : undefined;
  return frame && typeof frame === 'object' ? frame : undefined;
}

function frameCardProps(item: BoardItem): { borderless?: boolean; style?: React.CSSProperties } {
  const frame = itemFrame(item);
  // A shadow set in the inspector (x, y, blur, spread, colour, opacity) is drawn on every kind of card.
  const shadow = readShadowValue(item.extra?.shadow);
  if (!frame) return shadow ? { style: { boxShadow: shadowCss(shadow) } } : {};
  // ONE canonical border reader, shared with the SVG export (#198) — so a custom
  // `{color,width}` border now paints IDENTICALLY on screen and in the export,
  // instead of the old boolean-only live read that ignored it.
  const border = readFrameBorder(frame.border);
  const custom = border.show && (border.color || border.width);
  const style: React.CSSProperties = {};
  if (typeof frame.cornerRadius === 'number') {
    style.borderRadius = frame.cornerRadius;
    style.overflow = 'hidden';
  }
  if (custom) style.border = `${border.width ?? 1}px solid ${border.color ?? 'var(--border-strong)'}`;
  if (shadow) style.boxShadow = shadowCss(shadow);
  // A hidden border OR a custom border removes the Card's OWN default border: hidden
  // shows nothing; custom is drawn via the inline style above instead (no double border).
  const borderless = border.show === false || Boolean(custom);
  return {
    ...(borderless ? { borderless: true } : {}),
    ...(Object.keys(style).length > 0 ? { style } : {}),
  };
}

/** Inject the content as a z:0 layer so authored fills (z<0) sit behind and effects
 *  (z>0) overlay — identical to the region content-layer model (ContainerHost). */
function withContentLayer(layers: readonly VisualLayerDescriptor[]): VisualLayerDescriptor[] {
  if (layers.some((l) => l.paint.capability.capabilityId === ITEM_CONTENT_CAPABILITY_ID)) return [...layers];
  return [
    ...layers,
    {
      id: '__content',
      order: { z: 0 },
      pointerEvents: true,
      paint: { capability: { registry: BOARD_ITEM_LAYER_REGISTRY, capabilityId: ITEM_CONTENT_CAPABILITY_ID }, input: {} },
    },
  ];
}

/** Render-cull gate for an embedded live surface. Mounts its children only once
 *  the wrapper's DOM element has entered (or come within `rootMargin` of) the
 *  scroll viewport, and keeps them mounted thereafter (surfaces are stateful — we
 *  prewarm and never thrash-unmount). Until then it shows a cheap labelled
 *  placeholder. This is viewport culling, the same technique a million-entity
 *  canvas uses to stay fast; it bounds DOM work, not entity count. */
function SurfaceViewportGate({ label, children }: { label?: string; children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = React.useState(false);
  React.useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) { setVisible(true); io.disconnect(); } },
      { rootMargin: '400px' }, // prewarm a screen ahead so panning reveals live tiles, not placeholders
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);
  return (
    <div ref={ref} style={{ width: '100%', height: '100%', display: 'flex' }}>
      {visible ? children : (
        <div
          data-reach-role="surface-placeholder"
          style={{
            width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 12, textAlign: 'center', fontSize: 12, opacity: 0.6,
            borderRadius: 'var(--radius-card, 8px)', background: 'var(--surface-secondary, rgba(127,127,127,0.06))',
          }}
        >
          {typeof label === 'string' && label.trim() ? label : 'Live surface'}
        </div>
      )}
    </div>
  );
}

/** The ONE generic wrapper: every item renders behind its authored visual-layer-stack.
 *  No stack → inner renderer as-is. With a stack → inner renders `bare` (drops its
 *  opaque card chrome) so the layer surface (paper/fill/effect) shows through. */
function LayeredItem(props: ItemRendererProps) {
  // A live placeable surface: the item's content IS a running package surface
  // (a dashboard, chat, leaderboard, …) mounted by the generic ui host from the
  // item's own DATA. Blind — group hands the host a package/entry name pair and
  // never names the product. Fills the node. In shell mode the surface is
  // pointer-inert by design so the canvas owns drag/select/marquee; an explicit
  // enter-mode is the capability that grants the surface its own pointer events.
  const surfaceRef = readPlaceableSurface(props.item);
  if (surfaceRef) {
    // Viewport-cull the MOUNT (not the engine): the engine reads a scoped feed in
    // nanoseconds and the log holds millions of entities effortlessly — entity
    // COUNT is never the limit. What IS bounded is DOM/React: mounting hundreds of
    // full embedded app surfaces (each a whole component tree) rasterizes work the
    // browser can't do offscreen anyway. So, exactly like a million-entity canvas
    // or a billion-entity game frustum-culls to what's visible, a board node
    // materializes its PlaceableSurfaceHost ONLY when its DOM element is in/near the
    // viewport; off-screen nodes are cheap placeholders. This is render culling, the
    // standard way to draw unlimited entities fast — NOT an engine capacity limit.
    // Generic: every many-surface board inherits it, zero per-board config (L063).
    return (
      <SurfaceViewportGate label={props.item.text}>
        <PlaceableSurfaceHost
          packageName={surfaceRef.packageName}
          entryName={surfaceRef.entryName}
          surfaceInput={{ frame_fit: 'fill', ...(surfaceRef.surfaceInput ?? {}) }}
          fill
          // Pointer-inert by default so the canvas owns drag/select/marquee (the tile is
          // a glanceable live widget). Entering the node (double-click) flips
          // `embeddedActive`, granting the surface its own pointer events on demand.
          interactive={!!props.embeddedActive}
        />
      </SurfaceViewportGate>
    );
  }
  // `props.item.kind` is a RAW UNTRUSTED DATA KEY — a plain `ITEM_RENDERERS[kind]` resolves a prototype
  // key: '__proto__' -> Object.prototype and 'constructor' -> the Object constructor, both truthy so the
  // `?? FallbackItem` never fires, and React then tries to render a non-component -> "Element type is
  // invalid" CRASH. ownValue (own-key SSOT) routes any unmapped/prototype kind to the FallbackItem.
  const Inner = ownValue<React.ComponentType<ItemRendererProps>>(ITEM_RENDERERS, props.item.kind) ?? FallbackItem;
  const layers = itemLayers(props.item);
  const clip = itemStackClip(props.item);
  // #213 — a self-describing `extra.shape` renders via the `ui` CanvasShape primitive:
  // a bbox-FILLING SVG path (the SAME geometry `board-svg` exports → live == export)
  // with the content centred on top. The path fills the WHOLE item box, so a circle/
  // star can never collapse into the old content-clip "dome". The inner renders `bare`
  // (transparent) so only the shape + its text show; the fill is the canonical
  // `itemFillColor` (so #124 quick-colour still authors a shape's colour). Blind: the
  // path is DATA-resolved by id; `rectangle`/unknown → no path → the normal card path.
  //
  // #211 — the silhouette is a property of the NODE, not of its text-edit state.
  // The shape wraps in BOTH view and edit mode, so entering text (double-click) never
  // reshapes a star/diamond into a square. The inner note honours `bare` in its edit
  // branch too, so its editor renders transparent on top of the shape fill.
  // The shape id flows through the appearance CASCADE (item override → board default → global):
  // a diagram/flowchart board can default EVERY note to an ellipse/diamond (`board.appearance.shape`),
  // a per-item `extra.shape` still wins, and "Default"/absent → rectangle (GLOBAL has no shape key →
  // zero-regression). Same generic resolver as containerVariant/marker/sizeMode (L090).
  const resolvedShapeId = resolveAppearanceKey('shape', props.item.extra?.shape, props.boardAppearance);
  const shapeId = typeof resolvedShapeId === 'string' ? resolvedShapeId : undefined;
  const shapePath = shapeId ? shapeSvgPathById(shapeId) : '';
  if (shapePath) {
    // cont.26 (Line-style shape outline) — when the shaped note carries a NON-SOLID border brushstroke
    // (`borderStrokeStyle`/`borderRoughness`), trace its OUTLINE (polygon vertices / sampled ellipse /
    // rect corners → `shapeOutlinePoints`) via the SAME `resolveStroke`+`strokePathD` leaves and suppress
    // CanvasShape's crisp stroke: pencil/marker/sketch bow (bowing flows), dashed/dotted draw a crisp
    // dashed outline (`strokePathD` returns one crisp path at roughness 0). A rough diamond/star/ellipse
    // falls out of the shape's DATA geometry, ZERO shape-specific code (L090). Solid → the plain crisp
    // CanvasShape, byte-identical (zero regression).
    const shapeStyleId = resolveAppearanceKey('borderStrokeStyle', props.item.extra?.borderStrokeStyle, props.boardAppearance);
    const shapeStroke = resolveStroke(
      typeof shapeStyleId === 'string' ? shapeStyleId : undefined,
      Number(resolveAppearanceKey('borderRoughness', props.item.extra?.borderRoughness, props.boardAppearance)) || undefined,
    );
    const shapeStrokeActive = shapeStroke.roughness > 0 || Boolean(shapeStroke.dash);
    const geo = shapeStrokeActive && shapeId ? shapeGeometryById(shapeId) : undefined;
    const roughShape = geo
      ? strokePathD(shapeOutlinePoints(geo, props.item.w, props.item.h), { roughness: shapeStroke.roughness, bowing: shapeStroke.bowing, doubleStroke: true }, hashSeed(props.item.memberId))
      : null;
    if (!roughShape) {
      return (
        <CanvasShape path={shapePath} fill={itemFillColor(props.item)} shadow={readShadowValue(props.item.extra?.shadow)}>
          <Inner {...props} bare />
        </CanvasShape>
      );
    }
    return (
      <Container position="relative" style={{ width: '100%', height: '100%' }}>
        <CanvasShape path={shapePath} fill={itemFillColor(props.item)} stroke="transparent" shadow={readShadowValue(props.item.extra?.shadow)}>
          <Inner {...props} bare />
        </CanvasShape>
        <svg
          viewBox={`0 0 ${Math.max(1, props.item.w)} ${Math.max(1, props.item.h)}`}
          preserveAspectRatio="none"
          width="100%"
          height="100%"
          style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'visible' }}
          aria-hidden
        >
          {roughShape.map((d, i) => (
            <path key={i} d={d} fill="none" stroke="var(--ink-strong, #1f2937)" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={shapeStroke.dash} opacity={roughShape.length > 1 && i === 1 ? 0.6 : 1} />
          ))}
        </svg>
      </Container>
    );
  }
  if (!layers && !clip) return <Inner {...props} />;
  // `bare` only when authored FILL layers exist (the layer surface replaces the
  // card chrome). A clip-only card keeps its chrome and is simply clipped.
  const content = <Inner {...props} bare={!!layers} />;
  const map = createCapabilityMap({
    ...builtinVisualLayerCapabilities,
    [ITEM_CONTENT_CAPABILITY_ID]: { render: () => content },
  });
  return <VisualLayerStack layers={withContentLayer(layers ?? [])} clip={clip} map={map} />;
}

/** Resolve a renderer by raw kind key. Every item flows through {@link LayeredItem}
 *  so an authored visual-layer-stack applies generically; unknown kind → safe
 *  fallback (resolved inside LayeredItem), never a crash. */
export function rendererForKind(_kind: string): React.ComponentType<ItemRendererProps> {
  return LayeredItem;
}

/**
 * The shelf of placeable item kinds (DATA — the toolbar "Add" actions). Each
 * entry self-describes HOW it is produced (`addStrategy` → the blind producer in
 * item-add-strategies) + WHAT files it accepts (`acceptPrefixes`) + its default
 * text. The canvas copies this DATA — it never branches on kind. Adding a kind /
 * a new produce-behavior = one shelf row (+ maybe one strategy row); ZERO panel
 * edits (Generic Gate #2/#3). `ShelfEntry` = the visual `icon` over the DATA.
 */
/** R44 add-your-own descriptor — pure DATA the variants flyout uses to let the user create
 *  an infinite custom variant (a new stamp glyph, a new note colour). `inputKind` picks the
 *  capture control (an emoji/text field, or a native colour swatch); `valueField` is the
 *  catalog-row field the typed value fills; the catalog identity (kind/arrayKey/addressPrefix)
 *  routes the generic write. The flyout stays blind — it renders the input and hands the value
 *  + this descriptor to an injected writer. */
export interface ShelfVariantCreator {
  /** Which capture control to render. 'color' → a native colour swatch; else a text field
   *  (emoji is just a character you paste). A small closed set of INPUT primitives, not an
   *  open domain enum. */
  readonly inputKind: 'emoji' | 'color' | 'text';
  readonly placeholder: string;
  /** The button/row label ("Add a stamp", "Add a colour"). */
  readonly addLabel: string;
  /** The catalog-row field the typed value fills (e.g. 'emoji', 'color'). */
  readonly valueField: string;
  /** Published-record catalog identity for the generic writer (write-board-catalog-live). */
  readonly catalogKind: string;
  readonly arrayKey: string;
  readonly addressPrefix: string;
}

/** One preset configuration in a shelf entry's `variants` family — a label + catalog
 *  icon NAME (resolved by the blind {@link NamedIcon}, SSOT to the source catalog) +
 *  the `defaultExtra` seed (#156) it places. A variant is pure DATA; the shelf renders
 *  it blind. */
export interface ShelfVariant {
  readonly id: string;
  readonly label: string;
  /** Visual: a lucide icon NAME (resolved by NamedIcon) — for icon families (shapes). */
  readonly icon?: string;
  /** Visual: a colour (rendered as a ColorDot) — for colour families (sticky notes). A
   *  variant carries EITHER `icon` OR `swatch` OR `emoji`; the flyout renders whichever is
   *  present, blind to which (L090). */
  readonly swatch?: string;
  /** Visual: an emoji glyph rendered as text — for glyph families (stamps, #204). */
  readonly emoji?: string;
  /** The presentation DATA this variant seeds into the placed item's `extra` (#156). */
  readonly defaultExtra: Record<string, unknown>;
  /** Per-variant `text` for the placed item (#204 — a stamp's emoji). When unset, the
   *  tool's own `defaultText` is used. */
  readonly defaultText?: string;
  /** Per-variant placed footprint in world units (#214). A variant whose item is only
   *  useful larger — e.g. a live embedded surface — declares it here; the flyout forwards
   *  it to the empty strategy, which sizes the draft. Absent → the item's default size. */
  readonly defaultW?: number;
  readonly defaultH?: number;
}

export interface ShelfEntry extends AddShelfEntry {
  readonly icon: React.ComponentType<{ size?: number }>;
  /** A preset FAMILY (L069): when present, the shelf renders a split-button whose caret
   *  opens a flyout of these variants — each places the entry with the variant's
   *  `defaultExtra`. Absent → a plain one-click button. The shelf never enumerates what a
   *  variant means; it spreads `defaultExtra` blind (L090). */
  readonly variants?: ReadonlyArray<ShelfVariant>;
  /** ADD-YOUR-OWN (R44): when present, the variants flyout shows an "add" row so the user
   *  creates an INFINITE custom variant (a new emoji stamp, a new note colour) that persists
   *  as a catalog row. All DATA (L090) — the flyout renders the input `inputKind` names and
   *  hands the typed value + this descriptor to the caller's generic writer; the shelf never
   *  knows what a "stamp" or "colour" is. `valueField` is the catalog-row field the typed
   *  value fills (e.g. 'emoji' / 'color'). */
  readonly variantCreator?: ShelfVariantCreator;
  /** MULTI-FIELD action form (DATA from an action-affordance's `ask.fields`): when
   *  present, running this tool opens the shared blind ActionForm to collect an answers
   *  bag BEFORE firing the producer (instead of the single-text ask). The panel threads
   *  the answers into the producer's input resolution. Absent → the single-text produce
   *  path (back-compat). The board never enumerates a field — it hands the descriptors to
   *  the blind form (L090). */
  readonly formFields?: ReadonlyArray<AskField>;
  readonly formTitle?: string;
  readonly formSubmitLabel?: string;
  /** The RAW action-affordance record this tool came from — the base a "Save as preset"
   *  curries (deriveActionPresetRecord). Opaque to the board; only the preset builder
   *  reads it. */
  readonly affordanceRecord?: unknown;
  /** The record's DATA `section` (an open string — "Translate", "Ideate", …): the
   *  Custom-actions popover groups its rows under these headers. Absent → ungrouped.
   *  The board never enumerates section names (L090) — any DATA value is a group. */
  readonly section?: string;
  /** The affordance's log identity, carried OPAQUELY for the panel's archive
   *  (soft-delete) path (`archiveActionAffordanceLive`). Present only when the row
   *  has a resolvable live write address — the popover gates its Remove control on
   *  this, so a fixture/unremovable row simply shows none. */
  readonly removalRef?: { readonly id?: string; readonly source_address?: string; readonly payload: unknown };
  /** The channel this tool was derived FROM (`trigger.channel` — shelf / palette /
   *  context-menu / …): the run path reports it as `surface.channel` in the invoke
   *  context, so a channel-sensitive input template sees the REAL door it was invoked
   *  through instead of a hardcoded shelf (Codex 2026-07-10 audit, finding 4).
   *  Absent → the surface's own default channel. */
  readonly invokeChannel?: string;
  /** A valid action-affordance without a polling status contract is a direct
   *  action, not a dead producer. The panel resolves and dispatches this
   *  opaque pair after the same ask/form path, but places no pending card. */
  readonly directAffordance?: {
    readonly affordance: ActionAffordance;
    readonly trigger: ActionAffordanceTrigger;
  };
}

/** The Shape tool's variant family — the #155 catalog as placeable presets (minus
 *  `rectangle`, which IS the plain Note tool). Each variant seeds `extra.shape`; the
 *  blind CanvasNode resolves the clip-path. Adding a shape to BOARD_SHAPES adds it to
 *  BOTH the post-placement picker AND this placement flyout — one catalog, two consumers (L069). */
export function shapeVariants(shapes: ReadonlyArray<{ id: string; label: string; icon: string }> = BOARD_SHAPES): ReadonlyArray<ShelfVariant> {
  return shapes
    .filter((s) => s.id !== 'rectangle')
    .map((s) => ({ id: s.id, label: s.label, icon: s.icon, defaultExtra: { shape: s.id } }));
}
export const SHAPE_VARIANTS: ReadonlyArray<ShelfVariant> = shapeVariants();

/** The Stamp tool's glyph family (#204) — the BOARD_STAMPS catalog as placeable presets.
 *  Each variant seeds the glyph into the placed item's `text` (drawn by the blind StampItem,
 *  and serialized by the blind exporter for free) and shows its `emoji` in the flyout (the
 *  new emoji visual channel). The #157 `variants`
 *  primitive on a 3rd tool + a 3rd visual (icon / swatch / emoji) — L069 emergence. */
/** The Stamp tool's glyph family as one-click placeable presets, from a stamp catalog
 *  (default the built-ins). Passing the DATA-merged catalog (readStampCatalog) makes
 *  user-defined stamps appear in the flyout — the emoji lands in the placed item's `text`. */
export function stampVariants(stamps: readonly BoardStamp[] = BOARD_STAMPS): ReadonlyArray<ShelfVariant> {
  return stamps.map((s) => ({ id: s.id, label: s.label, emoji: s.emoji, defaultExtra: {}, defaultText: s.emoji }));
}
export const STAMP_VARIANTS: ReadonlyArray<ShelfVariant> = stampVariants();

/** The Note tool's colour family (#158) — the #124 sticky-colour palette as one-click
 *  placeable presets (minus `none`, which IS the plain Note). Each variant seeds a fill
 *  stack built by the SAME `setStackFill` the #124 swatch uses (SSOT — a seeded colour and
 *  a later recolour edit one source of truth). The flyout renders the `swatch` as a ColorDot.
 *  This is the #157 `variants` primitive on a 2nd tool + a 2nd visual — L069 emergence. */
export function noteColorVariants(swatches: ReadonlyArray<{ id: string; label: string; color: string | null }> = BOARD_FILL_SWATCHES): ReadonlyArray<ShelfVariant> {
  return swatches
    .filter((s): s is typeof s & { color: string } => typeof s.color === 'string')
    .map((s) => ({ id: s.id, label: s.label, swatch: s.color, defaultExtra: { visualLayerStack: seededFillStack(s.color) } }));
}
export const NOTE_COLOR_VARIANTS: ReadonlyArray<ShelfVariant> = noteColorVariants();

/** The add-item toolbar as DATA rows, with the Stamp tool's flyout built from a stamp catalog
 *  (default the built-ins). Passing the DATA-merged catalog (readStampCatalog) surfaces
 *  user-defined stamps — the only shelf entry that varies by DATA; everything else is fixed
 *  Physics (Note/Shape/Image/Media/Link/From-text). */
export function buildItemShelf(
  stamps: readonly BoardStamp[] = BOARD_STAMPS,
  shapes: ReadonlyArray<{ id: string; label: string; icon: string }> = BOARD_SHAPES,
  swatches: ReadonlyArray<{ id: string; label: string; color: string | null }> = BOARD_FILL_SWATCHES,
): ReadonlyArray<ShelfEntry> {
  return [
    // The Note's main click drops a blank note; the caret (variants) drops a coloured
    // sticky (FigJam's one-click sticky-colour) — same #157 flyout, a colour family (#158).
    { kind: 'note', label: 'Note', icon: StickyNote, addStrategy: 'empty', defaultText: 'New note', variants: noteColorVariants(swatches),
      // R44: "Add a colour" in the flyout → a native colour swatch that persists a new
      // fill-swatch catalog row, so a user's palette is infinite, not the built-in set.
      variantCreator: { inputKind: 'color', placeholder: 'Pick a colour', addLabel: 'Add a colour', valueField: 'color', catalogKind: FILL_SWATCH_CATALOG_KIND, arrayKey: 'swatches', addressPrefix: 'package::group::published-record::fill-swatch::' } },
    // One-click shape: same `empty` strategy + seeded `extra.shape` (#155 catalog id).
    // A FigJam shape IS a text-capable container — drop it, type a label, recolour via
    // the #124 fill swatch. ZERO new kind / renderer; the clip + fill already apply. The
    // main button drops an ellipse; the caret (variants) drops any catalog shape (#157).
    { kind: 'note', label: 'Shape', icon: Shapes, addStrategy: 'empty', defaultExtra: { shape: 'ellipse' }, variants: shapeVariants(shapes) },
    { kind: 'image', label: 'Image', icon: ImageIcon, addStrategy: 'pick', acceptPrefixes: ['image/'] },
    { kind: 'media', label: 'Media', icon: Film, addStrategy: 'pick', acceptPrefixes: ['video/', 'audio/', 'image/'] },
    { kind: 'link', label: 'Link', icon: LinkIcon, addStrategy: 'link', defaultText: 'Paste a link URL' },
    // The multi-card SPLITTER (R25): the name says what it DOES — paste a list/outline and
    // each line becomes its own card. The defaultText is the modal title + placeholder.
    { kind: 'note', label: 'Paste as cards', icon: ListPlus, addStrategy: 'text-source', defaultText: 'Paste a list — each line or bullet becomes its own card' },
    // Emoji stamp (#204): the main button drops 🔥; the caret opens the glyph flyout
    // (the #157 variants primitive, emoji visual). A chrome-less `stamp` kind — its own
    // blind renderer draws the glyph from the item's `text`. ZERO canvas/panel edits.
    { kind: 'stamp', label: 'Stamp', icon: Sticker, addStrategy: 'empty', defaultText: '🔥', variants: stampVariants(stamps),
      // R44: "Add a stamp" in the flyout → paste ANY emoji; it persists a new stamp catalog
      // row (a user: "I still can't add any infinite custom stamps"). Emoji is just a character.
      variantCreator: { inputKind: 'emoji', placeholder: 'Paste any emoji', addLabel: 'Add a stamp', valueField: 'emoji', catalogKind: STAMP_CATALOG_KIND, arrayKey: 'stamps', addressPrefix: 'package::group::published-record::stamp::' } },
  ];
}
export const ITEM_SHELF: ReadonlyArray<ShelfEntry> = buildItemShelf();

/**
 * Render one shelf entry as its toolbar control. No `variants` → a plain one-click
 * Button (places the entry via {@link onAdd}). With `variants` → a split-button: the
 * main button places the entry's own default; a caret opens an {@link AnchoredOverlay}
 * grid of the variants, each placing `{ ...tool, defaultExtra: v.defaultExtra }`. The
 * component is blind to what a variant means — it forwards `defaultExtra` (L090). ui
 * primitives + NamedIcon only (L065). Generic: ANY tool with a `variants` family (shape
 * today; sticky colours / arrows / frame ratios later) gets the flyout for free.
 *
 * `appearance` selects the surface idiom (host-supplied, never inferred): `toolbar`
 * (default) renders the filled header chip; `menu` renders the row transparent until
 * hover (`ghost` + `size:menu` — the exact anatomy every other popover option row uses,
 * e.g. BoardLayersPanel rows). A user's 2026-07-09 report: the Custom-actions popover
 * gave every row its own visible background — a toolbar chip inside a menu surface.
 */
export function ShelfToolButton({
  tool,
  onAdd,
  onCreateVariant,
  appearance = 'toolbar',
}: {
  readonly tool: ShelfEntry;
  readonly onAdd: (tool: ShelfEntry) => void;
  /** R44 add-your-own: persist a user-typed value as a new catalog row for this tool's
   *  `variantCreator`. Absent → the flyout shows no "add" row (back-compat). */
  readonly onCreateVariant?: (creator: ShelfVariantCreator, value: string) => void;
  readonly appearance?: 'toolbar' | 'menu';
}) {
  const anchor = React.useRef<HTMLButtonElement>(null);
  const [open, setOpen] = React.useState(false);
  const creator = tool.variantCreator;
  const [createValue, setCreateValue] = React.useState(creator?.inputKind === 'color' ? '#3b6fe0' : '');
  const submitCreate = () => {
    const v = createValue.trim();
    if (!creator || !onCreateVariant || v.length === 0) return;
    onCreateVariant(creator, v);
    setCreateValue(creator.inputKind === 'color' ? '#3b6fe0' : '');
    setOpen(false);
  };
  const variants = tool.variants;
  const buttonVariant = appearance === 'menu' ? ('ghost' as const) : ('secondary' as const);
  const buttonSize = appearance === 'menu' ? ('menu' as const) : ('sm' as const);
  if (!variants || variants.length === 0) {
    return (
      <Button variant={buttonVariant} size={buttonSize} onClick={() => onAdd(tool)}>
        <Icon icon={tool.icon} size="sm" /> {tool.label}
      </Button>
    );
  }
  // R22: ONE button, no chevron. A separate caret button next to the main button
  // read as two half-buttons (a "stray" dropdown control); real users clicked the
  // label expecting the choices and got a silent default-insert instead. The whole
  // surface now opens the variant flyout; the old direct default-insert survives as
  // the flyout's FIRST, full-width row (capability preserved, never deleted). One
  // generic renderer → Note/Shape/Stamp/Live-surface all get the fix at once.
  return (
    <>
      <Button
        ref={anchor}
        variant={buttonVariant}
        size={buttonSize}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon icon={tool.icon} size="sm" /> {tool.label}
      </Button>
      <AnchoredOverlay anchorRef={anchor} open={open} onDismiss={() => setOpen(false)}>
        <Container layout="vertical" gap="sm" padding="sm" aria-label={`Choose ${tool.label}`}>
          <Text variant="label">{tool.label}</Text>
          {/* The old main-click default insert, first and most prominent. */}
          <Button
            variant="secondary"
            size="sm"
            fullWidth
            onClick={() => { onAdd(tool); setOpen(false); }}
          >
            <Icon icon={tool.icon} size="sm" /> {tool.label}
          </Button>
          <Container layout="grid" gridCols={3} gap="xs">
            {variants.map((v) => (
              <Button
                key={v.id}
                variant="ghost"
                size="icon"
                aria-label={v.label}
                onClick={() => { onAdd({ ...tool, label: v.label, defaultExtra: v.defaultExtra, defaultText: v.defaultText ?? tool.defaultText, defaultW: v.defaultW ?? tool.defaultW, defaultH: v.defaultH ?? tool.defaultH }); setOpen(false); }}
              >
                {v.swatch ? <ColorDot color={v.swatch} size="md" /> : v.emoji ? <Text variant="body-lg">{v.emoji}</Text> : v.icon ? <NamedIcon name={v.icon} /> : null}
              </Button>
            ))}
          </Container>
          {/* R44 add-your-own: an INFINITE custom variant — paste an emoji / pick a colour,
              persisted as a catalog row so it joins the grid above next time. The flyout is
              blind: it renders the input `inputKind` names and hands the value + descriptor
              to the injected writer. */}
          {creator && onCreateVariant ? (
            <Container layout="horizontal" gap="xs" alignItems="center">
              {creator.inputKind === 'color' ? (
                <NativeColorInput value={createValue} onValueChange={setCreateValue} aria-label={creator.addLabel} />
              ) : (
                <Input
                  value={createValue}
                  onChange={(e) => setCreateValue((e.target as HTMLInputElement).value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') submitCreate(); }}
                  placeholder={creator.placeholder}
                  aria-label={creator.addLabel}
                />
              )}
              <Button variant="secondary" size="sm" onClick={submitCreate} aria-label={creator.addLabel}>
                {creator.addLabel}
              </Button>
            </Container>
          ) : null}
        </Container>
      </AnchoredOverlay>
    </>
  );
}
