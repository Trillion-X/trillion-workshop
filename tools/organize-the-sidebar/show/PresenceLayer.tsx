// packages/group/show/PresenceLayer.tsx
//
// The multiplayer overlay: every other participant's live cursor, name tag, and a coloured
// ring around whatever they have selected — the "other people are on this board" signal.
// Read-only and pointer-transparent (never steals a click), positioned in the same world
// coordinates as the board items so a cursor lands where the peer points.
//
// Each participant's colour comes from colorForParticipant (a stable hash of the peer id),
// so the same person is the same colour everywhere with no configuration.

import React from 'react';
import { LiveSurfacePeopleOverlay, type LiveSurfaceBounds, type LiveSurfacePersonView } from '../../ui/show/live-surface-people';
import { colorForParticipant, type Participant } from '../read-data/presence.ts';

export interface ItemRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface PresenceLayerProps {
  readonly participants: readonly Participant[];
  readonly itemRects?: Readonly<Record<string, ItemRect>>;
}

export function PresenceLayer({ participants, itemRects }: PresenceLayerProps): JSX.Element {
  const people = React.useMemo<readonly LiveSurfacePersonView[]>(
    () => participants.map((participant) => ({
      key: participant.id,
      label: participant.name,
      color: colorForParticipant(participant.id),
      point: participant.cursor,
      selectedRefs: participant.selection,
    })),
    [participants],
  );
  const bounds = React.useCallback(
    (reference: string): LiveSurfaceBounds | undefined => {
      const rect = itemRects?.[reference];
      return rect
        ? { x: rect.x, y: rect.y, width: rect.w, height: rect.h }
        : undefined;
    },
    [itemRects],
  );
  return <LiveSurfacePeopleOverlay people={people} bounds={bounds} />;
}
