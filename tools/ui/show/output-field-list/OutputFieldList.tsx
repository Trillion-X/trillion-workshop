// bitfield/packages/ui/show/output-field-list/OutputFieldList.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Data-declared field display for deliverable/result payloads: shows at most
// `visibleLimit` labeled rows, collapses the rest behind "Show details", and
// refuses to display fields whose keys look like internal identifiers. The
// "first six arbitrary scalar keys" leak class dies here once for every
// package that renders outputs.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. No raw HTML/className — composes Container, Text, Button
// 2. The internal-key denylist wins over everything — a denied key never
//    renders even when explicitly passed
// 3. Unknown keys de-hyphenate/de-underscore into readable labels
// 4. Values render as plain text, truncated; never as raw JSON dumps
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useState } from 'react';
import { Button } from '../button';
import { Container } from '../container';
import { Text } from '../text';
import { ExpandableRegion } from '../expandable-region';

// ---------------------------------------------------------------------------
// FIELD FILTERING
// ---------------------------------------------------------------------------

/** Key shapes that mean "internal identifier" — never displayed. */
const INTERNAL_KEY_PATTERN = /(^id$|_id$|^id_|_ref$|^ref_|hash|multihash|address|payload|definition|descriptor|_key$|token)/i;
const INTERNAL_VALUE_PATTERN =
  /\b[a-z-]+::\S+|\b(?:production|canonical)\s+artifact\b|\b(?:payload|receipt|projection|acceptance proof)\b|\b(?:result|job|artifact|correlation)[_ -]?(?:ref|id|token)\b|\b[0-9a-f]{32,}\b/i;

/** One display row. `label` wins when given; otherwise the key is humanized. */
export interface OutputField {
  key: string;
  label?: string;
  value: unknown;
  /** Lower numbers render first. Default 100. */
  priority?: number;
}

/** De-hyphenate/de-underscore and sentence-case a raw key. */
function humanizeKey(key: string): string {
  const words = key.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Render a value as short plain text — never a JSON dump. */
function plainValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return Array.isArray(value) ? `${value.length} items` : 'Details inside';
  const text = String(value);
  if (INTERNAL_VALUE_PATTERN.test(text)) return 'Available';
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}

// ---------------------------------------------------------------------------
// PROPS
// ---------------------------------------------------------------------------

export interface OutputFieldListProps {
  fields: OutputField[];
  /** Rows shown before the reveal control. Default 6. */
  visibleLimit?: number;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * Labeled field rows with a reveal control for the overflow.
 */
export function OutputFieldList({ fields, visibleLimit = 6 }: OutputFieldListProps): React.ReactElement | null {
  const [expanded, setExpanded] = useState(false);

  const displayable = fields
    .filter((field) => !INTERNAL_KEY_PATTERN.test(field.key))
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));

  if (displayable.length === 0) return null;

  const visible = expanded ? displayable : displayable.slice(0, visibleLimit);
  const hiddenCount = displayable.length - visible.length;
  const rows = visible.map((field) => (
    <Container key={field.key} layout="horizontal" gap="md" alignItems="start">
      <Text variant="label">
        {field.label && !INTERNAL_VALUE_PATTERN.test(field.label) ? field.label : humanizeKey(field.key)}
      </Text>
      <Text variant="body-xs" color="secondary" truncate>{plainValue(field.value)}</Text>
    </Container>
  ));

  return (
    <Container layout="vertical" gap="sm">
      {expanded ? <ExpandableRegion lessLabel={null}><Container layout="vertical" gap="sm">{rows}</Container></ExpandableRegion> : rows}
      {hiddenCount > 0 ? (
        <Button variant="ghost" size="sm" onClick={() => setExpanded(true)}>
          Show details ({hiddenCount} more)
        </Button>
      ) : null}
      {expanded && displayable.length > visibleLimit ? (
        <Button variant="ghost" size="sm" onClick={() => setExpanded(false)}>
          Show less
        </Button>
      ) : null}
    </Container>
  );
}
