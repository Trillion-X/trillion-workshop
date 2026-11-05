// packages/group/show/SmartSetStrip.tsx
//
// The saved SMART-SETS strip — the product surface for `saved-smart-set` (a named, re-resolving selection). Save
// the current facet query to the library and RE-APPLY a saved one. A chip click acts on the saved query in one of
// two MODES (b206): SELECT (resolve → select the matching cards) or FOCUS (restore the query into the board's
// focus bar → dim non-matching, the "smart folder" behavior). Unlike a plain saved-item strip it owns the LIVE
// COUNT: each chip shows how many cards its query matches RIGHT NOW ("Ideas in progress · 4"), tracking the board
// as it changes (the whole point of a smart set vs a frozen id list). Presentation is delegated to the generic
// `SavedItemsStrip` (b193, L100); this component owns the live-count projection + the mode routing. Blind over the
// list (L090). The Focus mode + its toggle appear ONLY when an `onFocus` handler is supplied (L118).
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { useRef, useState } from 'react';
import { Button, Container, Text } from '../../ui/index.ts';
import { SavedItemsStrip, type SavedItem } from './SavedItemsStrip.tsx';
import type { BoardItem } from '../read-data/group-board-model.ts';
import { explainFacetMatch, ownValue, type FacetExtractors } from '../read-data/facet-filter.ts';
import { type StoredSmartSet, type SmartQuery, resolveSmartSet, compareSmartSet, sameSmartQuery } from '../read-data/saved-smart-set.ts';

export interface SmartSetStripProps {
  readonly sets: readonly StoredSmartSet[];
  readonly unavailableSets?: readonly { memberId: string; name: string }[];
  /** The live board — smart sets re-resolve against THIS every render, so the counts track changes. */
  readonly items: readonly BoardItem[];
  /** The injected facet extractors (which dimensions exist + how to read each) — the strip stays blind. */
  readonly extractors: FacetExtractors<BoardItem>;
  readonly facetLabels?: Readonly<Record<string, string>>;
  readonly currentQuery?: SmartQuery;
  readonly onReplaceQuery?: (memberId: string, expected: SmartQuery, replacement: SmartQuery) => Promise<string | null>;
  /** Save the CURRENT facet query to the library. */
  readonly onSaveCurrent?: () => void;
  /** Apply a saved set by SELECTING — receives the memberIds its query resolves to against the live board. */
  readonly onApply: (ids: string[]) => void;
  /** Apply a saved set by FOCUSING — receives the saved query so the caller can restore it into the focus bar
   *  (dim non-matching). When omitted, only Select mode exists (no toggle shown). */
  readonly onFocus?: (query: SmartQuery) => void;
  /** Remove (archive) a saved set by memberId. When supplied, each chip gains a remove affordance. */
  readonly onArchive?: (memberId: string) => void;
  readonly archivedSets?: readonly StoredSmartSet[];
  readonly onRestore?: (memberId: string) => void;
  readonly onRename?: (memberId: string, name: string) => void;
}

/** "Save smart set" + a chip per saved set showing its live match count; a click re-resolves and either selects
 *  or focuses per the active mode. */
