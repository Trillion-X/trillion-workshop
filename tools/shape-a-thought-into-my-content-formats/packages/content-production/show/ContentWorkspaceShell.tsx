/**
 * file: packages/content-production/show/ContentWorkspaceShell.tsx
 *
 * PURPOSE: Root shell for the content production workspace (plan §13A U01).
 * A Fey-style header (logo mark + workspace title) over an
 * EmbeddedScreenArrangement that hosts every content surface (Library, Style,
 * Compose, Deliverables, Distribution, Connections, Settings) as tabs.
 * Surfaces register themselves as placeable-surface records; the shell hosts
 * whatever exists and renders empty containers for surfaces not yet published.
 * Every control in this shell is functional: tab switching, drag-arrange,
 * and layout persistence all run through the real screen-arrangement engine.
 * Search and account controls belong to the surfaces that serve them (U02+),
 * not to the blind host shell.
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. Zero imports from slot::workflow or slot::eeaf — reads only via useBitfieldData
 * 2. Components imported only from @/packages/ui (the firewall); zero inline style objects
 * 3. Surfaces hosted via EmbeddedScreenArrangement — the shell never renders a surface itself
 * 4. The shell never names surface internals — tabs resolve placeable-surface records by id
 * 5. Observability: logs `[ui:content-workspace] mounted input=<n> records` on mount
 */

import * as React from 'react';

import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { Clapperboard } from 'lucide-react';

import { Container, Icon, Text } from '@/packages/ui';
import { EmbeddedScreenArrangement } from '@/packages/screen-arrangement/show/EmbeddedScreenArrangement';

import {
  acceptsContentWorkspaceLayoutState,
  CONTENT_WORKSPACE_LAYOUT_STATE,
  CONTENT_WORKSPACE_LAYOUT_STATE_ADDRESS_LABEL,
  CONTENT_WORKSPACE_LAYOUT_STATE_INPUT,
  discoverPlaceableSurfaces,
} from '@/packages/content-production/read-data/read-content-workspace-state';

function ContentWorkspaceHeader() {
  return (
    <Container layout="horizontal" gap="md" padding="md" alignItems="center" border="bottom">
      <Icon icon={Clapperboard} size="lg" />
      <Text variant="heading-lg">Content</Text>
    </Container>
  );
}

export function ContentWorkspaceShell() {
  // Discover registered surfaces (observability input count; the arranger does the hosting).
  const publishedRecords = useBitfieldData('published-records');

  React.useEffect(() => {
    const surfaceCount = discoverPlaceableSurfaces(publishedRecords).length;
    console.log(`[ui:content-workspace] mounted input=${surfaceCount} records`);
  }, [publishedRecords]);

  return (
    <Container layout="vertical" gap="none" height="full" overflow="hidden">
      <ContentWorkspaceHeader />
      <Container layout="vertical" gap="none" flex={1} overflow="hidden">
        <EmbeddedScreenArrangement
          initialState={CONTENT_WORKSPACE_LAYOUT_STATE}
          layoutEntryInput={CONTENT_WORKSPACE_LAYOUT_STATE_INPUT}
          placeableSurfaceListAddressLabel="placeable-surface-list::content-workspace"
          persistence={{ valueAddressLabel: CONTENT_WORKSPACE_LAYOUT_STATE_ADDRESS_LABEL }}
          acceptPersistedState={acceptsContentWorkspaceLayoutState}
          chrome={{ 'header.actions': false, 'header.new-tab': false }}
        />
      </Container>
    </Container>
  );
}
