// packages/public-scene-share/show/mount-share-surface.tsx
//
// The renderable entry for the Share surface — the mount the host instantiates
// when a tab/placeable-surface carries `package::public-scene-share::entry-bytes::share`.
// It reads the live partition + scene address + link origin from surfaceInput
// (DATA) and renders the live `ShareSurface`. Any surface opens this BY ADDRESS
// (a screen-arrangement "Share this view" action), never importing the package.

import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';
import { bitfieldGeneratedLiveReadScopeDescriptor } from '@/packages/public-scene-share/.bitfield-entry-scope/share/runtime-kit-react';
import { ShareSurface } from '@/packages/public-scene-share/show/share-surface';

type MountArgs = { el: HTMLElement; props?: Record<string, unknown> };

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function ShareMaterial({ props }: { props: Record<string, unknown> }) {
  // This fallback used to be the literal 'bitfield-studio'. Studio is RETIRED, and
  // this package is installed in four sets, three of which are not Studio, so a mount
  // that omitted the prop addressed a dead app's partition. Nothing in this package's
  // mount DATA passes `partition_label`, so that was the live path, not a defensive one.
  //
  // The generated descriptor is the right source: the generator stamps it with the
  // partition of the set this surface was BUILT into, so the surface names the app it
  // actually runs in. Same owner already adopted by crm, record-audio, and
  // visual-database. `readTrustedRuntimePartition` is not usable here, because the
  // runner hands a partition to targets only, never to a browser surface.
  const partitionLabel = asString(
    props.partition_label ?? props.partitionLabel,
    bitfieldGeneratedLiveReadScopeDescriptor.partitionLabel,
  );
  const sceneAddressLabel = typeof props.scene_address === 'string' ? props.scene_address : undefined;
  const publicShareOrigin = typeof props.public_share_origin === 'string' ? props.public_share_origin : undefined;
  // Precise per-zone presentation chrome, opaque DATA from a programmatic opener
  // (no generic UI toggle — bare-document is the scope picker; see share-surface note).
  const frozenChrome = props.frozen_chrome;
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="public-scene-share material">
        <ShareSurface
          partitionLabel={partitionLabel}
          sceneAddressLabel={sceneAddressLabel}
          publicShareOrigin={publicShareOrigin}
          frozenChrome={frozenChrome}
        />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <ShareMaterial props={props} />);
}
