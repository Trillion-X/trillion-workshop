// packages/group/show/SavedArrangementGallery.tsx
//
// A modal grid over SavedArrangement rows (templates + collections + future
// sources). Each card: a thumbnail generated from the row payload via boardToSvg
// (#142 serializer), the label, its category, and one action button per capability
// the row carries. The caller receives opaque action keys and decides what each
// does (apply/rename/archive/restore/duplicate). Composed from ui primitives (L065).

import React, { useState, useMemo } from 'react';
import { Container, Card, Text, Button, Input, Badge } from '../../ui';
import { svgDataUrl } from '../../ui/show/raster/svg-to-png';
import { MediaFrame } from '../../ui/show/media-frame/MediaFrame';
import { boardToSvg, type BoardSvgStyle } from '../do-work/board-svg';
import type { BoardItem } from '../read-data/group-board-model';
import type { TemplateItem } from '../read-data/board-template-apply';
import type { SavedArrangement } from '../read-data/saved-arrangement';
import { searchArrangements, arrangementFacetValues, arrangementFacetCounts } from '../read-data/saved-arrangement';
import { toggleFacetValue, hasActiveFacets, type FacetSelection } from 'trillion-workshop/tools/organize-the-sidebar/read-data/facet-filter.ts';
import { FacetChipGroup } from './FacetChipGroup';
import { FloatingPanel } from '../../screen-arrangement/show/FloatingPanel';

export { FacetChipGroup }; // re-export (moved to its own file at the 2nd consumer, L088)

/** Flatten an arrangement's tree (sections + children) into flat world-space
 *  BoardItem[] that boardToSvg consumes — the thumbnail mirror of flattenBoardTree. */
function templateToBoardItems(items: readonly TemplateItem[]): BoardItem[] {
  const out: BoardItem[] = [];
  const walk = (list: readonly TemplateItem[]) => {
    for (const it of list) {
      const extra: Record<string, unknown> = { ...(it.extra ?? {}) };
      if (it.from) extra.fromMemberId = it.from;
      if (it.to) extra.toMemberId = it.to;
      out.push({
        memberId: it.id,
        nodeRef: { family: 'group.board-item', parts: { item: it.id } },
        kind: it.kind,
        x: it.x,
        y: it.y,
        w: it.w,
        h: it.h,
        text: it.text,
        isSection: !!it.children,
        childCount: it.children?.length ?? 0,
        extra,
      });
      if (it.children) walk(it.children);
    }
  };
  walk(items);
  return out;
}

/** Soft fill + border derived from a sticky's layer-stack colour for the preview. */
function thumbFill(item: BoardItem): BoardSvgStyle | undefined {
  if (item.isSection) return { fill: 'transparent', stroke: '#cbd5e1', strokeWidth: 1.5, cornerRadius: 10 };
  const stack = item.extra?.visualLayerStack as { frame?: { border?: { color?: unknown } } } | undefined;
  const color = stack?.frame?.border?.color;
  if (typeof color === 'string') {
    return { fill: `color-mix(in srgb, ${color} 32%, white)`, stroke: color, strokeWidth: 1, cornerRadius: 10 };
  }
  return undefined;
}

/** The thumbnail SVG string for an arrangement. Snapshot rows render their fixed items;
 *  a live-lens row has no fixed body (it re-derives on apply), so it renders a simple
 *  cluster-glyph preview instead of concrete items. */
export function arrangementThumbSvg(arrangement: SavedArrangement): string {
  if (!arrangement.payload) return LENS_THUMB_SVG;
  return boardToSvg(templateToBoardItems(arrangement.payload.items), { fillOf: thumbFill, padding: 28, background: '#ffffff' });
}

/** A static cluster-glyph thumbnail for live-lens rows — three grouped bands, signalling
 *  "re-clusters the board" without implying a fixed layout. */
const LENS_THUMB_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 90" width="120" height="90">'
  + '<rect width="120" height="90" fill="#ffffff"/>'
  + '<rect x="14" y="14" width="30" height="16" rx="4" fill="#dbeafe" stroke="#3b82f6"/>'
  + '<rect x="48" y="14" width="30" height="16" rx="4" fill="#dbeafe" stroke="#3b82f6"/>'
  + '<rect x="14" y="38" width="30" height="16" rx="4" fill="#dcfce7" stroke="#22c55e"/>'
  + '<rect x="14" y="62" width="30" height="16" rx="4" fill="#fef3c7" stroke="#f59e0b"/>'
  + '<rect x="48" y="62" width="30" height="16" rx="4" fill="#fef3c7" stroke="#f59e0b"/>'
  + '</svg>';

/** One action offered on a row: a stable key + its human label. Archived rows
 *  swap Archive→Restore. Built from `capabilities` DATA — no source branching. */
export interface ArrangementAction {
  readonly key: string;
  readonly label: string;
}

/** The action list a row offers, derived purely from its capabilities + archived
 *  state. Apply is primary; the rest are management actions the store backs. */
export function arrangementActions(row: SavedArrangement): ArrangementAction[] {
  const actions: ArrangementAction[] = [];
  if (row.capabilities.apply) actions.push({ key: 'apply', label: 'Use' });
  // Any RESOLVABLE row (one that can be applied → resolves to a placeable template) can also be COMPARED
  // against the current board — a read-only "what changed since this version?" (b145). Gated on apply so an
  // unresolvable row never offers a dead compare.
  if (row.capabilities.apply) actions.push({ key: 'compare', label: 'Compare' });
  if (row.capabilities.duplicate) actions.push({ key: 'duplicate', label: 'Duplicate' });
  if (row.capabilities.rename) actions.push({ key: 'rename', label: 'Rename' });
  if (row.capabilities.archive) {
    actions.push(row.archived ? { key: 'restore', label: 'Restore' } : { key: 'archive', label: 'Archive' });
  }
  return actions;
}

