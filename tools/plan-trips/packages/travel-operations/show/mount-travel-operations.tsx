import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';
import { useBitfieldData } from '@/packages/travel-operations/.bitfield-entry-scope/travel-operations/runtime-kit-react';
import { buildTravelOperationsModel } from '@/packages/travel-operations/read-data/travel-operations';
import { TravelOperationsPanel } from '@/packages/travel-operations/show/TravelOperationsPanel';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function TravelOperationsMaterial({ props }: { props: Record<string, unknown> }) {
  const itineraryRaw = useBitfieldData<unknown>('itinerary-state');
  const packingListRaw = useBitfieldData<unknown>('packing-list-state');
  const reservationRaw = useBitfieldData<unknown>('reservation-state');
  const evidenceRaw = useBitfieldData<unknown>('evidence-state');
  const model = buildTravelOperationsModel({ itineraryRaw, packingListRaw, reservationRaw, evidenceRaw });
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="Trip Board">
        <TravelOperationsPanel model={model} />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <TravelOperationsMaterial props={props} />);
}
