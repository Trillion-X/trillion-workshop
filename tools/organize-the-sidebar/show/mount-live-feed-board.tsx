// packages/group/show/mount-live-feed-board.tsx
//
// THE generic LIVE-FEED BOARD mount — the L069 primitive "a group board whose
// membership continuously MIRRORS a record feed" (agents, tasks, deals, students).
// It composes the shipped pure pipeline against a live feed + a shared store:
//   useBitfieldData(feed_input) -> the record feed
//   reconcileFeedIntoStore(store, records, boardRoot, projection)  (in an effect)
//   GroupBoardPanel with makeStore -> the SAME store, so the canvas shows the
//   reconciled live-mount cards (drag/cluster/kanban are the panel's own primitives).
//
// NAMES NO PRODUCT (L090/L106): the feed selector, the card surface, the id/cluster
// fields all arrive as DATA props (`feed_input` + `projection`). The agent board,
// a task board, a deal pipeline are the SAME mount with a different DATA config —
// zero code per family. A product package supplies only a `placeable-surface`
// record pointing here with its props (mount-group-board.tsx: "a product package
// supplies its own mount that names itself, wires its producer").
//
// SSOT: the feed records are the truth; the board stores only pointers +
// arrangement. Churn (a record appears/leaves) re-reconciles; a dragged card keeps
// its position (the merge omits x/y); a removed record's card is tombstoned.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { bitfieldGeneratedLiveReadScopeDescriptor } from '@/packages/group/.bitfield-entry-scope/live-feed-board/runtime-kit-react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { readPublishedRecords } from '@/packages/ui/show/placeable-surface-intent';
import { GroupBoardPanel } from './GroupBoardPanel.tsx';
import { boardRootRef } from '../read-data/group-board-model.ts';
import { createGroupBoardStore } from '../read-data/read-group-board.ts';
import { reconcileFeedIntoStore } from '../do-work/reconcile-feed-into-store.ts';
import type { FeedBoardProjectionConfig } from '../read-data/feed-board-projection.ts';

type MountArgs = { el: HTMLElement; props?: Record<string, unknown> };

export function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

// Same full-pane fill logic vision-board uses: give the canvas a definite height
// unless an explicit fixed/floating placement is supplied.
export function fillFrame(input: unknown): Record<string, unknown> {
  const frame = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const placed = frame.mode === 'fixed' || typeof frame.top_px === 'number' || typeof frame.left_px === 'number';
  return placed ? frame : { ...frame, mode: 'fill' };
}

/**
 * Validate the DATA `projection` prop into a `FeedBoardProjectionConfig`. Returns
 * null (→ the board renders as a plain manual board, no reconcile) when the config
 * is missing its required fields — fail-soft, never throws, never a broken board.
 */
export function readLiveFeedProjection(value: unknown): FeedBoardProjectionConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const surface = v.cardSurface as Record<string, unknown> | undefined;
  if (!surface || typeof surface.packageName !== 'string' || typeof surface.entryName !== 'string') return null;
  if (typeof v.idField !== 'string' || typeof v.surfaceInputKey !== 'string') return null;
  return v as unknown as FeedBoardProjectionConfig;
}

/** Merge the record's `surfaceInput` (the definitively-populated props path via
 *  PlaceableSurfaceHost — `{floating_frame, surfaceInput, ...}`) OVER any top-level
 *  props (the full-tab open path also spreads the record payload). `surfaceInput`
 *  wins so a record that carries its config there always reaches the mount. */
export function readBoardConfig(props: Record<string, unknown>): Record<string, unknown> {
  const si = props.surfaceInput;
  return si && typeof si === 'object' && !Array.isArray(si) ? { ...props, ...(si as Record<string, unknown>) } : props;
}

/**
 * FeedReconciler — Extract and conditionally mount the feed subscription + reconcile
 * effect. This component is ONLY mounted when projection is non-null (a reconcile board).
 * For manual boards (projection=null), this unmounted component = zero feed subscription.
 * This is the L126 fix: vision board / ideas (manual, projection=null) no longer
 * unconditionally subscribe to the 34.7MB published-records aggregate.
 */
function FeedReconciler({
  store,
  boardRoot,
  projection,
  feedInput,
  onMembershipChanged,
}: {
  store: ReturnType<typeof createGroupBoardStore>;
  boardRoot: ReturnType<typeof boardRootRef>;
  projection: FeedBoardProjectionConfig;
  feedInput: string;
  onMembershipChanged: () => void;
}): null {
  const raw = useBitfieldData(feedInput);
  const feedDelivered = raw !== null && raw !== undefined;
  const records = React.useMemo(() => readPublishedRecords(raw), [raw]);

  React.useEffect(() => {
    let cancelled = false;
    reconcileFeedIntoStore(store, records, boardRoot, projection, { authoritative: feedDelivered })
      .then((res) => {
        if (!cancelled && res.membershipChanged) onMembershipChanged();
      })
      .catch((err) => {
        console.warn('[live-feed-board] reconcile failed', err);
      });
    return () => {
      cancelled = true;
    };
  }, [store, records, boardRoot, projection, feedDelivered]);

  return null;
}