export interface SavedArrangementGalleryProps {
  readonly open: boolean;
  readonly arrangements: readonly SavedArrangement[];
  /** Opaque action dispatch — the caller decides what each key does. */
  readonly onAction: (action: string, row: SavedArrangement) => void;
  readonly onClose: () => void;
  readonly title?: string;
  readonly description?: string;
  /** When provided, a footer button that snapshots the CURRENT board into the
   *  library (the `saveBoardAsArrangement` capability). Absent → no footer. */
  readonly onSaveCurrent?: () => void;
  readonly saveCurrentLabel?: string;
}

export function SavedArrangementGallery({
  open,
  arrangements,
  onAction,
  onClose,
  title = 'Library',
  description = 'Pick a saved arrangement',
  onSaveCurrent,
  saveCurrentLabel = 'Save this board',
}: SavedArrangementGalleryProps) {
  const [query, setQuery] = useState('');
  const [facets, setFacets] = useState<FacetSelection>({}); // DATA-driven multi-facet selection

  // The filter dimensions are DATA — whatever category/tag values the rows actually carry
  // (R4), derived through the ONE facet SSOT so a new value needs zero UI change.
  const categoryValues = useMemo(() => arrangementFacetValues(arrangements, 'category'), [arrangements]);
  const tagValues = useMemo(() => arrangementFacetValues(arrangements, 'tag'), [arrangements]);
  // Per-chip match counts given the OTHER active filters (conjunctive faceted-nav) — tells the
  // user how many layouts each chip would show before they click it. Recomputed as facets change.
  const categoryCounts = useMemo(() => arrangementFacetCounts(arrangements, 'category', facets), [arrangements, facets]);
  const tagCounts = useMemo(() => arrangementFacetCounts(arrangements, 'tag', facets), [arrangements, facets]);
  const toggle = (facetKey: string, value: string) => setFacets((f) => toggleFacetValue(f, facetKey, value));
  // R4 — ranked search (name > tag > description) + the multi-facet filter (category ∈ {…}
  // AND tag ∈ {…}), via the SSOT `searchArrangements` (reuses `searchCollections`).
  const shown = useMemo(
    () => searchArrangements(arrangements, { text: query, facets }),
    [arrangements, query, facets],
  );
  return (
    <FloatingPanel open={open} onClose={onClose} title={title} description={description} width={768}>
      {onSaveCurrent ? (
        <Container layout="horizontal" gap="xs" alignItems="center" justifyContent="end">
          <Button variant="secondary" size="sm" onClick={onSaveCurrent} aria-label={saveCurrentLabel}>
            {saveCurrentLabel}
          </Button>
        </Container>
      ) : null}
      {arrangements.length === 0 ? (
        <Text variant="body" color="muted">No saved layouts yet — save this board to start your library.</Text>
      ) : null}
      {arrangements.length > 1 ? (
        <>
          <FacetChipGroup facetKey="category" label="Category" values={categoryValues} selected={facets.category ?? []} onToggle={toggle} minValues={2} counts={categoryCounts} />
          <FacetChipGroup facetKey="tag" label="Tags" values={tagValues} selected={facets.tag ?? []} onToggle={toggle} minValues={2} counts={tagCounts} />
        </>
      ) : null}
      {arrangements.length > 3 ? (
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name, tag or description…"
          aria-label="Search layouts"
        />
      ) : null}
      {arrangements.length > 0 && shown.length === 0 ? (
        <Text variant="body" color="muted">
          No layouts match{query.trim() ? ` “${query.trim()}”` : ''}{hasActiveFacets(facets) ? ' with those filters' : ''}.
        </Text>
      ) : null}
      <Container layout="grid" gridCols={3} gap="md">
        {shown.map((row) => (
          <Card key={row.id} variant="ghost" padding="sm" aria-label={row.label}>
            <Container layout="vertical" gap="xs">
              <Card
                variant="ghost"
                padding="none"
                interactive
                onClick={() => onAction('apply', row)}
                aria-label={`Use ${row.label}`}
              >
                <MediaFrame url={svgDataUrl(arrangementThumbSvg(row))} mediaType="image/svg+xml" label={row.label} />
              </Card>
              <Text variant="body" weight="medium">{row.label}</Text>
              {row.category ? <Text variant="caption" color="muted">{row.category}</Text> : null}
              {row.description ? <Text variant="caption" color="muted">{row.description}</Text> : null}
              {row.tags && row.tags.length > 0 ? (
                <Container layout="horizontal" gap="xs" wrap aria-label={`Tags for ${row.label}`}>
                  {row.tags.map((tag) => (
                    <Badge key={tag} variant="muted" size="sm">{tag}</Badge>
                  ))}
                </Container>
              ) : null}
              <Container layout="horizontal" gap="xs" wrap>
                {arrangementActions(row).map((a) => (
                  <Button
                    key={a.key}
                    variant={a.key === 'apply' ? 'primary' : 'ghost'}
                    size="sm"
                    onClick={() => onAction(a.key, row)}
                    aria-label={`${a.label} ${row.label}`}
                  >
                    {a.label}
                  </Button>
                ))}
              </Container>
            </Container>
          </Card>
        ))}
      </Container>
    </FloatingPanel>
  );
}

SavedArrangementGallery.displayName = 'SavedArrangementGallery';
