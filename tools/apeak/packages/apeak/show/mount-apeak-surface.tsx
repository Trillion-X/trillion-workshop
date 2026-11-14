import * as React from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface, Text, Container } from '@/packages/ui';
import { ApeakSurface } from './ApeakSurface';
import {
  applyOverlayMappings,
  normalizeSurfaceSource,
  readOverlayAddress,
  readOverlayMappings,
  readProjectionAddress,
  readSurfaceInput,
} from './apeak-surface-model';

const RECORD_BY_ADDRESS_INPUT = 'record-by-address';

function ApeakSurfaceReader({ surfaceInput }: { surfaceInput: unknown }): React.ReactElement {
  const projectionAddress = readProjectionAddress(surfaceInput);
  const overlayAddress = readOverlayAddress(surfaceInput);
  const overlayMappings = React.useMemo(() => readOverlayMappings(surfaceInput), [surfaceInput]);
  const projectionSelector = React.useMemo(
    () => (projectionAddress ? { input: RECORD_BY_ADDRESS_INPUT, params: { address: projectionAddress } } : 'record-projection'),
    [projectionAddress],
  );
  const overlaySelector = React.useMemo(
    () => (overlayAddress ? { input: RECORD_BY_ADDRESS_INPUT, params: { address: overlayAddress } } : 'record-projection'),
    [overlayAddress],
  );
  const projectionRaw = useBitfieldData(projectionSelector);
  const overlayRaw = useBitfieldData(overlaySelector);
  const baseSource = projectionAddress ? projectionRaw : surfaceInput;
  const merged = React.useMemo(
    () => applyOverlayMappings(baseSource, overlayRaw, overlayMappings),
    [baseSource, overlayMappings, overlayRaw],
  );
  const source = React.useMemo(() => normalizeSurfaceSource(merged), [merged]);

  if (!source) {
    return (
      <Container layout="vertical" justifyContent="center" alignItems="center" padding="lg" minHeight="320px">
        <Text variant="body-sm" color="muted">Loading Apeak…</Text>
      </Container>
    );
  }

  return <ApeakSurface source={source} />;
}

export default function mount({ el, props = {} }: { el: HTMLElement; props?: Record<string, unknown> }) {
  const surfaceInput = readSurfaceInput(props);
  return mountReactSurface(
    el,
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="apeak surface">
        <ApeakSurfaceReader surfaceInput={surfaceInput} />
      </ErrorBoundary>
    </FloatingMaterialFrame>,
  );
}
