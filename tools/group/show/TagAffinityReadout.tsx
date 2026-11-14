// packages/group/show/TagAffinityReadout.tsx
//
// TAG AFFINITY READOUT — the surface for the `tag-cooccurrence` leaf (b117). It answers "which tags travel
// together on this board, and what is this card probably missing?" with three views over ONE analysis:
//   • a circular tag NETWORK — a node per tag (sized by how many cards carry it, tinted by the deterministic
//     labelColor), an edge per co-occurring pair (opacity by affinity strength); clicking a node selects the
//     cards that carry that tag.
//   • a ranked "go together" LIST — the strongest pairs in words.
//   • (when a card is focused) a "you might also tag…" strip — the tags that most co-occur with the card's
//     current tags, each citing the current tag that supports it.
//
// The scoring measure is DATA (`COOCCURRENCE_MEASURES`), never a branch. `ui`-only chrome (Container/Text —
// L065-safe); the network is plain SVG. Blind to what a tag MEANS — it renders whatever the leaf returns, so a
// new measure or a new tag needs zero readout code (L090). Deterministic layout (angle = index/N, no random).

import React from 'react';
import { Container, Text } from '../../ui';
import type { BoardItem } from '../read-data/group-board-model';
import { itemIsConnector } from '../read-data/group-board-model';
import { itemTags } from 'trillion-workshop/tools/organize-the-sidebar/show/item-tags.ts';
import { finiteCoord } from '../read-data/finite-coord';
import { labelColor } from 'trillion-workshop/tools/organize-the-sidebar/do-work/label-color.ts';
import {
  tagTotals,
  tagAffinities,
  suggestTags,
  COOCCURRENCE_MEASURES,
  type TagPair,
  type TagSuggestion,
  type CoOccurrenceMeasure,
} from 'trillion-workshop/tools/organize-the-sidebar/do-work/tag-cooccurrence.ts';

/** The board as tag sets (one per non-connector card). Connectors have no tags. */
export function boardTagSets(items: readonly BoardItem[]): string[][] {
  return items.filter((i) => !itemIsConnector(i)).map((i) => itemTags(i));
}

/** A laid-out tag node on the network circle. */
export interface TagNode {
  readonly tag: string;
  readonly count: number;
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly bg: string;
  readonly fg: string;
}

/** An edge between two laid-out nodes (endpoints resolved to node centres). */
export interface TagEdge {
  readonly a: string;
  readonly b: string;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly weight: number;
  readonly opacity: number;
  readonly count: number;
}

export interface TagGraphLayout {
  readonly nodes: readonly TagNode[];
  readonly edges: readonly TagEdge[];
  readonly size: number;
}

export interface TagGraphOptions {
  readonly measure?: string;
  readonly measures?: readonly CoOccurrenceMeasure[];
  /** Keep only the most-frequent N tags on the circle (default 16). */
  readonly maxTags?: number;
  /** Drop pairs seen on fewer than this many cards (default 1). */
  readonly minCount?: number;
  /** SVG viewport edge in px (default 260). */
  readonly size?: number;
}

const TWO_PI = Math.PI * 2;

/**
 * Lay the board's tags out as a circular network: each kept tag is a node (radius scaled by frequency, colour
 * from `labelColor`), each co-occurring pair among the kept tags is an edge (opacity scaled by affinity).
 * Deterministic: tags are ordered by frequency then name, placed at angle = index/N from the top. Pure geometry.
 */
export function tagGraphLayout(items: readonly BoardItem[], opts: TagGraphOptions = {}): TagGraphLayout {
  const { measure, measures = COOCCURRENCE_MEASURES, maxTags = 16, minCount = 1, size = 260 } = opts;
  const sets = boardTagSets(items);
  const totals = tagTotals(sets);
  const ranked = [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.max(0, maxTags));
  const kept = new Set(ranked.map(([t]) => t));

  const cx = size / 2;
  const cy = size / 2;
  const ring = size / 2 - 34; // leave room for the biggest node + its label
  const counts = ranked.map(([, c]) => c);
  const maxC = counts.length ? Math.max(...counts) : 1;
  const minC = counts.length ? Math.min(...counts) : 1;
  const rSpan = maxC > minC ? maxC - minC : 1;

  const nodes: TagNode[] = ranked.map(([tag, count], i) => {
    const ang = (i / Math.max(1, ranked.length)) * TWO_PI - Math.PI / 2;
    const frac = Math.sqrt((count - minC) / rSpan); // area-fair growth
    const r = 6 + frac * 12; // 6..18 px
    const col = labelColor(tag);
    return {
      tag,
      count,
      x: finiteCoord(cx + Math.cos(ang) * ring),
      y: finiteCoord(cy + Math.sin(ang) * ring),
      r: finiteCoord(r, 6),
      bg: col.bg,
      fg: col.fg,
    };
  });
  const byTag = new Map(nodes.map((n) => [n.tag, n]));

  const pairs = tagAffinities(sets, { measure, measures, minCount }).filter((p) => kept.has(p.a) && kept.has(p.b));
  const maxW = pairs.reduce((m, p) => Math.max(m, p.weight), 0) || 1;
  const edges: TagEdge[] = pairs.map((p) => {
    const na = byTag.get(p.a)!;
    const nb = byTag.get(p.b)!;
    return {
      a: p.a,
      b: p.b,
      x1: na.x,
      y1: na.y,
      x2: nb.x,
      y2: nb.y,
      weight: p.weight,
      opacity: 0.12 + 0.68 * (p.weight / maxW),
      count: p.count,
    };
  });

  return { nodes, edges, size };
}

