// parts/ui/show/recording-bar/RecordingBar.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The one row a recording in progress draws, on every screen that records (the message box, Record, Record video):
// the time with a red dot, the live waveform (or the camera's picture) taking the room left, and the recording's
// actions at the end, small. Quiet actions (Pause, Discard) are icon buttons named by their tooltip; the one main
// action (Done, Stop) carries its word. Reference: Wispr Flow's recording pill (X, wave, check), Notion's meeting bar
// (wave, Pause, Stop chips) and Voice Memos' wave with its time; never a giant stop button with words beside it.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Presentational only: no MediaStream is opened, no recorder is held. The screen passes the stream, the time and
//    the actions; the bar knows no screen and no recording kind.
// 2. Actions are DATA ({ id, label, icon, main, onPress }): adding an action is one entry, never a branch here.
// 3. The time is read from the caller each time it is drawn (`readElapsedMs`, the capture control's ElapsedTime), so
//    it never falls behind and only the time redraws.
// 4. `compact` is the same bar without its waveform, for a pill over other work: one look for every recording bar.
// 5. It fits a 390px pane: the waveform shrinks, the time and the actions never wrap or leave the row.
// 6. `ground` is the look's own: the worn surface, or the island (a pill floating over other apps, dark in every look,
//    surfaces.css .glass-island). The bar names the ground; the look decides its colours.
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.

import * as React from 'react';

import { Button } from '../button';
import { ElapsedTime, formatElapsed } from '../capture-control/CaptureControl';
import { Container } from '../container';
import { NamedIcon } from '../icon/NamedIcon';
import { LiveWaveform } from '../live-waveform';
import { Text } from '../text';

export type RecordingBarAction = {
  /** Stable id for the action. */
  id: string;
  /** The action's word: the main action shows it, a quiet one carries it as its name and tooltip. */
  label: string;
  /** A Lucide icon name. */
  icon: string;
  /** The one action that finishes the recording (Done, Stop): drawn with its word. */
  main?: boolean;
  onPress: () => void;
  disabled?: boolean;
};

export interface RecordingBarProps {
  /** The stream being recorded; its sound draws the waveform. */
  stream: MediaStream | null;
  /** Whether sound is being taken now (false while paused: the wave holds still in the quiet colour). */
  active: boolean;
  /** The recording's time in ms, read each time it is drawn. */
  readElapsedMs?: () => number;
  /** The recording's time in ms when no reader is given. */
  elapsedMs?: number;
  /** Drawn in place of the waveform, such as the camera's picture. */
  picture?: React.ReactNode;
  /** In order; the main one last reads best. */
  actions: RecordingBarAction[];
  /** The waveform's name for screen readers. */
  waveformLabel?: string;
  /** The compact form (a pill over other work): no waveform, only the time, the actions and `trailing`. */
  compact?: boolean;
  /** Drawn after the actions (a microphone menu). */
  trailing?: React.ReactNode;
  /** The surface it sits on: the worn look's (`worn`) or the island that floats over other apps (`island`). */
  ground?: 'worn' | 'island';
  'aria-label'?: string;
}

export function RecordingBar({ stream, active, readElapsedMs, elapsedMs, picture, actions, waveformLabel = 'Live recording waveform', compact = false, trailing, ground = 'worn', 'aria-label': label = 'Recording controls' }: RecordingBarProps) {
  return (
    <Container layout="horizontal" gap="sm" alignItems="center" width={compact ? undefined : 'full'} rounded="lg" border="all" background={ground === 'island' ? 'island' : 'primary'} padding="xs" aria-label={label} data-recording-bar="" data-compact={compact ? '' : undefined}>
      <Container layout="horizontal" gap="xs" alignItems="center" className="shrink-0 ps-2" aria-live="off">
        <Text as="span" variant="caption" color={active ? 'error' : 'muted'} aria-hidden>●</Text>
        {readElapsedMs ? <ElapsedTime read={readElapsedMs} ticking={active} /> : <Text variant="caption">{formatElapsed(elapsedMs)}</Text>}
      </Container>
      {compact ? null : (
        <Container flex="1" minWidth="0">
          {picture ?? <LiveWaveform stream={stream} active={active} frame="flat" edgeFade className="h-9 min-h-9" aria-label={waveformLabel} />}
        </Container>
      )}
      <Container layout="horizontal" gap="xs" alignItems="center" className="shrink-0">
        {actions.map(action => action.main ? (
          <Button key={action.id} type="button" variant="primary" size="sm" radius="full" disabled={action.disabled} onClick={action.onPress}>
            <NamedIcon name={action.icon} size="xs" aria-hidden="true" />{action.label}
          </Button>
        ) : (
          <Button key={action.id} type="button" variant="ghost" size="icon" radius="full" disabled={action.disabled} onClick={action.onPress} aria-label={action.label} title={action.label}>
            <NamedIcon name={action.icon} size="sm" aria-hidden="true" />
          </Button>
        ))}
      </Container>
      {trailing}
    </Container>
  );
}
