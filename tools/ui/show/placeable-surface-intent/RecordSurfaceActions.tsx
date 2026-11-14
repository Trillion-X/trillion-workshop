// packages/ui/show/placeable-surface-intent/RecordSurfaceActions.tsx
//
// Display primitive for a produced record stream that carries surface-open
// intents. A record's disposition (open string) routes via caller DATA to one
// of the two mechanisms: "button" renders an OpenSurfaceAction the user
// clicks; "emit" is handled by SurfaceIntentReader. Generic: the producer
// (coach, operator, scheduler) and the routing are config, not named here.

import * as React from 'react';

import { Container } from '../container';
import { Text } from '../text';
import { OpenSurfaceAction } from '../open-surface-action/OpenSurfaceAction';
import {
  recordSurfaceIntentToOpenSurfaceProps,
  type SurfaceIntentAllowEntry,
  type SurfaceIntentPermit,
} from './record-surface-intent';
import {
  readSurfaceIntentDisposition,
  routeSurfaceIntentDisposition,
  SurfaceIntentReader,
  type SurfaceIntentDispositionRoutes,
  type SurfaceIntentRoute,
} from './surface-intent-reader';
import type { PlaceableSurfacePayload } from './placeable-surface-intent';

export interface RecordSurfaceActionsProps {
  readonly records: readonly unknown[];
  readonly intentPath: readonly string[];
  readonly allowList: readonly SurfaceIntentAllowEntry[];
  readonly permit?: SurfaceIntentPermit;
  readonly keyPath?: readonly string[];
  readonly dispositionRoutes?: SurfaceIntentDispositionRoutes;
  readonly defaultRoute?: SurfaceIntentRoute;
  readonly label?: string;
  readonly detail?: string;
  readonly emptyMessage?: string;
  readonly emit?: (payload: PlaceableSurfacePayload) => boolean;
}

/**
 * Renders the suggest buttons for a record stream and mounts the auto reader.
 * A suggest record with a permitted intent becomes a clickable OpenSurfaceAction;
 * auto records are emitted by SurfaceIntentReader (no button); off-allow-list and
 * intentless records render nothing. `emptyMessage` shows when there are no
 * suggest buttons (honest empty).
 */
export function RecordSurfaceActions({
  records,
  intentPath,
  allowList,
  permit,
  keyPath,
  dispositionRoutes,
  defaultRoute,
  label,
  detail,
  emptyMessage,
  emit,
}: RecordSurfaceActionsProps): React.JSX.Element {
  const suggestProps = records
    .filter((record) => routeSurfaceIntentDisposition(
      readSurfaceIntentDisposition(record, intentPath), dispositionRoutes, defaultRoute,
    ) === 'button')
    .map((record) => recordSurfaceIntentToOpenSurfaceProps(record, { intentPath, allowList, permit, label, detail }))
    .filter((props): props is NonNullable<typeof props> => props !== null);

  return (
    <Container layout="vertical" gap="sm">
      <SurfaceIntentReader
        records={records}
        intentPath={intentPath}
        allowList={allowList}
        permit={permit}
        keyPath={keyPath}
        dispositionRoutes={dispositionRoutes}
        defaultRoute={defaultRoute}
        emit={emit}
      />
      {suggestProps.length === 0 && emptyMessage ? (
        <Text variant="body" color="muted">
          {emptyMessage}
        </Text>
      ) : null}
      {suggestProps.map((props, index) => (
        <OpenSurfaceAction key={props.payload.id ?? `surface-action-${index}`} {...props} />
      ))}
    </Container>
  );
}
