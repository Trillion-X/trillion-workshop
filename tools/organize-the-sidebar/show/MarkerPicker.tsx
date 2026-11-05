// packages/group/show/MarkerPicker.tsx — Dropdown to pick a board list-marker glyph/numbering.

import type { JSX } from 'react';
import { Button, Dropdown } from '../../ui/index.ts';
import { BOARD_MARKERS, markerTextForIndex, type BoardMarker } from './board-marker-catalog.ts';

/** Pure — build the Dropdown items for a marker catalog. Each label previews the
 *  marker at position 0 followed by its name, e.g. "•  Disc", "1.  Decimal". The
 *  value is the marker id (stable), never the label. */
export function markerItems(
  markers: readonly BoardMarker[] = BOARD_MARKERS,
): Array<{ value: string; label: string }> {
  return markers.map((m) => ({
    value: m.id,
    label: `${markerTextForIndex(m, 0)}  ${m.label}`.trim(),
  }));
}

export interface MarkerPickerProps {
  readonly value?: string;
  readonly onPick: (markerId: string) => void;
  readonly markers?: readonly BoardMarker[];
  /** Prepend a "No marker" row (value `''`) so the picker can CLEAR a marker, not just
   *  set one. `onPick('')` fires → the caller drops `extra.marker`. Default off. */
  readonly includeNone?: boolean;
  /** Label for the clear row (default "No marker"). */
  readonly noneLabel?: string;
}

export function MarkerPicker(props: MarkerPickerProps): JSX.Element {
  const items = props.includeNone
    ? [{ value: '', label: props.noneLabel ?? 'No marker' }, ...markerItems(props.markers)]
    : markerItems(props.markers);
  return (
    <Dropdown
      items={items}
      value={props.value ?? ''}
      onValueChange={(id) => props.onPick(id)}
      align="start"
      aria-label="List marker"
      customTrigger={
        <Button variant="ghost" size="sm" aria-label="List marker">
          Marker
        </Button>
      }
    />
  );
}
