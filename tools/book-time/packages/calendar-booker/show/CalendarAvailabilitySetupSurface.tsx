// packages/calendar-booker/show/CalendarAvailabilitySetupSurface.tsx
//
// The owner availability-setup workbench: a THIN shell over the
// `availability-setup` projection. Identical discipline to CalendarBookerSurface
// — it reads the contract, asks the sole translation feed (L098) for an
// already-human `ViewDescriptor[]` tree, and renders it through the blind
// workbench. No setup-field hand-rolling, no `cleanLabel`, no humanization here.
// The "Publish availability" action dispatches by its opaque product action ref,
// which the generic resolver bridges to the `generate-availability-slots`
// descriptor via that descriptor's self-describing `product_action_refs`.

import * as React from 'react';
import contract from '@/packages/calendar-booker/things-to-store-and-run.json';
import {
  calendarBookerActionDescriptors,
  invokeCalendarBookerOwnerAction,
} from '@/packages/calendar-booker/do-work/calendar-booker-actions';
import {
  buildSchedulingOfferView,
  type AvailabilitySetupPresentationProfile,
  type SurfaceStatusInput,
} from '@/packages/calendar-booker/do-work/scheduling-offer-feed';
import { readCalendarBookerWorkGraph } from '@/packages/calendar-booker/read-data/read-calendar-booker-work-graph';
import { DescriptorWorkbench, type DescriptorWorkbenchPhase } from '@/packages/calendar-booker/show/descriptor-workbench';
import { calendarBookerRenderCapabilities } from '@/packages/calendar-booker/show/render-capability-map';

type AnyRecord = Record<string, unknown>;

const SETUP_PROJECTION_ID = 'calendar-booker.availability-setup';

export interface CalendarAvailabilitySetupSurfaceProps {
  /** Live availability policy/template records to edit. Defaults to none (L117). */
  records?: AnyRecord[];
  /** Optional readiness status to surface. */
  status?: SurfaceStatusInput;
  /** Setup fields are editable by default. */
  editable?: boolean;
  /** Render-state phase for the workbench chrome. */
  phase?: DescriptorWorkbenchPhase;
  /** An already-human notice (loading hint / error reason). */
  notice?: string;
  /** Audience selector supplied by a composing app. Defaults to operator copy. */
  audience?: string;
  /** Audience copy profile supplied as DATA by a composing app. */
  presentationProfile?: AvailabilitySetupPresentationProfile | null;
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

export function CalendarAvailabilitySetupSurface(
  props: CalendarAvailabilitySetupSurfaceProps = {},
): React.ReactElement {
  const payloads = React.useMemo(contractPayloads, []);
  const graph = React.useMemo(() => readCalendarBookerWorkGraph({ descriptors: payloads }), [payloads]);
  const descriptors = React.useMemo(() => calendarBookerActionDescriptors(payloads), [payloads]);

  const views = React.useMemo(
    () =>
      buildSchedulingOfferView({
        projection: projectionRecord(payloads, SETUP_PROJECTION_ID),
        graph,
        records: props.records ?? [],
        status: props.status,
        editable: props.editable ?? true,
        audience: props.audience,
        availabilitySetupPresentationProfile: props.presentationProfile,
      }),
    [payloads, graph, props.records, props.status, props.editable, props.audience, props.presentationProfile],
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
          // The product entry provides Runtime Kit boot hooks; isolated render
          // harnesses do not. Dispatch failures must not become visible truth.
        }
      }}
    />
  );
}

export default CalendarAvailabilitySetupSurface;
