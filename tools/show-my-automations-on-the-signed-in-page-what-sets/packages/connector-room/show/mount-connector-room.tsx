import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';
import { EmbeddedScreenArrangement } from '@/packages/screen-arrangement/show/EmbeddedScreenArrangement';
import { ConnectorRoomPanel } from '@/packages/connector-room/show/ConnectorRoomPanel';
import {
  acceptsConnectionsWorkspaceLayoutState,
  CONNECTIONS_WORKSPACE_LAYOUT_STATE,
  CONNECTIONS_WORKSPACE_LAYOUT_STATE_ADDRESS_LABEL,
  CONNECTIONS_WORKSPACE_LAYOUT_STATE_INPUT,
  CONNECTIONS_WORKSPACE_PLACEABLE_SURFACE_LIST_ADDRESS_LABEL,
} from '@/packages/connector-room/read-data/read-connections-workspace-layout-state';

type MountArgs = { el: HTMLElement; props?: Record<string, unknown> };

type ConnectionsSurfacePart = 'workspace' | 'connected-workflows';

function readConnectionsSurfacePart(props: Record<string, unknown>): ConnectionsSurfacePart {
  const rawInput = props.surface_input ?? props.surfaceInput;
  if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    const rawSurface = (rawInput as { connections_surface?: unknown; connectionsSurface?: unknown }).connections_surface
      ?? (rawInput as { connectionsSurface?: unknown }).connectionsSurface;
    if (rawSurface === 'connected-workflows') return 'connected-workflows';
  }
  return 'workspace';
}

function ConnectionsWorkspaceMaterial() {
  return (
    <EmbeddedScreenArrangement
      initialState={CONNECTIONS_WORKSPACE_LAYOUT_STATE}
      layoutEntryInput={CONNECTIONS_WORKSPACE_LAYOUT_STATE_INPUT}
      placeableSurfaceListAddressLabel={CONNECTIONS_WORKSPACE_PLACEABLE_SURFACE_LIST_ADDRESS_LABEL}
      persistence={{ valueAddressLabel: CONNECTIONS_WORKSPACE_LAYOUT_STATE_ADDRESS_LABEL }}
      acceptPersistedState={acceptsConnectionsWorkspaceLayoutState}
      chrome={{ header: false, 'empty.actions.newTab': false }}
    />
  );
}

function ConnectorRoomMaterial({ props }: { props: Record<string, unknown> }) {
  const surfacePart = readConnectionsSurfacePart(props);
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="connector-room material">
        {surfacePart === 'connected-workflows' ? <ConnectorRoomPanel /> : <ConnectionsWorkspaceMaterial />}
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <ConnectorRoomMaterial props={props} />);
}
