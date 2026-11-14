// packages/group/show/TagChipStrip.tsx
//
// A row of tag chips, each stably coloured by the deterministic `labelColor` primitive — so #gardening is the
// SAME colour on every note. Blind + generic: it renders whatever tag strings it is handed (a note's stored
// `extra.tags` unified with the #tags detected in its body via `detectEntities`), one chip per tag, with a
// hue derived from the tag text (never an index/order), so the colours are stable across notes and boards.
// Display-only, pure (no state, no I/O); renders null for an empty list so a tag-less note is byte-identical.
import React from 'react';
import { Container, Text } from '../../ui';
import { labelColor } from 'trillion-workshop/tools/organize-the-sidebar/do-work/label-color.ts';

export interface TagChipStripProps {
  readonly tags: readonly string[];
  /** data-attr flag so a proof/test can scope its DOM queries to this strip. */
  readonly flagAttr?: string;
}

export function TagChipStrip({ tags, flagAttr = 'data-tag-chip-strip' }: TagChipStripProps) {
  if (tags.length === 0) return null;
  return (
    <Container layout="horizontal" gap="xs" wrap alignItems="center" {...{ [flagAttr]: 'true' }}>
      {tags.map((tag) => {
        const c = labelColor(tag);
        const label = tag.replace(/^[#@]+/, '');
        return (
          <Container
            key={tag}
            data-tag-chip={c.key}
            style={{
              background: c.bg,
              borderRadius: 999,
              padding: '1px 8px',
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            <Text variant="caption" weight="semibold" style={{ color: c.fg }}>{`#${label}`}</Text>
          </Container>
        );
      })}
    </Container>
  );
}
