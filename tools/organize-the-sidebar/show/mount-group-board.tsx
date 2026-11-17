// packages/group/show/mount-group-board.tsx
//
// GENERIC mount entry for a Group Board surface. This is the PRIMITIVE's mount: it opens
// a board by id with no product identity — no product name, no producer, no cadence
// default. A PRODUCT package supplies its own mount that names itself, wires its producer,
// and sets its cadence by composing GroupBoardPanel directly.
// The group package names no product (L106 — independently inventable).
//
// (The shell passes only fixed mount props, so per-instance config that a product needs
// originates in the product's OWN mount, not here. This generic mount serves a plain
// board by id; products own their identity.)

import React from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { bitfieldGeneratedLiveReadScopeDescriptor } from '@/packages/group/.bitfield-entry-scope/group-board/runtime-kit-react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '../../ui';
import { GroupBoardPanel } from './GroupBoardPanel.tsx';
import type { ProducerSubmitDescriptor } from '../do-work/submit-producer-request.ts';
import { readSurfaceIntentReaderConfig } from '../../ui/show/placeable-surface-intent';
import { ViewerAccessRefsProvider } from '../../ui/show/placeable-surface-intent';

type MountArgs = { el: HTMLElement; props?: Record<string, unknown> };
type CadenceProp = { unit: 'day' | 'week' | 'month' | 'year'; keepActive?: number; landOnCurrent?: boolean };

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

/** Opt into a calendar cadence ONLY if explicitly provided as DATA — no product default. */
function cadenceFromProps(value: unknown): CadenceProp | undefined {
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (v.unit === 'day' || v.unit === 'week' || v.unit === 'month' || v.unit === 'year') {
      return {
        unit: v.unit,
        keepActive: typeof v.keepActive === 'number' ? v.keepActive : undefined,
        landOnCurrent: v.landOnCurrent === true,
      };
    }
  }
  return undefined;
}

/** A producer descriptor supplied as DATA (props) — else a default item is placedn item. */
function producerFromProps(value: unknown): ProducerSubmitDescriptor | undefined {
  if (value && typeof value === 'object' && typeof (value as { definitionId?: unknown }).definitionId === 'string') {
    return value as ProducerSubmitDescriptor;
  }
  return undefined;
}

/** Merge `surfaceInput` (the definitively-populated props path via PlaceableSurfaceHost —
 *  `{floating_frame, surfaceInput, ...}`) OVER top-level props, mirroring
 *  mount-live-feed-board's readBoardConfig. An embedded board node carries its
 *  board id inside surfaceInput; without this merge every embed fell back to 'board'. */
export function readMountProps(props: Record<string, unknown>): Record<string, unknown> {
  const si = props.surfaceInput;
  return si && typeof si === 'object' && !Array.isArray(si)
    ? { ...props, ...(si as Record<string, unknown>) }
    : props;
}

function GroupBoardMaterial({ props: rawProps }: { props: Record<string, unknown> }) {
  const props = readMountProps(rawProps);
  // This fallback used to be the literal 'bitfield-studio'. Studio is RETIRED, so any
  // mount that omitted the prop addressed a dead app's partition. That is the same
  // failure recorded in packages/sidebar/do-work/collection-view-preference.ts: a set
  // name substituted for a partition reads whichever app owns that name, silently.
  //
  // It matters most HERE, in the generic primitive: this mount names no product by
  // design (L106), so hardcoding one app's name was the one place the primitive did
  // name something. The generated descriptor carries the partition of the set this
  // surface was BUILT into, which is the app it is actually running in.
  const partitionLabel = asString(
    props.partition_label ?? props.partitionLabel,
    bitfieldGeneratedLiveReadScopeDescriptor.partitionLabel,
  );
  const boardId = asString(props.board_id ?? props.boardId, 'board');
  const surfaceIntentReader = readSurfaceIntentReaderConfig(props.surface_intent_reader);
  const surfaceIntentSource = surfaceIntentReader?.source;
  const surfaceIntentReaderValue = useBitfieldData({
    input: 'selector-source-by-address-label',
    params: typeof surfaceIntentSource === 'object' ? surfaceIntentSource.params : undefined,
  });
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="group-board material">
        <ViewerAccessRefsProvider>
          <GroupBoardPanel
            partitionLabel={partitionLabel}
            boardId={boardId}
            title={asString(props.title, 'Board')}
            subtitle={asString(props.subtitle, '')}
            producer={producerFromProps(props.producer)}
            cadence={cadenceFromProps(props.cadence)}
            surfaceIntentReader={surfaceIntentReader}
            surfaceIntentReaderValue={surfaceIntentReaderValue}
            surfaceIntentDestinationRef={typeof props.surface_intent_destination_ref === 'string' ? props.surface_intent_destination_ref : undefined}
          />
        </ViewerAccessRefsProvider>
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <GroupBoardMaterial props={props} />);
}
