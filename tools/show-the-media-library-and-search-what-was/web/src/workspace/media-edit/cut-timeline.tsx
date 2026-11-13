// src/workspace/media-edit/cut-timeline.tsx
//
// The editor's timeline: its actions (undo, split at the playhead, take out a marked stretch, move, remove) over the
// shared track lanes (parts/media-composition EditTrackLanes): the picture track, the captions and text track and the
// music track, one ruler and one playhead. Clicking the ruler moves the playhead; dragging a clip moves it; dragging
// the edges of the selected clip trims it.
//
// Invariants
//   1. The actions are DATA handed in (`actions`); this file draws them and names none. Each is its icon, with its
//      name in the shared tooltip on hover and focus (its title) and as its accessible name; actions sharing a
//      `group` sit together, a thin rule between groups, in one row that scrolls sideways in a narrow pane.
//   2. Times: the lanes and the playhead are cut time; trims report seconds inside the clip's own file.
//   3. Composed only from shared parts (Container, Text, Button, EditTrackLanes).

import React from 'react';
import { Button, Container, NamedIcon, Text } from '../../../parts/ui';
import { EditTrackLanes } from '../../../parts/media-composition/show/components/EditTrackLanes';
import type { MaterializedComposition } from '../../../parts/media-composition/read-data/compose-timeline';

export type TimelineAction = { id: string; label: string; icon: string; group: string; run: () => void; disabled?: boolean; emphasis?: boolean };

/** The actions in their groups, in the order each group first appears. */
const groupsOf = (actions: TimelineAction[]) => [...new Set(actions.map(action => action.group))].map(group => actions.filter(action => action.group === group));

type Props = {
  composition: MaterializedComposition;
  playhead: number;
  selectedClipId: string | null;
  actions: TimelineAction[];
  /** A stretch marked for taking out, in cut time, shown under the actions. */
  marked: { start: number | null; end: number | null };
  onSeek: (seconds: number) => void;
  onSelect: (clipId: string) => void;
  onTrim: (clipId: string, inPoint: number, outPoint: number) => void;
  onMove: (clipId: string, laneStart: number) => void;
  children?: React.ReactNode;
};

export const clock = (seconds: number) => {
  const tenths = Math.round(Math.max(0, seconds) * 10);
  const whole = Math.floor(tenths / 10);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}.${tenths % 10}`;
};

export function CutTimeline({ composition, playhead, selectedClipId, actions, marked, onSeek, onSelect, onTrim, onMove, children }: Props) {
  const duration = Math.max(composition.durationSeconds, 0.001);
  const markedText = marked.start === null && marked.end === null ? null
    : `Marked ${marked.start === null ? '…' : clock(marked.start)} to ${marked.end === null ? '…' : clock(marked.end)}`;
  return <Container as="section" aria-label="Timeline" data-media-edit-panel="timeline" layout="vertical" gap="sm" padding="md" border="all" rounded="lg" background="secondary" className="min-w-0 shrink-0">
    <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" className="min-w-0">
      <Container layout="horizontal" gap="xs" alignItems="center" role="toolbar" aria-label="Timeline actions" className="min-w-0 overflow-x-auto">
        {groupsOf(actions).map((group, index) => <Container key={group[0].group} layout="horizontal" gap="xs" alignItems="center" className={index ? 'shrink-0 border-l border-[var(--border-primary)] pl-1' : 'shrink-0'}>
          {group.map(action => <Button key={action.id} size="icon" variant={action.emphasis ? 'secondary' : 'ghost'} aria-label={action.label} title={action.label} data-timeline-action={action.id} disabled={action.disabled} onClick={action.run}><NamedIcon name={action.icon} size="sm" aria-hidden="true" /></Button>)}
        </Container>)}
      </Container>
      <Container layout="horizontal" gap="sm" alignItems="center" className="shrink-0">
        {markedText ? <Text variant="caption" color="secondary" role="status">{markedText}</Text> : null}
        <Text variant="caption" color="faint" className="tabular-nums">{clock(playhead)} / {clock(composition.durationSeconds)}</Text>
      </Container>
    </Container>
    <EditTrackLanes
      composition={composition}
      playheadPct={Math.max(0, Math.min(100, playhead / duration * 100))}
      playheadLabel={clock(playhead)}
      selectedClipId={selectedClipId}
      onSeek={onSeek}
      onSelectClip={onSelect}
      onTrim={onTrim}
      onMove={(clipId, laneStart) => onMove(clipId, laneStart)}
    />
    {children}
  </Container>;
}
