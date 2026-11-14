// packages/media-composition/show/components/AddTracksControl.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Premiere-style "add tracks" affordance for the Edit-timeline surface: choose a
// count of VIDEO tracks and a count of AUDIO tracks, then Create. It calls back
// with the two counts, and the panel authors that many `add-track` edit-decision
// records (each a new empty lane as DATA). Collapsed to a single "Add tracks"
// chip until opened, so it never crowds the timeline.
//
// NON-NEGOTIABLE INVARIANTS
//   1. UI VIA SHARED PRIMITIVES ONLY (Container / Card / Button / Text). No raw
//      HTML, no className.
//   2. Names nothing about lane roles: it reports two counts and the panel owns
//      the role/label/tone policy (L098 translation boundary).
//
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';
import { Minus, Plus } from 'lucide-react';

import { Button } from '../../../ui/show/button';
import { Card } from '../../../ui/show/card';
import { Container } from '../../../ui/show/container';
import { Text } from '../../../ui/show/text';

export type AddTracksControlProps = {
  disabled?: boolean;
  /** Author `videoCount` new video lanes and `audioCount` new audio lanes. */
  onAddTracks: (videoCount: number, audioCount: number) => void;
};

const MAX_PER_KIND = 12;

/** A labelled +/- stepper (0..MAX_PER_KIND). Pure, no domain vocabulary. */
function Stepper({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  disabled?: boolean;
  onChange: (next: number) => void;
}) {
  const clamp = (n: number) => Math.max(0, Math.min(MAX_PER_KIND, n));
  return (
    <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
      <Text variant="body" weight="semibold">{label}</Text>
      <Container layout="horizontal" gap="sm" alignItems="center">
        <Button variant="ghost" size="icon" aria-label={`One fewer ${label}`} disabled={disabled || value <= 0} onClick={() => onChange(clamp(value - 1))}>
          <Minus size={14} />
        </Button>
        <Text variant="body" weight="semibold">{value}</Text>
        <Button variant="ghost" size="icon" aria-label={`One more ${label}`} disabled={disabled || value >= MAX_PER_KIND} onClick={() => onChange(clamp(value + 1))}>
          <Plus size={14} />
        </Button>
      </Container>
    </Container>
  );
}

export function AddTracksControl({ disabled, onAddTracks }: AddTracksControlProps) {
  const [open, setOpen] = React.useState(false);
  const [videoCount, setVideoCount] = React.useState(1);
  const [audioCount, setAudioCount] = React.useState(0);
  const total = videoCount + audioCount;

  if (!open) {
    return (
      <Container layout="horizontal" justifyContent="end">
        <Button variant="secondary" size="sm" disabled={disabled} onClick={() => setOpen(true)}>
          <Plus size={14} /> Add tracks
        </Button>
      </Container>
    );
  }

  return (
    <Card variant="nested" padding="sm" layout="stack">
      <Text variant="body" weight="semibold">Add tracks</Text>
      <Stepper label="Video tracks" value={videoCount} disabled={disabled} onChange={setVideoCount} />
      <Stepper label="Audio tracks" value={audioCount} disabled={disabled} onChange={setAudioCount} />
      <Container layout="horizontal" gap="sm" justifyContent="end" alignItems="center">
        <Button variant="ghost" size="sm" disabled={disabled} onClick={() => setOpen(false)}>Cancel</Button>
        <Button
          variant="primary"
          size="sm"
          disabled={disabled || total === 0}
          onClick={() => {
            onAddTracks(videoCount, audioCount);
            setOpen(false);
            setVideoCount(1);
            setAudioCount(0);
          }}
        >
          Create
        </Button>
      </Container>
    </Card>
  );
}
