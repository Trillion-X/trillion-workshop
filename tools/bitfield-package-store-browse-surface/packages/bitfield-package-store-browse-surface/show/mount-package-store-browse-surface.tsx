import React from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { ErrorBoundary } from '@/packages/ui/show/error-boundary';
import { FloatingMaterialFrame } from '@/packages/ui/show/floating-material-frame';
import { mountReactSurface } from '@/packages/ui/show/react-surface-mount';
import { BitfieldPackageStoreBrowseSurface } from './BitfieldPackageStoreBrowseSurface';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function publicPageFrame(frame: unknown): Record<string, unknown> {
  return frame && typeof frame === 'object' && !Array.isArray(frame)
    ? { mode: 'inline', ...frame as Record<string, unknown> }
    : { mode: 'inline' };
}

function PackageStoreBrowseMaterial({ props }: { props: Record<string, unknown> }) {
  const actionCapabilities = useBitfieldData('action-capabilities');
  const browseConfig = useBitfieldData('browse-config');
  const catalog = useBitfieldData('catalog');

  return (
    <FloatingMaterialFrame frame={publicPageFrame(props.floating_frame)}>
      <ErrorBoundary zoneName="bitfield-package-store browse material">
        <BitfieldPackageStoreBrowseSurface
          actionCapabilities={actionCapabilities}
          browseConfig={browseConfig}
          catalog={catalog}
        />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <PackageStoreBrowseMaterial props={props} />);
}
