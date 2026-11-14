// packages/calendar/show/mount-calendar.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The mount boundary for the Calendar surface. The live path enumerates
// `time-block-lens` DATA rows and projects each lens's own input rows into
// normalized time blocks (read-data/read-calendar-lens-feeds.ts) — the surface
// never names an event source and gains new sources from lens DATA alone.
// The owner feed (`time-blocks` entry input) keeps supplying accounts, actions,
// range, and its own blocks; lens-projected blocks and lens read issues merge in.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. This file is the ONLY transport boundary for the calendar surface: the
//    injected sender is `sendRequestToBitfieldTarget`; renderers stay blind.
// 2. Fixtures are proof-harness-only (L117): the fixture branch requires an
//    explicit `proof_state` prop, which product surface_input never carries.
// 3. Honest states: lens read failure => warning issue, never a blank surface;
//    no lens rows + no owner blocks => the screen model's own empty states.

import React from 'react';
import { ErrorBoundary } from '@/packages/ui/show/error-boundary';
import { FloatingMaterialFrame } from '@/packages/ui/show/floating-material-frame';
import { mountReactSurface } from '@/packages/ui/show/react-surface-mount';
import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import {
  enumerateCalendarLenses,
  readCalendarLenses,
  type CalendarLensEnumerationResult,
  type CalendarRequestSender,
} from '../read-data/read-calendar-lens-feeds';
import {
  BUILTIN_VIEW_DESCRIPTORS,
  mergeViewDescriptors,
  readCalendarViewDescriptors,
  type CalendarViewDescriptor,
} from '../read-data/read-calendar-view-descriptors';
import { calendarFixtures } from './calendar-fixtures';
import { CalendarSurface } from './CalendarSurface';
import {
  createCalendarScreenModelFromLiveValue,
  type CalendarScreenModel,
  type CalendarSurfaceState,
} from './calendar-screen-model';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

type CalendarProofState = CalendarSurfaceState | 'mobile' | 'desktop';

function isProofState(value: unknown): value is CalendarProofState {
  return typeof value === 'string' && value in calendarFixtures;
}

const liveSender: CalendarRequestSender = (request) =>
  sendRequestToBitfieldTarget(request as Parameters<typeof sendRequestToBitfieldTarget>[0]);

/** Read lens DATA rows once per mount and re-enumerate their inputs whenever the
 *  owner feed value changes (the feed is the surface's change heartbeat). */
function useCalendarLensBlocks(
  liveValue: unknown,
  sender: CalendarRequestSender,
): CalendarLensEnumerationResult | null {
  const [result, setResult] = React.useState<CalendarLensEnumerationResult | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const lenses = await readCalendarLenses(sender);
        const enumeration = await enumerateCalendarLenses(lenses, sender);
        if (!cancelled) setResult(enumeration);
      } catch {
        // The lens list itself being unreadable is indistinguishable from an
        // engine that is still booting — the owner feed path still renders, so
        // the surface stays honest without a lens overlay.
        if (!cancelled) setResult(null);
      }
    })();
    return () => { cancelled = true; };
  }, [liveValue, sender]);

  return result;
}

/** Read the live `calendar-view-descriptor` DATA rows once per mount and union
 *  them over the shipped builtins. The builtins guarantee the picker + grid
 *  paint on the first frame (a view-less calendar cannot render); any user-added
 *  view row appears as soon as it loads. */
function useCalendarViewDescriptors(
  proof: boolean,
  sender: CalendarRequestSender,
): CalendarViewDescriptor[] {
  const [live, setLive] = React.useState<CalendarViewDescriptor[]>([]);

  React.useEffect(() => {
    if (proof) return;
    let cancelled = false;
    (async () => {
      try {
        const rows = await readCalendarViewDescriptors(sender);
        if (!cancelled) setLive(rows);
      } catch {
        if (!cancelled) setLive([]);
      }
    })();
    return () => { cancelled = true; };
  }, [proof, sender]);

  return React.useMemo(() => mergeViewDescriptors(BUILTIN_VIEW_DESCRIPTORS, live), [live]);
}

function mergeLensResult(
  base: CalendarScreenModel,
  lensResult: CalendarLensEnumerationResult | null,
): CalendarScreenModel {
  if (!lensResult || (lensResult.blocks.length === 0 && lensResult.issues.length === 0)) return base;
  const seen = new Set(base.blocks.map((block) => block.id));
  const merged = createCalendarScreenModelFromLiveValue({
    ...base,
    blocks: [...base.blocks, ...lensResult.blocks.filter((block) => !seen.has(block.id))],
    issues: [
      ...base.issues,
      ...lensResult.issues.map((issue) => ({ id: issue.id, tone: issue.tone, label: issue.label, detail: issue.detail })),
    ],
  });
  return merged;
}

function CalendarPanel({ props }: { props: Record<string, unknown> }) {
  const liveValue = useBitfieldData('time-blocks');
  const proofState = props.proof_state ?? props.proofState;
  const proof = isProofState(proofState);
  const lensResult = useCalendarLensBlocks(proof ? null : liveValue, liveSender);
  const viewDescriptors = useCalendarViewDescriptors(proof, liveSender);

  const model = React.useMemo(() => {
    if (proof) {
      return calendarFixtures[proofState as CalendarProofState];
    }

    // Create base model immediately from liveValue — never wait for lens enumeration.
    // This ensures chrome and time grid are visible within 100ms, even if lenses are
    // still loading. Lens blocks merge in progressively as they arrive. View
    // descriptors (the DATA-driven view set) are threaded in the same frame so the
    // picker shows the shipped views instantly and any live view rows on arrival.
    const baseModel = createCalendarScreenModelFromLiveValue(liveValue, undefined, viewDescriptors);
    return mergeLensResult(baseModel, lensResult);
  }, [liveValue, lensResult, viewDescriptors, proof, proofState]);

  return <CalendarSurface initialModel={model} />;
}

function CalendarMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="calendar material">
        <CalendarPanel props={props} />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <CalendarMaterial props={props} />);
}
