// packages/group/show/OutlineDisplay.tsx
//
// R3 × R3-marker × outline composition: the READ-ONLY render of a note whose content is a
// nested OUTLINE (extra.contentMode === 'outline'). It parses the note's text into rows
// (outline-text), numbers each row within its own level (outlineOrdinals — "1./2." restart
// under each parent), and draws the note's OWN list marker before each row via the SAME pure
// catalog resolver that draws one bullet on a plain note (board-marker-catalog). So a glyph,
// emoji, decimal/roman/alpha ordinal, per-item cycle, or an image/video bullet all work on an
// outline with ZERO new code — the marker is DATA, this renderer is blind (L090/L069).
//
// Purely presentational: no editing, no I/O. The ListBlockEditor owns editing; this owns look.

import { Text } from '../../ui/index.ts';
import { MediaFrame } from '../../ui/show/media-frame/MediaFrame';
import { Container } from '../../ui/index.ts';
import { markerCellForIndex, type BoardMarker } from './board-marker-catalog.ts';
import { outlineOrdinals, parseOutline } from '../read-data/outline-text.ts';

export interface OutlineDisplayProps {
  readonly text: string;
  /** The note's resolved list marker (same DATA that draws its board bullet). Undefined → no bullet. */
  readonly marker?: BoardMarker;
  /** Per-NESTING-LEVEL markers (indexed by indent depth) — a real outline shows a DIFFERENT
   *  marker per level (`1.` → `a.` → `i.`, the classic legal outline). A row at depth d uses
   *  `levelMarkers[d]` (clamped to the last for deeper levels); when omitted, every level uses
   *  the single `marker`. So one-marker and multi-level outlines share one blind renderer (L069). */
  readonly levelMarkers?: readonly (BoardMarker | undefined)[];
}

const INDENT_PX = 18;

/** The marker for a row at nesting depth `d`: its own level's marker (clamped to the deepest
 *  supplied) when a per-level list exists, else the single fallback marker. */
function markerForDepth(
  d: number,
  levelMarkers: readonly (BoardMarker | undefined)[] | undefined,
  fallback: BoardMarker | undefined,
): BoardMarker | undefined {
  if (!levelMarkers || levelMarkers.length === 0) return fallback;
  return levelMarkers[Math.min(d, levelMarkers.length - 1)] ?? fallback;
}

export function OutlineDisplay({ text, marker, levelMarkers }: OutlineDisplayProps): JSX.Element {
  const rows = parseOutline(text);
  const ordinals = outlineOrdinals(rows);
  return (
    <Container layout="vertical" gap="xs">
      {rows.map((row, i) => {
        const cell = markerCellForIndex(markerForDepth(row.indent, levelMarkers, marker), ordinals[i]);
        return (
          <Container key={row.id} layout="horizontal" gap="xs" alignItems="start" style={{ paddingLeft: row.indent * INDENT_PX }}>
            {cell.mediaUrl ? (
              <Container minWidth="18px">
                <MediaFrame url={cell.mediaUrl} mediaType={cell.mediaType ?? 'image/*'} label="List marker" />
              </Container>
            ) : cell.text ? (
              <Text variant="body-sm" color="muted">{cell.text}</Text>
            ) : null}
            <Text variant="body-sm">{row.text}</Text>
          </Container>
        );
      })}
    </Container>
  );
}