/** The strongest pairs in words (for the ranked list). */
export function boardTopPairs(items: readonly BoardItem[], opts: TagGraphOptions = {}): TagPair[] {
  const { measure, measures, minCount = 1 } = opts;
  return tagAffinities(boardTagSets(items), { measure, measures, minCount, limit: opts.maxTags ?? 8 });
}

/** "You might also tag…" for a card's current tags. */
export function boardTagSuggestions(
  items: readonly BoardItem[],
  have: readonly string[],
  opts: { measure?: string; measures?: readonly CoOccurrenceMeasure[]; limit?: number } = {},
): TagSuggestion[] {
  return suggestTags(boardTagSets(items), have, { ...opts, limit: opts.limit ?? 5 });
}

export interface TagAffinityReadoutProps {
  readonly items: readonly BoardItem[];
  readonly measure?: string;
  readonly maxTags?: number;
  readonly minCount?: number;
  /** Select the cards carrying a tag (clicking a node / a pair endpoint). */
  readonly onPickTag?: (tag: string) => void;
  /** A focused card's current tags → drives the "you might also tag" strip. */
  readonly focusTags?: readonly string[];
  /** ADD a suggested tag to the focused card (the "+ tag" chips). Falls back to `onPickTag` when absent, so the
   *  chips select instead of write. When present, a chip click WRITES the tag onto the focused card. */
  readonly onAddTag?: (tag: string) => void;
}

/** The readout: the tag network + a ranked "go together" list + optional "also tag" suggestions. */
export function TagAffinityReadout({ items, measure, maxTags = 16, minCount = 1, onPickTag, focusTags, onAddTag }: TagAffinityReadoutProps) {
  const layout = tagGraphLayout(items, { measure, maxTags, minCount });
  const pairs = boardTopPairs(items, { measure, minCount, maxTags: 8 });
  const suggestions = focusTags && focusTags.length ? boardTagSuggestions(items, focusTags, { measure }) : [];
  const s = layout.size;
  // The "+ tag" chips WRITE onto the focused card when an add handler is given, else fall back to selecting.
  const addFn = onAddTag ?? onPickTag;

  return (
    <Container layout="vertical" gap="sm" style={{ padding: 14, background: '#ffffff', borderRadius: 12, border: '1px solid #e2e8f0', minWidth: 280 }} data-tag-affinity>
      <Text variant="body" style={{ fontWeight: 700, color: '#0f172a' }}>Tags that go together</Text>

      {layout.nodes.length === 0 ? (
        <Text variant="body-xs" color="muted">No tags yet — tag a few cards to see how your themes relate.</Text>
      ) : (
        <svg width={s} height={s} style={{ display: 'block' }} data-tag-graph>
          {layout.edges.map((e, i) => (
            <line key={`e${i}`} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} stroke="#6366f1" strokeOpacity={e.opacity} strokeWidth={1 + 2 * (e.opacity - 0.12)} strokeLinecap="round" />
          ))}
          {layout.nodes.map((n) => (
            <g key={n.tag} onClick={onPickTag ? () => onPickTag(n.tag) : undefined} style={{ cursor: onPickTag ? 'pointer' : 'default' }} data-tag-node={n.tag}>
              <circle cx={n.x} cy={n.y} r={n.r} fill={n.bg} stroke={n.fg} strokeWidth={1.2} />
              <text x={n.x} y={n.y + n.r + 11} textAnchor="middle" fontSize={10} fill="#334155">{n.tag}</text>
            </g>
          ))}
        </svg>
      )}

      {pairs.length > 0 && (
        <Container layout="vertical" gap="xs">
          {pairs.map((p, i) => (
            <Container key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '3px 8px', borderRadius: 6, background: '#f8fafc' }}>
              <Text variant="body-xs" style={{ color: '#334155' }}>{p.a} + {p.b}</Text>
              <Text variant="body-xs" color="muted">{p.count}× together</Text>
            </Container>
          ))}
        </Container>
      )}

      {suggestions.length > 0 && (
        <Container layout="vertical" gap="xs" style={{ borderTop: '1px solid #f1f5f9', paddingTop: 8 }}>
          <Text variant="body-xs" color="muted">You might also tag this card:</Text>
          <Container style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {suggestions.map((sg) => (
              <Container
                key={sg.tag}
                role="button"
                onClick={addFn ? () => addFn(sg.tag) : undefined}
                style={{ background: labelColor(sg.tag).bg, borderRadius: 999, padding: '2px 10px', cursor: addFn ? 'pointer' : 'default' }}
              >
                <Text variant="body-xs" style={{ color: labelColor(sg.tag).fg, fontWeight: 600 }}>+ {sg.tag}</Text>
              </Container>
            ))}
          </Container>
        </Container>
      )}
    </Container>
  );
}
