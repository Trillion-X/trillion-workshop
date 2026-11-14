// packages/group/show/BoardFocusBar.tsx
// The board focus bar: free-text search + DATA-driven facet chip groups (tag/color/kind) +
// hidden-items reveal controls. The facet groups run on the SAME `facet-filter` engine as the
// template-library filter (the cont.28 primitive, second consumer) — a new focus dimension is
// one descriptor row, zero bar code.

import React from 'react';
import { Button, Container, ExpandableTabs, Icon, Input, Text } from '../../ui';
import { Bookmark, CheckSquare, Eye, EyeOff, GitBranch, Minimize2, Network, Replace, Search, X } from 'lucide-react';
import { FacetChipGroup } from './FacetChipGroup';
import { hasActiveFacets, type FacetSelection } from 'trillion-workshop/tools/organize-the-sidebar/read-data/facet-filter.ts';
import { searchFieldKeyIntent } from 'trillion-workshop/tools/organize-the-sidebar/read-data/search-field-key.ts';
import type { BoardFocusFacet } from './board-item-facets';
import type { FocusView } from './focus-view';

/** Imperative handle: focus the board's search field (⌘F / "/" on the canvas drive this). `focusSearch`
 *  returns whether it focused — false when the search field is not currently rendered, so the caller can
 *  fall through to the browser's native find on a board too small to search (L090: self-describing). */
export interface BoardFocusBarHandle {
  focusSearch: () => boolean;
}

export interface BoardFocusBarProps {
  /** Show the search + facet-chip cluster (taggable/coloured OR big enough to search). */
  showSearch: boolean;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  /** Live match count while a search is active; null hides the readout. */
  foundCount: number | null;
  /** 1-based position of the currently STEPPED-TO match (find-next), or null when no match is stepped to.
   *  When present with `onStepMatch`, the readout shows "N of M" and prev/next chevrons appear. */
  matchCursor?: number | null;
  /** Step to the next (+1) / previous (-1) match — selects + reveals it on the board. Enter / Shift+Enter
   *  in the search field trigger the same. Omitted → search stays a static count (zero regression). */
  onStepMatch?: (delta: 1 | -1) => void;
  /** Replace every match of the current search with the given text (the write twin of the read-only
   *  find). When provided AND a search is active, a "Replace all" affordance appears next to the
   *  count. Omitted → search stays read-only (zero regression). */
  onReplace?: (find: string, replaceWith: string) => void;
  /** The focus facet dimensions to offer (tag/color/kind, DATA — `BOARD_FOCUS_FACETS`). */
  facets: readonly BoardFocusFacet[];
  /** The available values for one facet across the board (drives the chip group). */
  facetValuesFor: (facetKey: string) => readonly string[];
  /** Per-value match counts for one facet given the other active focus filters — how many
   *  items each chip would focus. When absent, chips render without counts. */
  facetCountsFor?: (facetKey: string) => Readonly<Record<string, number>>;
  /** Per-value COLOUR for one facet — the colour "Colour by <facet>" paints each value (from
   *  `facetColorAssignment`, stable board-wide). When present, each chip shows a swatch, so the
   *  focus chips double as a LIVE colour LEGEND for colour-by-facet. Absent → no swatches. */
  facetColorsFor?: (facetKey: string) => Readonly<Record<string, string>>;
  /** The active multi-facet selection (case-insensitive membership drives chip state). */
  facetSelection: FacetSelection;
  onToggleFacet: (facetKey: string, value: string) => void;
  /** The RELATIONSHIP focus over CONNECTORS — an INDEPENDENT facet selection from the node
   *  facets above (a connector's relationKind cannot live in the node selection without
   *  fail-closing every node). Rendered as a second chip cluster ("Relationship"); omitted →
   *  no cluster. Dims non-matching connectors on the canvas (DIM-only). */
  connectorFocusFacets?: readonly BoardFocusFacet[];
  connectorFacetValuesFor?: (facetKey: string) => readonly string[];
  connectorFacetCountsFor?: (facetKey: string) => Readonly<Record<string, number>>;
  connectorFacetSelection?: FacetSelection;
  onToggleConnectorFacet?: (facetKey: string, value: string) => void;
  /** SELECT the focused relationship — turn the relation focus into a selection of the matching
   *  connectors (then bulk delete/restyle them). Shown only when a relationship focus is active. */
  onSelectRelationship?: () => void;
  /** How many connectors match the active relationship focus — labels the Select button. */
  relationMatchCount?: number;
  /** TRAVERSE the graph: from the single selected node, select its whole transitive downstream
   *  subtree following ONLY the focused relationship kind. Passed (defined) only when exactly one
   *  node is selected AND a relationship focus is active; omitted otherwise. */
  onSelectDownstream?: () => void;
  /** The upstream twin — select the transitive ANCESTOR chain (walk the focused relationship
   *  backward). Same gating as downstream. */
  onSelectUpstream?: () => void;
  /** ISOLATE the relationship focus — HIDE every connector NOT of the focused kind (declutter to
   *  just those lines). Shown only when a relationship focus is active. */
  onHideUnrelated?: () => void;
  /** True iff any facet is active OR a search is running — drives the Clear button (L118). */
  hasActiveFocus: boolean;
  onClearFocus: () => void;
  /** Select the items currently in focus — turns the read-only focus into an actionable selection
   *  (then arrange / restyle / save-as-collection / share the subset). Shown when focus + matches. */
  onSelectFocused?: () => void;
  /** ISOLATE: hide every visible item NOT in focus (the existing hide infra is the exit). Shown
   *  when focus + matches — declutters to just the matching set (Miro/FigJam "isolate"). */
  onHideOthers?: () => void;
  /** Saved focus views for THIS board (name + facets + query). Empty → no Views cluster (L118). */
  views?: readonly FocusView[];
  /** Save the CURRENT focus as a named view (shown only when a focus is active). */
  onSaveView?: () => void;
  /** Apply a saved view (sets the board's focus facets + query). */
  onApplyView?: (view: FocusView) => void;
  /** Delete a saved view. */
  onDeleteView?: (view: FocusView) => void;
  /** How many items are hidden; 0 hides the reveal controls (L118). */
  hiddenCount: number;
  showHidden: boolean;
  onToggleShowHidden: () => void;
  onShowAll: () => void;
}

