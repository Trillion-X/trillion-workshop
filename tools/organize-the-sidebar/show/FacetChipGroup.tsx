// packages/group/show/FacetChipGroup.tsx
//
// ONE generic multi-select filter-chip group — renders ANY facet (category, tag, color, kind,
// or a future author/origin facet) from its values + the current selection, zero per-facet code
// (L069/L090). Clicking a chip toggles that value; an active chip reads `primary`. Shared by the
// template LIBRARY filter (SavedArrangementGallery) AND the board FOCUS filter (BoardFocusBar) —
// promoted here at the 2nd consumer (L088). Values come from `facetValues`/`arrangementFacetValues`
// (the facet SSOT); toggling flows through `toggleFacetValue`.

import React from 'react';
import { AnchoredOverlay, Card, Container, Text, Button, Icon } from '../../ui';
import { ChevronDown } from 'lucide-react';

export function FacetChipGroup({
  facetKey,
  label,
  values,
  selected,
  onToggle,
  minValues = 1,
  counts,
  colors,
}: {
  readonly facetKey: string;
  readonly label: string;
  readonly values: readonly string[];
  readonly selected: readonly string[];
  readonly onToggle: (facetKey: string, value: string) => void;
  /** Hide the group unless it has at least this many values. The LIBRARY passes 2 (a lone
   *  category filters nothing — every row carries it); the BOARD leaves the default 1 (a
   *  single tag/colour still meaningfully dims the items that LACK it). Codex-driven. */
  readonly minValues?: number;
  /** Per-value match counts keyed by the same casing as `values` (from `facetValueCounts`):
   *  how many items each chip matches given the other active filters. When present, each chip
   *  shows the number and reads it in the aria-label. */
  readonly counts?: Readonly<Record<string, number>>;
  /** Per-value colour keyed by the same casing as `values` (from `facetColorAssignment`): the
   *  colour "Colour by <facet>" paints that value. When present, each chip shows a swatch, so the
   *  chip group doubles as a LIVE colour LEGEND (the readout half of colour-by-facet). Blind: this
   *  component never knows the colours come from colour-by-facet — it just draws a swatch (L090). */
  readonly colors?: Readonly<Record<string, string>>;
}) {
  const anchorRef = React.useRef<HTMLButtonElement>(null);
  const [open, setOpen] = React.useState(false);
  if (values.length < minValues) return null; // below the useful-filter threshold (L118)
  const activeCount = selected.length;
  // R52: ONE compact "Type ▾" / "Deadline ▾" trigger per facet that opens the value chips
  // in an anchored popover — the SAME anatomy the On-board/Look panels use — instead of a
  // sprawling inline chip cluster that crowded and mis-aligned the focus bar with several
  // facets. The trigger is self-describing: it names the facet + its active count, so the
  // user reads "Type · 2" and knows what it filters (L115). Zero per-facet code (L069/L090).
  return (
    <>
      <Button
        ref={anchorRef}
        variant={activeCount > 0 ? 'secondary' : 'ghost'}
        size="sm"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Filter by ${label}${activeCount > 0 ? ` — ${activeCount} selected` : ''}`}
        onClick={() => setOpen((o) => !o)}
      >
        {label}{activeCount > 0 ? ` · ${activeCount}` : ''} <Icon icon={ChevronDown} size="xs" />
      </Button>
      <AnchoredOverlay anchorRef={anchorRef} open={open} onDismiss={() => setOpen(false)}>
        <Card variant="popover" padding="sm">
          <Container layout="vertical" gap="xs" style={{ minWidth: 180, maxHeight: '50vh', overflowY: 'auto' }} aria-label={`Filter by ${label}`}>
            <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
              <Text variant="label">{label}</Text>
              {activeCount > 0 ? (
                <Button variant="ghost" size="xs" aria-label={`Clear ${label} filter`} onClick={() => selected.forEach((s) => onToggle(facetKey, s))}>Clear</Button>
              ) : null}
            </Container>
            {values.map((v) => {
              const active = selected.some((s) => s.toLowerCase() === v.toLowerCase());
              const count = counts?.[v];
              const hasCount = typeof count === 'number';
              const swatch = colors?.[v];
              return (
                <Button
                  key={v}
                  variant={active ? 'primary' : 'ghost'}
                  size="sm"
                  fullWidth
                  aria-pressed={active}
                  onClick={() => onToggle(facetKey, v)}
                  aria-label={hasCount ? `${label}: ${v} (${count} match${count === 1 ? '' : 'es'})` : `${label}: ${v}`}
                >
                  {swatch ? (
                    <svg width={10} height={10} viewBox="0 0 10 10" aria-hidden="true" data-swatch={swatch}>
                      <rect width={10} height={10} rx={2} fill={swatch} stroke="rgba(0,0,0,0.12)" />
                    </svg>
                  ) : null}
                  {hasCount ? `${v} ${count}` : v}
                </Button>
              );
            })}
          </Container>
        </Card>
      </AnchoredOverlay>
    </>
  );
}