export function SmartSetStrip({ sets, unavailableSets = [], items, extractors, facetLabels = {}, currentQuery, onReplaceQuery, onSaveCurrent, onApply, onFocus, onArchive, archivedSets = [], onRestore, onRename }: SmartSetStripProps) {
  const [mode, setMode] = useState<'select' | 'focus'>('select');
  const [inspection, setInspection] = useState<{ id: string; limit: number } | null>(null);
  const [comparison, setComparison] = useState<{ id: string; before: SmartQuery; after: SmartQuery } | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const inspected = sets.find(set => set.memberId === inspection?.id);
  const inspectedIds = new Set(inspected ? resolveSmartSet(items, inspected.query, extractors) : []);
  const inspectedItems = items.filter(item => inspectedIds.has(item.memberId));
  const preview = inspected && comparison?.id === inspected.memberId ? compareSmartSet(items, comparison.before, comparison.after, extractors) : null;
  const staleComparison = !!(inspected && comparison && !sameSmartQuery(inspected.query, comparison.before));
  const saveComparison = async () => {
    if (!comparison || !onReplaceQuery || staleComparison || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveMessage(null);
    try {
      const error = await onReplaceQuery(comparison.id, comparison.before, comparison.after);
      setSaveMessage(error ?? 'Filters saved.');
      if (error === null) setComparison(null);
    } catch {
      setSaveMessage('Could not confirm the save. Reopen this query before trying again.');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const focusing = mode === 'focus' && !!onFocus;
  const chips: SavedItem[] = sets.map((s) => {
    const count = resolveSmartSet(items, s.query, extractors).length;
    return {
    id: s.memberId,
    name: `${s.name} · ${count}`,
    editableName: s.name,
    detail: `${count} ${count === 1 ? 'match' : 'matches'}`,
  }; });
  const act = (memberId: string) => {
    const set = sets.find((s) => s.memberId === memberId);
    if (!set) return;
    if (focusing && onFocus) onFocus(set.query);
    else onApply(resolveSmartSet(items, set.query, extractors));
  };
  const strip = (
    <Container layout="vertical" gap="xs">
    {unavailableSets.map(set => (
      <Text key={set.memberId} variant="body-xs" tone="muted">
        {set.name || 'Saved query'} — unavailable because its filters could not be read. Your cards are unchanged.
      </Text>
    ))}
    {!onSaveCurrent ? <Text variant="body-xs" tone="muted">{items.length === 0 ? 'Add cards to filter and save a query.' : 'Choose a board filter to save a query.'}</Text> : null}
    <SavedItemsStrip
      title="Smart sets"
      saveLabel="Save smart set"
      openVerb={focusing ? 'focus' : 'apply'}
      items={chips}
      onSave={onSaveCurrent}
      onOpen={act}
      onRemove={onArchive}
      onRename={onRename}
      onInspect={id => { if (savingRef.current) return; setInspection(current => current?.id === id ? null : { id, limit: 20 }); setComparison(null); setSaveMessage(null); }}
      inspectVerb="Why it matches"
      removeVerb="archive"
    />
    {inspected && inspection ? <Container layout="vertical" gap="xs" aria-label={`Why it matches ${inspected.name}`}>
      <Text variant="body-xs">{inspected.name}: {inspectedItems.length} current {inspectedItems.length === 1 ? 'match' : 'matches'}</Text>
      {inspectedItems.length === 0 ? <Text variant="body-xs" tone="muted">No cards match these filters right now.</Text> : null}
      {inspectedItems.slice(0, inspection.limit).map(item => {
        const reason = explainFacetMatch(item, inspected.query.selection, extractors);
        const label = item.text?.trim().split('\n')[0]?.slice(0, 100) || 'Untitled card';
        return <Container key={item.memberId} layout="vertical" gap="xs">
          <Button variant="ghost" size="sm" aria-label={`Select matching card ${label}`} onClick={() => onApply([item.memberId])}>{label}</Button>
          <Text variant="body-xs" tone="muted">{reason.facets.length === 0 ? 'This query has no filters.' : reason.facets.map(facet => `${ownValue(facetLabels, facet.key) ?? facet.key}: ${facet.matchedValues.join(', ')}`).join(' · ')}</Text>
        </Container>;
      })}
      {inspectedItems.length > inspection.limit ? <Button variant="ghost" size="sm" onClick={() => setInspection(current => current ? { ...current, limit: current.limit + 20 } : null)}>Show more matches</Button> : null}
      {currentQuery && onReplaceQuery ? <Button variant="ghost" size="sm" disabled={saving || sameSmartQuery(inspected.query, currentQuery)} onClick={() => { setComparison({ id: inspected.memberId, before: inspected.query, after: currentQuery }); setSaveMessage(null); }}>Compare current board filters</Button> : null}
      {preview && comparison ? <Container layout="vertical" gap="xs" aria-label="Filter change preview">
        <Text variant="body-xs">Matches before: {preview.beforeIds.length}. Matches after: {preview.afterIds.length}.</Text>
        {[{ title: 'Added', ids: preview.addedIds }, { title: 'Removed', ids: preview.removedIds }].map(group => <Container key={group.title} layout="vertical" gap="xs">
          <Text variant="body-xs">{group.title}: {group.ids.length}</Text>
          {group.ids.slice(0, inspection.limit).map(id => <Text key={id} variant="body-xs" tone="muted">{items.find(item => item.memberId === id)?.text?.trim().split('\n')[0]?.slice(0, 100) || 'Untitled card'}</Text>)}
          {group.ids.length > inspection.limit ? <Button variant="ghost" size="sm" onClick={() => setInspection(current => current ? { ...current, limit: current.limit + 20 } : null)}>Show more {group.title.toLowerCase()} cards</Button> : null}
        </Container>)}
        <Text variant="body-xs" tone="muted">Only the saved filters change. Your cards stay where they are.</Text>
        {staleComparison ? <Text variant="body-xs">This saved query changed. Compare its filters again before saving.</Text> : null}
        <Button variant="secondary" size="sm" disabled={saving || staleComparison} onClick={() => saveComparison()}>{saving ? 'Saving filters…' : 'Save these filters'}</Button>
        <Button variant="ghost" size="sm" disabled={saving} onClick={() => setComparison(null)}>Cancel filter change</Button>
      </Container> : null}
      {saveMessage ? <Text variant="body-xs" role="status">{saveMessage}</Text> : null}
      <Button variant="ghost" size="sm" disabled={saving} onClick={() => { setInspection(null); setComparison(null); setSaveMessage(null); }}>Close match details</Button>
    </Container> : null}
    {onRestore && archivedSets.length > 0 ? (
      <SavedItemsStrip title="Archived smart sets" saveLabel="" openVerb="Restore"
        items={archivedSets.map(set => ({ id: set.memberId, name: set.name }))}
        onOpen={onRestore} />
    ) : null}
    </Container>
  );
  if (!onFocus) return strip;
  return (
    <Container layout="vertical" gap="xs">
      <Container layout="horizontal" gap="xs" alignItems="center">
        <Text variant="label">On click</Text>
        <Button variant={focusing ? 'ghost' : 'secondary'} size="sm" aria-label="Clicking a smart set selects its cards" onClick={() => setMode('select')}>Select</Button>
        <Button variant={focusing ? 'secondary' : 'ghost'} size="sm" aria-label="Clicking a smart set focuses the board on its cards" onClick={() => setMode('focus')}>Focus</Button>
      </Container>
      {strip}
    </Container>
  );
}
