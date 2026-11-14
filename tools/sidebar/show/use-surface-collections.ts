// packages/sidebar/show/use-surface-collections.ts
//
// PURPOSE
//   The ONE reader of a person's lists and folders (surface collections). The
//   sidebar draws them; any other place that offers the same lists (the empty
//   pane in screen-arrangement) calls this same hook with the same source, so
//   the two can never disagree about which lists exist.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A source is DATA: a group.index scope, an optional partition, an optional
//      caller-projected graph, and whether durable user lists merge in. Absent
//      fields mean the main `sidebar` scope read through the group door.
//   2. A caller-projected graph without durable edits is final and never loads.
//   3. A projected graph WITH durable edits lays the person's saved copy of each
//      app list over it (their order, rows they took out, rows they added) and
//      appends their own lists (mergeSurfaceCollections).
//   4. A failed load is reported (`error`), never rendered as "no lists".
//   5. Each screen shows in one list only (showEachSurfaceOnce), from every source.
//   6. The lists follow the records live: when another writer changes the person's records (their AI through the
//      Worker's sidebar, another tab), the lists are read again quietly and redrawn only when they differ. This page's
//      own edits already read them again (refresh), so they do not ring this.
//   7. A projected graph the caller replaces (read-data/live-graph.ts) is followed: a list a rule fills redraws when
//      the rule's answer changes.

import * as React from 'react';
import { DEFAULT_SIDEBAR_SCOPE, readSurfaceCollections, type SurfaceCollection } from 'trillion-workshop/tools/organize-the-sidebar/read-data/read-surface-collections.ts';
import { mergeSurfaceCollections, showEachSurfaceOnce, surfaceCollectionIds } from 'trillion-workshop/tools/organize-the-sidebar/read-data/merge-surface-collections.ts';
import { loadSurfaceCollectionsGraph } from '../do-work/edit-surface-collections';
import { useProjectedGraph } from '../read-data/live-graph';
import { subscribeSavedChanges } from '#workspace-records';
import { listRules } from '#workspace-list-rules';
import { applyDecidedRules, ruleListsOf, undecidedRules, type DecidedListRules } from 'trillion-workshop/tools/organize-the-sidebar/read-data/apply-list-rules.ts';

import { errorWords } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';
// The longest a browser timer can wait (about 24.8 days); a later moment is waited for in steps.
const LONGEST_WAIT_MS = 2_147_483_647;

export interface SurfaceCollectionsSource {
  /** group.index scope; default `sidebar`. */
  scope?: string;
  /** Enclosing app partition used only by the direct-record compatibility read. */
  partitionLabel?: string;
  /** Caller-projected graph in the group.collection shape. */
  graph?: unknown;
  /** Merge the person's durable lists into a projected graph. */
  persistEdits?: boolean;
}

