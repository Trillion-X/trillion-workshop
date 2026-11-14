// parts/ui/show/sound-signal/SoundControls.tsx
//
// NO PRIOR: searched bitfield-packages show for sound settings, look picker, light follow, and Mobbin 'music sync lights scene picker' (Opal Create Mix live tiles, Oura Soundscapes list)
//
// PURPOSE
//   The controls for anything that moves with sound, the same wherever it is tuned (a background layer's settings,
//   the Ambience screen): where the sound comes from, which look it moves in (each look a live tile, after Opal's
//   Create Mix), the look's main colour, strength and speed, and which of the person's lights follow along.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Storage-blind: it reads a look and the ids that follow, and hands changes back; the caller keeps them.
//   2. Every choice is a row: sources from sound-sources.json, looks from screen-look's sound-looks.json, lights from
//      the targets the page registered (sound-targets.ts). Nothing here names a source, a look or a service.
//   3. A press that starts listening shows in itself whether it is asking, listening or refused (the source tile is
//      chosen while listening, and the plain words under it say what went wrong).
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import * as React from 'react';
import { Button } from '../button/Button';
import { ChoiceTiles } from '../choice-tiles/ChoiceTiles';
import { ColorWheel } from '../color-wheel/ColorWheel';
import { Container } from '../container';
import { Slider } from '../slider/Slider';
import { Switch } from '../switch/Switch';
import { Text } from '../text/Text';
import { SoundCanvas } from './SoundCanvas';
import { listenTo, onSoundState, soundSources, stopListening, type SoundState } from './sound-signal';
import { listSoundTargets, onTargetAnswers, type SoundTarget, type TargetAnswer } from './sound-targets';
import { sameSoundLook, soundLooks, type SoundLook } from './sound-looks';

export type SoundControlsProps = {
  look: SoundLook;
  onLook: (look: SoundLook) => void;
  following: readonly string[];
  onFollowing: (ids: string[]) => void;
};

function useSoundState(): SoundState {
  const [state, setState] = React.useState<SoundState>({ status: 'off', source: null, words: null });
  React.useEffect(() => onSoundState(setState), []);
  return state;
}

const STATUS_WORDS: Record<string, string> = {
  off: 'Not listening. It breathes on its own until you pick a sound.',
  asking: 'Waiting for your browser to allow it…',
  listening: 'Listening.',
};

export function SoundSourcePicker() {
  const state = useSoundState();
  const tiles = soundSources.map(source => ({ id: source.id, label: source.label, icon: source.icon }));
  return (
    <Container layout="vertical" gap="sm">
      <Text variant="label">Sound</Text>
      <ChoiceTiles tiles={tiles} chosen={state.status === 'listening' || state.status === 'asking' ? state.source : null} label="Where the sound comes from" onPick={tile => { void listenTo(tile.id); }} />
      <Container layout="horizontal" gap="sm">
        <Text variant="caption" color={state.status === 'refused' || state.status === 'unavailable' ? 'error' : 'muted'}>{state.words ?? STATUS_WORDS[state.status] ?? ''}</Text>
        {state.status === 'listening' ? <Button size="xs" variant="ghost" onClick={() => stopListening()}>Stop listening</Button> : null}
      </Container>
    </Container>
  );
}

/** The looks to pick from: every starting look, then the person's own (`own`, from useOwnSoundLooks). The tile that
 *  shows is the one the look is now, so a tuned look that matches nothing marks no tile. */
export function SoundLookPicker({ look, onLook, own = [] }: { look: SoundLook; onLook: (look: SoundLook) => void; own?: readonly SoundLook[] }) {
  const rows = [...soundLooks.looks, ...own];
  return (
    <Container layout="vertical" gap="sm">
      <Text variant="label">Look</Text>
      <Container layout="grid" gap="sm" className="grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))]">
        {rows.map(row => (
          <Button key={`${row.id}:${row.label}`} variant="outline" active={sameSoundLook(row, look)} aria-pressed={sameSoundLook(row, look)} className="h-auto flex-col items-stretch gap-1 p-1" onClick={() => onLook(row)}>
            <Container className="h-16 overflow-hidden rounded-md">
              <SoundCanvas look={row} />
            </Container>
            <Text variant="body-xs" weight="semibold" className="truncate px-1 text-left">{row.label}</Text>
          </Button>
        ))}
      </Container>
    </Container>
  );
}

export function SoundLookTuning({ look, onLook }: { look: SoundLook; onLook: (look: SoundLook) => void }) {
  const [main = '#ffffff', ...rest] = look.palette;
  return (
    <Container layout="vertical" gap="md">
      <Slider label="How strongly it answers the sound" value={Math.round(look.strength * 100)} min={0} max={100} step={1} unit="%" onValueChange={value => onLook({ ...look, strength: value / 100 })} />
      <Slider label="How fast it drifts" value={Math.round(look.speed * 100)} min={0} max={100} step={1} unit="%" onValueChange={value => onLook({ ...look, speed: value / 100 })} />
      <Text variant="label">Main colour</Text>
      <ColorWheel value={main} size={160} presets={soundLooks.looks.flatMap(row => row.palette.slice(0, 1))} onChange={hex => onLook({ ...look, palette: [hex, ...rest] })} />
    </Container>
  );
}

/** The person's lights, each with a switch to follow the sound. `whenNone` is what shows while they have none (the
 *  caller's words and way to connect some); left out, a plain line. */
export function SoundFollowers({ following, onFollowing, whenNone }: { following: readonly string[]; onFollowing: (ids: string[]) => void; whenNone?: React.ReactNode }) {
  const [targets, setTargets] = React.useState<Array<SoundTarget> | null>(null);
  const [answers, setAnswers] = React.useState<ReadonlyMap<string, TargetAnswer>>(new Map());
  React.useEffect(() => { void listSoundTargets().then(setTargets); return onTargetAnswers(next => setAnswers(new Map(next))); }, []);
  if (targets === null) return null;
  return (
    <Container layout="vertical" gap="sm">
      <Text variant="label">Lights that follow</Text>
      {targets.length === 0 ? whenNone ?? <Text variant="caption" color="muted">Connect your lights in Connections and they show here.</Text> : null}
      {targets.map(target => {
        const on = following.includes(target.id);
        const answer = answers.get(target.id);
        return (
          <Container key={target.id} layout="horizontal" gap="sm" className="items-center justify-between">
            <Container layout="vertical">
              <Text variant="body-xs" weight="semibold">{target.label}</Text>
              <Text variant="caption" color={answer?.state === 'failed' ? 'error' : 'muted'}>{answer?.state === 'failed' ? answer.words : on ? (answer?.state === 'sent' ? 'Following the sound.' : 'Starts with the sound.') : target.about ?? ''}</Text>
            </Container>
            <Switch checked={on} label={`${target.label} follows the sound`} onCheckedChange={checked => onFollowing(checked ? [...following, target.id] : following.filter(id => id !== target.id))} />
          </Container>
        );
      })}
    </Container>
  );
}

/** Every control together, for a place that tunes one thing moving with sound. */
export function SoundControls({ look, onLook, following, onFollowing }: SoundControlsProps) {
  return (
    <Container layout="vertical" gap="lg">
      <SoundSourcePicker />
      <SoundLookPicker look={look} onLook={onLook} />
      <SoundLookTuning look={look} onLook={onLook} />
      <SoundFollowers following={following} onFollowing={onFollowing} />
    </Container>
  );
}
