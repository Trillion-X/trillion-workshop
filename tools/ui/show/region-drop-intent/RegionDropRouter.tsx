// packages/ui/show/region-drop-intent/RegionDropRouter.tsx
//
// Generic drop-intent router for a region. Wraps a region's content; while a
// subject is dragged over it, it routes the drop to one of the owner-provided
// intents:
//
//   • the DEFAULT intent owns the whole region — a drop anywhere routes there,
//     so the common action keeps its zero-aim ease and zero visible chrome.
//   • every other accepted intent renders as a distinct zone (a card) on a
//     soft scrim; dropping on a zone routes to that intent.
//
// The router is BLIND to what any intent means. It iterates the pack, filters
// by `accepts` (types-only at hover), and calls `apply` on drop — declined
// applies fall back to the default. Adding an intent is a data row; this file
// never changes. Styling lives here (ui layer); feature code stays clean.

import * as React from 'react';
import { NamedIcon } from '../icon';
import {
  acceptedIntents,
  defaultIntent,
  type DropIntentCapability,
  type DropIntentPack,
  type RegionDrop,
} from './region-drop-intent-types';
import {
  RegionDropNestContext,
  createRegionDropNestStore,
  type RegionDropNestContextValue,
} from './region-drop-nest';
import type { AddressRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/visual-layer-types.ts';

export interface RegionDropRouterProps {
  /** The region the dropped subject targets (addressed). */
  readonly region: AddressRef;
  /** Owner-provided intents. Order is by priority, not array index. */
  readonly intents: DropIntentPack;
  /** The region content the router wraps. */
  readonly children: React.ReactNode;
  /** Extra class on the wrapper (it is `relative` and fills its parent). */
  readonly className?: string;
  /** Fill the available main-axis space when this region is a flex item. */
  readonly grow?: boolean;
  /** Let a child owner reserve part of the region for a more specific drop target. */
  readonly suppressOverlay?: (event: React.DragEvent) => boolean;
}

const ZONE_BASE =
  'pointer-events-auto flex flex-col items-center justify-center gap-2 rounded-2xl px-8 py-7 ' +
  'border-2 border-dashed text-center transition-colors duration-150 select-none min-w-[180px]';
const ZONE_IDLE = 'border-[var(--border-secondary)] bg-[var(--bg-elevated)]/70 text-[var(--text-secondary)]';
const ZONE_HOT = 'border-[var(--accent-primary)] bg-[var(--accent-primary)]/15 text-[var(--text-primary)]';

/**
 * Route a drop to an intent, falling back to the default when the intent
 * declines (returns false / throws). A drop is never silently lost.
 */
async function routeDrop(
  intent: DropIntentCapability,
  fallback: DropIntentCapability | null,
  drop: RegionDrop,
): Promise<void> {
  try {
    const consumed = await intent.apply(drop);
    if (consumed === false && fallback && fallback.id !== intent.id) {
      await fallback.apply(drop);
    }
  } catch {
    if (fallback && fallback.id !== intent.id) {
      try {
        await fallback.apply(drop);
      } catch {
        /* both declined — nothing to do */
      }
    }
  }
}

export function RegionDropRouter({ region, intents, children, className, grow, suppressOverlay }: RegionDropRouterProps): React.ReactElement {
  const [active, setActive] = React.useState<DropIntentCapability[]>([]);
  const [hoveredId, setHoveredId] = React.useState<string | null>(null);
  const depthRef = React.useRef(0);

  // Nest coordination: this router's depth = parent router's depth + 1 (or 0 when
  // outermost). All nested routers SHARE the outermost's store so they agree on the
  // deepest active region; only that innermost router paints its overlay.
  const parentNest = React.useContext(RegionDropNestContext);
  const localStore = React.useMemo(() => createRegionDropNestStore(), []);
  const nestStore = parentNest?.store ?? localStore;
  const depth = parentNest ? parentNest.depth + 1 : 0;
  const nestValue = React.useMemo<RegionDropNestContextValue>(
    () => ({ store: nestStore, depth }),
    [nestStore, depth],
  );
  const isActive = active.length > 0;
  // Claim before the browser paints. A passive effect let the OUTER router paint
  // its full-cover overlay for one frame over a deeper active region; the
  // browser then fired dragleave on the inner region's children, the inner
  // router reset, and the outer overlay swallowed every later drag event, so
  // the container's split zones never appeared and a drop only opened a tab.
  React.useLayoutEffect(() => {
    if (!isActive) return undefined;
    nestStore.claim(depth);
    return () => nestStore.release(depth);
  }, [isActive, nestStore, depth]);
  const maxActiveDepth = React.useSyncExternalStore(
    nestStore.subscribe,
    nestStore.maxActiveDepth,
    nestStore.maxActiveDepth,
  );
  // Paint the overlay only when no DEEPER router is active over the same drag.
  const isInnermost = !isActive || depth >= maxActiveDepth;

  const reset = React.useCallback(() => {
    depthRef.current = 0;
    setActive([]);
    setHoveredId(null);
  }, []);

  // A canceled HTML drag has no drop target, so neither this region's drop
  // handler nor its nested dragleave counter is guaranteed to run. The source
  // still emits dragend on the window. Clear every visual affordance when that
  // drag ends (and when the window loses focus) so a dashed zone can never be
  // left covering the screen after a failed or canceled drag.
  React.useEffect(() => {
    if (!isActive) return undefined;
    const finish = () => reset();
    window.addEventListener('dragend', finish, true);
    // Let the region's drop handler route the intent before clearing its overlay.
    window.addEventListener('drop', finish);
    window.addEventListener('blur', finish);
    return () => {
      window.removeEventListener('dragend', finish, true);
      window.removeEventListener('drop', finish);
      window.removeEventListener('blur', finish);
    };
  }, [isActive, reset]);

  const onDragEnterCapture = React.useCallback(
    (event: React.DragEvent) => {
      if (suppressOverlay?.(event)) {
        reset();
        return;
      }
      depthRef.current += 1;
      if (active.length > 0) return;
      const matched = acceptedIntents(intents, {
        region,
        dataTransfer: event.dataTransfer,
        clientX: event.clientX,
        clientY: event.clientY,
      });
      if (matched.length > 0) setActive(matched);
    },
    [active.length, intents, region, reset, suppressOverlay],
  );

  // An intent may accept only part of the region (a stage-only zone that must
  // never cover a pane), so acceptance is asked again as the drag moves: the
  // router lights up when the pointer reaches an accepting spot and steps
  // aside, overlay and all, the moment it leaves one.
  const onDragOverCapture = React.useCallback(
    (event: React.DragEvent) => {
      if (suppressOverlay?.(event)) {
        reset();
        return;
      }
      const matched = acceptedIntents(intents, {
        region,
        dataTransfer: event.dataTransfer,
        clientX: event.clientX,
        clientY: event.clientY,
      });
      if (matched.length === active.length && matched.every((intent, index) => intent.id === active[index].id)) return;
      setActive(matched);
      if (!matched.length) setHoveredId(null);
    },
    [active, intents, region, reset, suppressOverlay],
  );

  const onDragLeaveCapture = React.useCallback(() => {
    depthRef.current = Math.max(0, depthRef.current - 1);
    if (depthRef.current <= 0) reset();
  }, [reset]);

  const fallback = defaultIntent(active);
  const zones = active.filter((intent) => !intent.isDefault);

  const handleZoneDrop = (intent: DropIntentCapability) => (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const drop: RegionDrop = {
      region,
      dataTransfer: event.dataTransfer,
      clientX: event.clientX,
      clientY: event.clientY,
    };
    void routeDrop(intent, fallback, drop);
    reset();
  };

  const handleDefaultDrop = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!fallback) {
      reset();
      return;
    }
    void routeDrop(fallback, fallback, {
      region,
      dataTransfer: event.dataTransfer,
      clientX: event.clientX,
      clientY: event.clientY,
    });
    reset();
  };

  const allowDrop = (id: string | null) => (event: React.DragEvent) => {
    event.preventDefault();
    // The source decides which operations are legal. A tab permits only move;
    // advertising copy makes Chromium cancel the gesture without a drop event.
    const allowed = event.dataTransfer.effectAllowed;
    event.dataTransfer.dropEffect = allowed === 'move' || allowed === 'linkMove'
      ? 'move'
      : allowed === 'link' ? 'link' : 'copy';
    setHoveredId(id);
  };

  // ONE element shape whether or not a drag is over this region. Swapping to a
  // different wrapper when the drag arrived re-parented `children` (an array
  // became a nested array), which REMOUNTED every region inside this one in the
  // middle of the drag: the containers' own routers and split zones vanished
  // and the drop fell through to this region's default.
  return (
    <RegionDropNestContext.Provider value={nestValue}>
      <div
        className={`relative flex flex-col h-full w-full min-h-0 min-w-0${grow ? ' flex-1' : ''}${className ? ` ${className}` : ''}`}
        onDragEnterCapture={onDragEnterCapture}
        onDragLeaveCapture={onDragLeaveCapture}
        onDragOverCapture={onDragOverCapture}
        data-region-drop-active={isActive ? '' : undefined}
      >
        {children}
        {/* Only the INNERMOST active region paints its overlay; an outer router whose
            drag is currently over a deeper router stays silent (no double cards) and
            lets the deeper router own the drop. */}
        {isActive && isInnermost ? (
          <div className="absolute inset-0 z-[60]">
            {/* Default intent owns the whole region: a drop anywhere routes to it. */}
            <div
              className="absolute inset-0 pointer-events-auto"
              onDragOver={allowDrop(null)}
              onDrop={handleDefaultDrop}
            />
            {/* The dimmed layer holding the zones lets a drop outside every zone through to the default below it;
                only the zones themselves catch the pointer. */}
            {zones.length > 0 ? (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-4 bg-[var(--bg-base)]/45 backdrop-blur-[2px]">
                <div className="flex flex-row flex-wrap items-stretch justify-center gap-4">
                  {zones.map((intent) => {
                    const hot = hoveredId === intent.id;
                    return (
                      <div
                        key={intent.id}
                        className={`${ZONE_BASE} ${hot ? ZONE_HOT : ZONE_IDLE}`}
                        onDragOver={allowDrop(intent.id)}
                        onDragEnter={allowDrop(intent.id)}
                        onDrop={handleZoneDrop(intent)}
                      >
                        {intent.icon ? <NamedIcon name={intent.icon} size="lg" /> : null}
                        <span className="text-sm font-medium">{intent.label}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </RegionDropNestContext.Provider>
  );
}
