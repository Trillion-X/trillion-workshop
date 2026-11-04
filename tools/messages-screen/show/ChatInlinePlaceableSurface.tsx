// PORTED FROM: bitfield-packages/packages/chat/show/ChatInlinePlaceableSurface.tsx @ e99ac5976
// packages/chat/show/ChatInlinePlaceableSurface.tsx
//
// Chat-local host for a published placeable surface. Chat reads package entry
// bytes through its own declared input, then hands the bytes to the shared
// browser-local screen mount. It does not import or render owner package UI.

'use client';

import React from 'react';
import { useBitfieldData } from '#workspace-records';
import { Container, SourceBytesScreenMount, Text } from '../../ui';
import { type PlaceableSurfacePackageEntryReference, type PlaceableSurfacePayload } from '../../ui/show/placeable-surface-intent';

function packageEntryBytesAddressLabel(packageEntry: PlaceableSurfacePackageEntryReference): string {
  return `package::${packageEntry.packageName}::entry-bytes::${packageEntry.entryName}`;
}

export function ChatInlinePlaceableSurface({
  payload,
}: {
  payload: PlaceableSurfacePayload;
}) {
  const packageEntry = payload.packageEntry ?? null;
  if (!packageEntry) {
    return (
      <Container
        data-chat-placeable-surface="unavailable"
        layout="vertical"
        gap="xs"
        padding="md"
        className="my-3 min-w-0 rounded-[18px] border border-[var(--border-subtle)] bg-[var(--glass-bg-subtle)]"
      >
        <Text variant="heading" color="subtle">
          {payload.title ?? 'Result'}
        </Text>
        <Text variant="body-sm" color="faint">
          This result cannot be shown yet.
        </Text>
      </Container>
    );
  }

  return <ChatInlinePlaceableSurfaceBytes payload={payload} packageEntry={packageEntry} />;
}

function ChatInlinePlaceableSurfaceBytes({
  payload,
  packageEntry,
}: {
  payload: PlaceableSurfacePayload;
  packageEntry: PlaceableSurfacePackageEntryReference;
}) {
  const addressLabel = React.useMemo(
    () => packageEntryBytesAddressLabel(packageEntry),
    [packageEntry.entryName, packageEntry.packageName],
  );
  const sourceSelector = React.useMemo(
    () => ({
      input: 'package-entry-by-address-label',
      params: { addressLabel },
    }),
    [addressLabel],
  );
  const sourceBytes = useBitfieldData<Uint8Array>(sourceSelector);
  const mountProps = React.useMemo(
    () => ({
      floating_frame: { mode: 'inline' },
      target: payload.target ?? null,
      materialTarget: payload.materialTarget ?? null,
      surfaceInput: payload.surfaceInput ?? {},
    }),
    [payload.materialTarget, payload.surfaceInput, payload.target],
  );

  return (
    <Container
      data-chat-placeable-surface="mounted"
      layout="vertical"
      padding="none"
      className="my-3 min-h-[260px] min-w-0 overflow-hidden rounded-[18px] border border-[var(--border-subtle)] bg-[var(--surface)]"
    >
      <SourceBytesScreenMount
        sourceBytes={sourceBytes}
        sourceKey={addressLabel}
        mountProps={mountProps}
        className="relative min-h-[260px] w-full min-w-0 overflow-y-auto overscroll-contain"
        mountClassName="min-h-[260px] w-full"
        surfaceDataAttributes={{ chatPlaceableSurfaceViewport: 'true' }}
        dataAttributes={{
          packageName: packageEntry.packageName,
          packageEntryName: packageEntry.entryName,
          packageEntryAddressLabel: addressLabel,
          chatPlaceableSurfaceMount: 'true',
        }}
        unavailableText="This result cannot be shown yet."
        runtimeUnavailableText="This result cannot be shown right now."
      />
    </Container>
  );
}
