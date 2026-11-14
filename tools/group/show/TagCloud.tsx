// packages/group/show/TagCloud.tsx
//
// TAG / WORD CLOUD — the board surface for the `frequency-tally` primitive. It renders the board's tags (or
// words, or kinds) as chips SIZED by how often they appear, so the most-used label reads biggest (the Miro/
// FigJam tag-cloud + Roam word-cloud canon). BLIND to what it's counting (L090): the pure `tagCloudEntries`
// projector takes an injected `valuesOf` and never names "tag"/"word"; the `TAG_CLOUD_SOURCES` catalog carries
// the actual extractors as DATA (tags via `itemTags`, words via a tokeniser + stopword DATA, kinds via
// `i.kind`), each reusing an EXISTING accessor — a new count-source is one row, zero cloud code.
//
// Chips are built from `ui` primitives (Container/Text — L065-safe) and coloured by the deterministic
// `labelColor` (b101), matching a note's tag-chip tints. Connectors are excluded.

import React from 'react';
import { Container, Text } from '../../ui';
import type { BoardItem } from '../read-data/group-board-model';
import { itemIsConnector } from '../read-data/group-board-model';
import { itemTags } from 'trillion-workshop/tools/organize-the-sidebar/show/item-tags.ts';
import { labelColor } from 'trillion-workshop/tools/organize-the-sidebar/do-work/label-color.ts';
import { normalizeText } from 'trillion-workshop/tools/organize-the-sidebar/do-work/text-similarity.ts';
import {
  frequencyTally,
  tallyToRanked,
  frequencyScale,
  countRange,
  type FrequencyScaleKind,
} from 'trillion-workshop/tools/organize-the-sidebar/do-work/frequency-tally.ts';

/** One rendered cloud chip — DATA the cloud draws blindly. */
export interface CloudEntry {
  readonly value: string;
  readonly count: number;
  readonly size: number;
  readonly bg: string;
  readonly fg: string;
}

/** A selectable count-source — DATA (the extractor is injected; the cloud never enumerates sources). */
export interface CloudSource {
  readonly id: string;
  readonly label: string;
  readonly valuesOf: (item: BoardItem) => string[];
}

export interface TagCloudEntriesOptions {
  readonly valuesOf: (item: BoardItem) => string[];
  readonly minSize?: number;
  readonly maxSize?: number;
  readonly scale?: FrequencyScaleKind;
  readonly limit?: number;
}

/**
 * Pure projector: board items + an injected value extractor → the sized, coloured chips (ranked by count
 * DESC, capped at `limit`). Connectors excluded. Deterministic.
 */
export function tagCloudEntries(items: readonly BoardItem[], opts: TagCloudEntriesOptions): CloudEntry[] {
  const values: string[] = [];
  for (const item of items) {
    if (itemIsConnector(item)) continue;
    for (const v of opts.valuesOf(item)) values.push(v);
  }
  const tally = frequencyTally(values);
  const ranked = tallyToRanked(tally, { limit: opts.limit });
  const { min, max } = countRange(tally);
  return ranked.map((r) => {
    const c = labelColor(r.value);
    return {
      value: r.value,
      count: r.count,
      size: frequencyScale(r.count, { minCount: min, maxCount: max, minSize: opts.minSize, maxSize: opts.maxSize, scale: opts.scale }),
      bg: c.bg,
      fg: c.fg,
    };
  });
}

export interface TagCloudProps {
  readonly items: readonly BoardItem[];
  readonly source: CloudSource;
  readonly minSize?: number;
  readonly maxSize?: number;
  readonly scale?: FrequencyScaleKind;
  readonly limit?: number;
  readonly onPick?: (value: string) => void;
}

/** The cloud panel — sized, coloured chips wrapped in a flow. Blind to what it's counting. */
export function TagCloud({ items, source, minSize, maxSize, scale, limit, onPick }: TagCloudProps) {
  const entries = tagCloudEntries(items, { valuesOf: source.valuesOf, minSize, maxSize, scale, limit });
  return (
    <Container style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 8 }} data-cloud-source={source.id}>
      {entries.map((e) => (
        <Container
          key={e.value}
          onClick={onPick ? () => onPick(e.value) : undefined}
          style={{ background: e.bg, borderRadius: 999, padding: '2px 10px', cursor: onPick ? 'pointer' : 'default' }}
        >
          <Text style={{ fontSize: e.size, lineHeight: 1.1, color: e.fg, fontWeight: 600 }}>{e.value}</Text>
        </Container>
      ))}
    </Container>
  );
}

// ── DATA catalogs (a count-source is one row — L090) ──

/** A small stopword set (DATA, Society) so the word cloud isn't dominated by "the/and/to". */
export const CLOUD_STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'at', 'by', 'is', 'it',
  'this', 'that', 'be', 'are', 'was', 'as', 'from', 'but', 'not', 'you', 'your', 'we', 'i',
]);

/** Tokenise a note's text into content words (normalised, ≥ 3 chars, non-stopword). Society lives here as DATA. */
export function contentWords(text: string, stopwords: ReadonlySet<string> = CLOUD_STOPWORDS): string[] {
  return normalizeText(text)
    .split(' ')
    .filter((w) => w.length >= 3 && !stopwords.has(w));
}

export const TAG_CLOUD_SOURCES: readonly CloudSource[] = [
  { id: 'tags', label: 'Tag cloud', valuesOf: (i) => itemTags(i) },
  { id: 'words', label: 'Word cloud', valuesOf: (i) => contentWords(typeof i.text === 'string' ? i.text : '') },
  { id: 'kind', label: 'Type breakdown', valuesOf: (i) => (i.kind ? [i.kind] : []) },
];

export function cloudSourceById(id: string | undefined): CloudSource {
  return TAG_CLOUD_SOURCES.find((s) => s.id === id) ?? TAG_CLOUD_SOURCES[0];
}
