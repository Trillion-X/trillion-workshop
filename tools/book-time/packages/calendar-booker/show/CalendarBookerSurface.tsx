// packages/calendar-booker/show/CalendarBookerSurface.tsx
//
// The owner follow-up workbench: a THIN shell. It reads the package's own
// descriptor contract, asks the sole translation feed (L098) for an
// already-human `ViewDescriptor[]` tree for the `owner-follow-up` projection,
// and renders it through the blind workbench. It holds NO product vocabulary,
// builds NO developer-dump, and humanizes NOTHING — every visible word comes
// from the feed. Owner actions dispatch by their opaque `action_ref` through the
// generic workflow-owner resolver; this file names no action and no field.

import * as React from 'react';
import contract from '@/packages/calendar-booker/things-to-store-and-run.json';
import {
  calendarBookerActionDescriptors,
  invokeCalendarBookerOwnerAction,
} from '@/packages/calendar-booker/do-work/calendar-booker-actions';
import {
  buildSchedulingOfferView,
  type SurfaceStatusInput,
} from '@/packages/calendar-booker/do-work/scheduling-offer-feed';
import { readCalendarBookerWorkGraph } from '@/packages/calendar-booker/read-data/read-calendar-booker-work-graph';
import { DescriptorWorkbench, type DescriptorWorkbenchPhase } from '@/packages/calendar-booker/show/descriptor-workbench';
import { calendarBookerRenderCapabilities } from '@/packages/calendar-booker/show/render-capability-map';

type AnyRecord = Record<string, unknown>;

const OWNER_PROJECTION_ID = 'calendar-booker.booking-links.owner-follow-up';

export interface CalendarBookerSurfaceProps {
  /** Live bookings to display. Defaults to none — an honest empty state (L117). */
  records?: AnyRecord[];
  /** Optional owner status to surface (booking/readiness state key). */
  status?: SurfaceStatusInput;
  /** Owner fields are editable by default; guest/read-only callers pass false. */
  editable?: boolean;
  /** Render-state phase for the workbench chrome. */
  phase?: DescriptorWorkbenchPhase;
  /** An already-human notice (loading hint / error reason). */
  notice?: string;
}

function contractPayloads(): AnyRecord[] {
  return contract.things
    .map((thing) => thing.payload)
    .filter((payload): payload is AnyRecord => !!payload && typeof payload === 'object' && !Array.isArray(payload));
}

function projectionRecord(payloads: AnyRecord[], projectionId: string): AnyRecord {
  const found = payloads.find(
    (row) => row.kind === 'projection-descriptor' && row.projection_id === projectionId,
  );
  if (!found) throw new Error(`missing projection-descriptor ${projectionId}`);
  return found;
}

export function CalendarBookerSurface(props: CalendarBookerSurfaceProps = {}): React.ReactElement {
  const payloads = React.useMemo(contractPayloads, []);
  const graph = React.useMemo(() => readCalendarBookerWorkGraph({ descriptors: payloads }), [payloads]);
  const descriptors = React.useMemo(() => calendarBookerActionDescriptors(payloads), [payloads]);

  const views = React.useMemo(
    () =>
      buildSchedulingOfferView({
        projection: projectionRecord(payloads, OWNER_PROJECTION_ID),
        graph,
        records: props.records ?? [],
        status: props.status,
        editable: props.editable ?? true,
      }),
    [payloads, graph, props.records, props.status, props.editable],
  );

  return (
    <DescriptorWorkbench
      views={views}
      caps={calendarBookerRenderCapabilities}
      phase={props.phase}
      notice={props.notice}
      onAction={(action) => {
        try {
          void invokeCalendarBookerOwnerAction({
            intentRef: action.action_ref,
            descriptors,
            input: {},
          }).catch(() => undefined);
        } catch {
          // The real product entry registers Runtime Kit boot hooks. Isolated
          // render harnesses do not, so dispatch failures stay non-visual.
        }
      }}
    />
  );
}

export default CalendarBookerSurface;