export const BoardFocusBar = React.forwardRef<BoardFocusBarHandle, BoardFocusBarProps>(function BoardFocusBar({
  showSearch,
  searchQuery,
  onSearchChange,
  foundCount,
  matchCursor,
  onStepMatch,
  onReplace,
  facets,
  facetValuesFor,
  facetCountsFor,
  facetColorsFor,
  facetSelection,
  onToggleFacet,
  connectorFocusFacets,
  connectorFacetValuesFor,
  connectorFacetCountsFor,
  connectorFacetSelection,
  onToggleConnectorFacet,
  onSelectRelationship,
  relationMatchCount,
  onSelectDownstream,
  onSelectUpstream,
  onHideUnrelated,
  hasActiveFocus,
  onClearFocus,
  onSelectFocused,
  onHideOthers,
  views = [],
  onSaveView,
  onApplyView,
  onDeleteView,
  hiddenCount,
  showHidden,
  onToggleShowHidden,
  onShowAll,
}: BoardFocusBarProps, ref: React.ForwardedRef<BoardFocusBarHandle>) {
  const [replaceValue, setReplaceValue] = React.useState('');
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  // ⌘F / "/" on the canvas focus the search field through this handle. It reports whether it focused
  // (false when the field is not rendered) so the panel falls back to native find on a tiny board.
  React.useImperativeHandle(ref, () => ({
    focusSearch: () => {
      const el = searchInputRef.current;
      if (!el) return false;
      el.focus();
      el.select();
      return true;
    },
  }), []);
  return (
    <Container layout="horizontal" gap="xs" padding="xs" alignItems="center" wrap>
      {showSearch ? (
        <>
          <Input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={(e) => {
              // The find-field lifecycle in one blind dispatch (searchFieldKeyIntent, unit-tested):
              // Enter → next / Shift+Enter → prev (select + reveal the match); Escape is a two-stage
              // dismiss — clear a non-empty query, else blur back to the canvas. Everything else is native.
              const intent = searchFieldKeyIntent({
                key: e.key,
                shiftKey: e.shiftKey,
                hasQuery: searchQuery !== '',
                matchCount: foundCount ?? 0,
                canStep: !!onStepMatch,
              });
              if (intent === null) return;
              e.preventDefault();
              if (intent === 'step-next') onStepMatch?.(1);
              else if (intent === 'step-prev') onStepMatch?.(-1);
              else if (intent === 'clear') onSearchChange('');
              else if (intent === 'blur') searchInputRef.current?.blur();
            }}
            placeholder="Search the board"
            aria-label="Search the board"
            icon={<Icon icon={Search} size="xs" />}
            // Narrower on a phone, so the search and the filters beside it share one row above the board.
            className="w-36 md:w-52"
          />
          {searchQuery !== '' ? (
            <Button variant="ghost" size="sm" aria-label="Clear search" onClick={() => onSearchChange('')}>
              <Icon icon={X} size="xs" />
            </Button>
          ) : null}
          {foundCount !== null ? (
            <Text variant="body-xs" color="muted" aria-live="polite">
              {matchCursor != null ? `${matchCursor} of ${foundCount}` : `${foundCount} found`}
            </Text>
          ) : null}
          {onStepMatch && (foundCount ?? 0) > 0 ? (
            <ExpandableTabs
              mode="action"
              size="sm"
              ariaLabel="Matches"
              items={[
                { id: 'previous', label: 'Previous match', icon: 'ChevronUp' },
                { id: 'next', label: 'Next match', icon: 'ChevronDown' },
              ]}
              onSelect={(id) => onStepMatch(id === 'previous' ? -1 : 1)}
            />
          ) : null}
          {onReplace && searchQuery !== '' ? (
            <>
              <Input
                value={replaceValue}
                onChange={(e) => setReplaceValue(e.target.value)}
                placeholder="Replace with"
                aria-label="Replace matches with"
                icon={<Icon icon={Replace} size="xs" />}
              />
              <Button
                variant="ghost"
                size="sm"
                aria-label="Replace all matches"
                disabled={foundCount === 0}
                onClick={() => onReplace(searchQuery, replaceValue)}
              >
                Replace all
              </Button>
            </>
          ) : null}
          {facets.map((facet) => (
            <FacetChipGroup
              key={facet.key}
              facetKey={facet.key}
              label={facet.label}
              values={facetValuesFor(facet.key)}
              selected={facetSelection[facet.key] ?? []}
              onToggle={onToggleFacet}
              counts={facetCountsFor?.(facet.key)}
              colors={facetColorsFor?.(facet.key)}
            />
          ))}
          {/* The RELATIONSHIP focus over connectors — an independent selection; each group
              hides itself when the board has no such connectors (FacetChipGroup minValues). */}
          {connectorFocusFacets && onToggleConnectorFacet && connectorFacetValuesFor
            ? connectorFocusFacets.map((facet) => (
                <FacetChipGroup
                  key={`rel-${facet.key}`}
                  facetKey={facet.key}
                  label={facet.label}
                  values={connectorFacetValuesFor(facet.key)}
                  selected={connectorFacetSelection?.[facet.key] ?? []}
                  onToggle={onToggleConnectorFacet}
                  counts={connectorFacetCountsFor?.(facet.key)}
                  minValues={2}
                />
              ))
            : null}
          {onSelectRelationship && hasActiveFacets(connectorFacetSelection ?? {}) && (relationMatchCount ?? 0) > 0 ? (
            <Button variant="ghost" size="sm" aria-label={`Select the ${relationMatchCount} focused ${relationMatchCount === 1 ? 'line' : 'lines'}`} onClick={onSelectRelationship}>
              <Icon icon={CheckSquare} size="xs" /> Select {relationMatchCount} {relationMatchCount === 1 ? 'line' : 'lines'}
            </Button>
          ) : null}
          {onSelectDownstream && hasActiveFacets(connectorFacetSelection ?? {}) ? (
            <Button variant="ghost" size="sm" aria-label="Select the downstream subtree along the focused relationship" onClick={onSelectDownstream}>
              <Icon icon={Network} size="xs" /> Select downstream
            </Button>
          ) : null}
          {onSelectUpstream && hasActiveFacets(connectorFacetSelection ?? {}) ? (
            <Button variant="ghost" size="sm" aria-label="Select the upstream lineage along the focused relationship" onClick={onSelectUpstream}>
              <Icon icon={GitBranch} size="xs" /> Select upstream
            </Button>
          ) : null}
          {onHideUnrelated && hasActiveFacets(connectorFacetSelection ?? {}) ? (
            <Button variant="ghost" size="sm" aria-label="Hide lines outside the relationship focus" onClick={onHideUnrelated}>
              <Icon icon={Minimize2} size="xs" /> Hide unrelated
            </Button>
          ) : null}
          {hasActiveFocus ? (
            <Button variant="ghost" size="sm" aria-label="Clear board focus" onClick={onClearFocus}>
              Clear
            </Button>
          ) : null}
          {/* Turn the focus into a SELECTION — only when a focus is active AND some items match
              (foundCount > 0), so the user can act on the filtered subset (L118). */}
          {hasActiveFocus && onSelectFocused && foundCount !== null && foundCount > 0 ? (
            <Button variant="secondary" size="sm" aria-label={`Select ${foundCount} focused items`} onClick={onSelectFocused}>
              <Icon icon={CheckSquare} size="xs" /> Select {foundCount}
            </Button>
          ) : null}
          {hasActiveFocus && onHideOthers && foundCount !== null && foundCount > 0 ? (
            <Button variant="ghost" size="sm" aria-label="Hide items not in focus" onClick={onHideOthers}>
              <Icon icon={Minimize2} size="xs" /> Hide others
            </Button>
          ) : null}
          {/* Save the current focus as a named view — only when there IS a focus AND a save
              handler is wired (L118: no dead control). */}
          {hasActiveFocus && onSaveView ? (
            <Button variant="ghost" size="sm" aria-label="Save this view" onClick={onSaveView}>
              <Icon icon={Bookmark} size="xs" /> Save view
            </Button>
          ) : null}
          {/* Saved views for this board — each applies its focus on click; a small x deletes it.
              Absent when there are none (no clutter). */}
          {views.length > 0 && onApplyView ? (
            <Container layout="horizontal" gap="xs" alignItems="center" wrap aria-label="Saved views">
              <Text variant="caption" color="muted">Views</Text>
              {views.map((view) => (
                <Container key={view.id} layout="horizontal" gap="none" alignItems="center">
                  <Button variant="secondary" size="sm" aria-label={`Apply view: ${view.name}`} onClick={() => onApplyView(view)}>
                    {view.name}
                  </Button>
                  {onDeleteView ? (
                    <Button variant="ghost" size="sm" aria-label={`Delete view: ${view.name}`} onClick={() => onDeleteView(view)}>
                      <Icon icon={X} size="xs" />
                    </Button>
                  ) : null}
                </Container>
              ))}
            </Container>
          ) : null}
        </>
      ) : null}
      {/* Reveal/hide the board's hidden items (#149) — only present when something is
          actually hidden (L118: no dead control). Toggling shows hidden items as
          selectable ghosts so they can be un-hidden via the Show batch row. */}
      {hiddenCount > 0 ? (
        <>
          <Button
            variant={showHidden ? 'primary' : 'secondary'}
            size="sm"
            aria-pressed={showHidden}
            aria-label={showHidden ? 'Hide hidden items' : `Show hidden items (${hiddenCount})`}
            onClick={onToggleShowHidden}
          >
            <Icon icon={showHidden ? Eye : EyeOff} size="xs" /> {showHidden ? 'Hiding' : `Show hidden (${hiddenCount})`}
          </Button>
          {/* Bulk inverse of Hide (#150): un-hide everything in one undoable batch. */}
          <Button variant="ghost" size="sm" aria-label="Show all hidden items" onClick={onShowAll}>
            Show all
          </Button>
        </>
      ) : null}
    </Container>
  );
});
