// Addressed source adapter for the generic placeable-surface intent reader.
//
// The runtime owns decoding selected bytes through input-descriptor DATA. This
// component deliberately owns no address, record kind, producer, or destination
// vocabulary: a caller supplies a declared source and the existing reader owns
// validation, permits, routing, and duplicate suppression.

import * as React from 'react';
import { useBitfieldData } from '#workspace-records';

import {
  SurfaceIntentReader,
} from './surface-intent-reader';
import {
  normalizeAddressedSurfaceIntentRecords,
  readSurfaceIntentReaderConfig,
  type AddressedSurfaceIntentReaderProps,
  type SurfaceIntentReaderConfig,
} from './addressed-surface-intent-data';
export type { AddressedSurfaceIntentSource } from './placeable-surface-intent';
export { normalizeAddressedSurfaceIntentRecords, readSurfaceIntentReaderConfig };
export type { AddressedSurfaceIntentReaderProps, SurfaceIntentReaderConfig };

/**
 * Converts the shapes produced by generic current-item selectors into the
 * record stream consumed by SurfaceIntentReader. It never decodes bytes: the
 * `selector-source-by-address-label` input descriptor does that as DATA.
 */
export function AddressedSurfaceIntentReader({ source, ...props }: AddressedSurfaceIntentReaderProps): null {
  const value = useBitfieldData({
    input: 'selector-source-by-address-label',
    params: typeof source === 'object' ? source.params : undefined,
  });
  const records = React.useMemo(() => normalizeAddressedSurfaceIntentRecords(value), [value]);
  return <SurfaceIntentReader {...props} records={records} />;
}
