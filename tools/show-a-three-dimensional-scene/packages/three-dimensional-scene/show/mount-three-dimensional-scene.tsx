import * as React from 'react';
import { ErrorBoundary, mountReactSurface } from '../../../../ui';
import { buildSurfaceOutputDispatcher } from '../../../../ui/show/surface-output';
import type { AddressRef } from '../read-data/scene-descriptor';
import { ThreeDimensionalSceneSurface } from './ThreeDimensionalSceneSurface';

type MountProps = {
  descriptorSource?: unknown;
  surfaceInput?: unknown;
  resolveAddress: (ref: AddressRef, signal: AbortSignal) => Promise<ArrayBuffer>;
};
type MountArgs = { el: HTMLElement; props?: MountProps };

// A mounting owner supplies resolveAddress, as every layer below this one requires. This surface
// does not reach past the engine for bytes at a caller-supplied address, so an omitted resolver
// fails saying what was missing rather than quietly fetching.
function refuseUnresolvedAddress(ref: AddressRef): Promise<ArrayBuffer> {
  return Promise.reject(new Error(
    `cannot load ${ref.address}: this surface was mounted without a resolveAddress, and it does not fetch`,
  ));
}

export default function mount({ el, props = {} }: MountArgs) {
  const onOutput = buildSurfaceOutputDispatcher(el, props.surfaceInput);
  const resolveAddress = props.resolveAddress ?? refuseUnresolvedAddress;
  return mountReactSurface(el, <ErrorBoundary zoneName="3D Scene"><ThreeDimensionalSceneSurface descriptorSource={props.descriptorSource} surfaceInput={props.surfaceInput} resolveAddress={resolveAddress} onOutput={onOutput} /></ErrorBoundary>);
}
