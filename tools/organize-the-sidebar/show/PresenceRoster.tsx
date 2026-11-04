// packages/group/show/PresenceRoster.tsx
//
// R16 surface: the "who's on this board" facepile (Figma/Miro top-right avatars). Distinct
// from the live cursors — the roster answers "who is here", the cursors answer "where are
// they". Reuses the shared ui AvatarGroup (L093 — the overlap + "+N" overflow are already
// solved there); this only supplies each participant's colored-initials node. Colour is the
// deterministic per-person hash (colorForParticipant), consistent with their cursor colour.

import { LiveSurfacePeopleRoster } from '../../ui/show/live-surface-people';
import { colorForParticipant, type Participant } from '../read-data/presence';

export interface PresenceRosterProps {
  readonly participants: readonly Participant[];
}

export function PresenceRoster({ participants }: PresenceRosterProps): JSX.Element | null {
  const people = participants.map((participant) => ({
    key: participant.id,
    label: participant.name,
    color: colorForParticipant(participant.id),
  }));
  return (
    <LiveSurfacePeopleRoster
      people={people}
      label="People on this board"
    />
  );
}