export interface SurfaceCollectionsState {
  /** What the sidebar draws: projected, durable, or both merged. */
  collections: SurfaceCollection[];
  /** The person's saved lists alone (what list editing and view cycling read). */
  durableCollections: SurfaceCollection[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * The partition a surface catalog address names (`<partition>::<list>`), which
 * is the partition its lists are read from. One rule for every reader.
 */
export function partitionLabelForSurfaceList(addressLabel: string | null | undefined): string | undefined {
  return addressLabel && addressLabel.includes('::') ? addressLabel.split('::', 1)[0] : undefined;
}

export function useSurfaceCollections({
  scope = DEFAULT_SIDEBAR_SCOPE,
  partitionLabel,
  graph: firstGraph,
  persistEdits = false,
}: SurfaceCollectionsSource = {}): SurfaceCollectionsState {
  // The caller may replace its projected graph while the page is open (lists a rule fills, read-data/live-graph.ts).
  const graph = useProjectedGraph(firstGraph);
  const projected = React.useMemo(() => readSurfaceCollections(graph), [graph]);
  // The app's list ids, read beside the index so the person's saved copy of each is found.
  const listKey = persistEdits ? surfaceCollectionIds(projected).join('\n') : '';
  const listIds = React.useMemo(() => (listKey ? listKey.split('\n') : []), [listKey]);
  const loads = graph === undefined || persistEdits;
  const [durableCollections, setDurableCollections] = React.useState<SurfaceCollection[]>([]);
  const [loading, setLoading] = React.useState(loads);
  const [error, setError] = React.useState<string | null>(null);
  const generation = React.useRef(0);
  // The saved lists last drawn, as read, so a records change that leaves them as they are redraws nothing.
  const drawn = React.useRef('');

  const refresh = React.useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    try {
      const reply = await loadSurfaceCollectionsGraph(scope, partitionLabel, listIds);
      if (current !== generation.current) return;
      drawn.current = JSON.stringify(reply);
      setDurableCollections(readSurfaceCollections(reply));
      setError(null);
    } catch (cause) {
      if (current !== generation.current) return;
      setError(errorWords(cause));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [listIds, partitionLabel, scope]);

  React.useEffect(() => {
    if (loads) void refresh();
    else setLoading(false);
    return () => { generation.current += 1; };
  }, [loads, refresh]);

  // Invariant 6: a change from elsewhere is read once per frame, however many records it changed.
  React.useEffect(() => {
    if (!loads) return undefined;
    let waiting = false;
    let stopped = false;
    const follow = () => {
      if (waiting) return;
      waiting = true;
      requestAnimationFrame(() => {
        waiting = false;
        void loadSurfaceCollectionsGraph(scope, partitionLabel, listIds).then((reply) => {
          const key = JSON.stringify(reply);
          if (stopped || key === drawn.current) return;
          drawn.current = key;
          setDurableCollections(readSurfaceCollections(reply));
          setError(null);
        }, () => {});
      });
    };
    const stop = subscribeSavedChanges(follow);
    return () => { stopped = true; stop(); };
  }, [listIds, loads, partitionLabel, scope]);

  // Each screen shows in one list only, whichever source the lists come from.
  const merged = React.useMemo(() => (
    graph === undefined
      ? showEachSurfaceOnce(durableCollections)
      : persistEdits
        ? mergeSurfaceCollections(projected, durableCollections)
        : showEachSurfaceOnce(projected)
  ), [durableCollections, graph, persistEdits, projected]);

  // The person's own lists and rows that hold or show by a rule (read-data/apply-list-rules.ts), decided by the formula
  // engine (#workspace-list-rules) now and again at the next moment one of their rules names, so a list or row comes
  // and goes by itself.
  const ruleLists = React.useMemo(() => ruleListsOf(merged), [merged]);
  const ruleKey = JSON.stringify(ruleLists);
  const [decided, setDecided] = React.useState<{ key: string; answer: DecidedListRules } | null>(null);
  React.useEffect(() => {
    if (!ruleLists.length) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const decide = () => {
      void listRules.decide(ruleLists, Date.now()).then((answer) => {
        if (stopped) return;
        setDecided({ key: ruleKey, answer });
        if (answer.next_change_at !== null) timer = setTimeout(decide, Math.min(Math.max(answer.next_change_at - Date.now(), 0) + 50, LONGEST_WAIT_MS));
      }, () => {});
    };
    decide();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
    // ruleKey stands for ruleLists: a new list object with the same rules decides nothing again.
  }, [ruleKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const collections = React.useMemo(() => (
    ruleLists.length
      ? applyDecidedRules(merged, decided?.key === ruleKey ? decided.answer : undecidedRules(ruleLists), listRules.rows())
      : merged
  ), [decided, merged, ruleKey, ruleLists]);

  // The person's own lists alone: their saved copies of the app's lists are laid over those lists above instead.
  const ownCollections = React.useMemo(() => {
    if (graph === undefined || !persistEdits) return durableCollections;
    const appIds = new Set(listIds);
    return durableCollections.filter((collection) => !appIds.has(collection.id));
  }, [durableCollections, graph, listIds, persistEdits]);

  return { collections, durableCollections: ownCollections, loading, error, refresh };
}