function LiveFeedBoardMaterial({ props }: { props: Record<string, unknown> }) {
  const cfg = React.useMemo(() => readBoardConfig(props), [props]);
  // This fallback used to be the literal 'bitfield-studio'. Studio is RETIRED, so any
  // mount that omitted the prop addressed a dead app's partition (same failure as
  // packages/sidebar/do-work/collection-view-preference.ts: a set name substituted for a
  // partition reads whichever app owns that name, silently). A mount that NAMES NO
  // PRODUCT must not name an app either. The generated descriptor carries the partition
  // of the set this surface was BUILT into, which is the app it is actually running in.
  const partitionLabel = asString(
    cfg.partition_label ?? cfg.partitionLabel,
    bitfieldGeneratedLiveReadScopeDescriptor.partitionLabel,
  );
  const boardId = asString(cfg.board_id ?? cfg.boardId, 'live-feed-board');
  // L126: default to group-owned-feed (scoped to "package::group::" records) instead of the 34.7MB
  // published-records aggregate. Manual boards (projection=null) don't mount FeedReconciler anyway,
  // so the default is only used for reconcile boards that don't set feed_input explicitly — and
  // all group members (agent, task, deal, etc.) are group-addressed. Safe migration from aggregate.
  const feedInput = asString(cfg.feed_input ?? cfg.feedInput, 'group-owned-feed');
  const projection = React.useMemo(() => readLiveFeedProjection(cfg.projection), [cfg.projection]);

  // The DRILLDOWN CONSOLE the board opens when a node is double-clicked, derived
  // from the projection's `drilldown` DATA. Default surface = the generic
  // screen-arrangement worker-console (a tabbed container); the tab list is DATA.
  // Absent/empty tabs → undefined → no console (nodes keep normal enter-embedded).
  const consoleDrilldown = React.useMemo(() => {
    const dd = projection?.drilldown;
    if (!dd || !Array.isArray(dd.tabs) || dd.tabs.length === 0) return undefined;
    const s = dd.surface;
    const surface = s && typeof s.packageName === 'string' && typeof s.entryName === 'string'
      ? { packageName: s.packageName, entryName: s.entryName }
      : { packageName: 'screen-arrangement', entryName: 'worker-console' };
    return { surface, tabs: dd.tabs as ReadonlyArray<Record<string, unknown>> };
  }, [projection]);

  const boardRoot = React.useMemo(() => boardRootRef(boardId), [boardId]);
  // ONE store instance, shared between the reconcile effect and the panel (makeStore).
  const store = React.useMemo(
    () => createGroupBoardStore(partitionLabel, boardRoot),
    [partitionLabel, boardRoot],
  );

  // The CAS namespace for any uploaded item bytes (product Society, not the blind
  // board's) — mirrors vision-board's convention, keyed to this board's partition.
  const bytesNamespace = React.useMemo(
    () => ({ partitionLabel, addressPrefix: 'package::group::item-bytes', pathLabels: ['group', 'item-bytes'] }),
    [partitionLabel],
  );

  // Bump ONLY on a MEMBERSHIP change (a worker added/removed) so the panel remounts
  // and re-loads the reconciled graph. A pure FIELD change (status/model/updated_at
  // on an existing worker) must NOT remount — every card LIVE-READS its own record
  // and self-updates, so re-rendering the whole board would only throw away the
  // user's pan/zoom/selection and flash "Loading your board…". This is the fix for
  // the churn: the operator clock ticks constantly (changing agent fields), but
  // membership rarely changes, so the board stays put while the user interacts.
  const [reloadNonce, setReloadNonce] = React.useState(0);

  return (
    <FloatingMaterialFrame frame={fillFrame(props.floating_frame)}>
      <ErrorBoundary zoneName="live-feed-board material">
        {projection && (
          <FeedReconciler
            store={store}
            boardRoot={boardRoot}
            projection={projection}
            feedInput={feedInput}
            onMembershipChanged={() => setReloadNonce((n) => n + 1)}
          />
        )}
        <GroupBoardPanel
          partitionLabel={partitionLabel}
          boardId={boardId}
          title={asString(cfg.title, 'Board')}
          subtitle={asString(cfg.subtitle, '')}
          makeStore={() => store}
          bytesNamespace={bytesNamespace}
          reloadSignal={reloadNonce}
          consoleDrilldown={consoleDrilldown}
        />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <LiveFeedBoardMaterial props={props} />);
}
