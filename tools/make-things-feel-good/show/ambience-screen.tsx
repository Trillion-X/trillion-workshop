// parts/ambience/show/ambience-screen.tsx
//
// NO PRIOR: searched bitfield-packages show for ambience, visualizer screen, now playing, and Mobbin 'full screen
//   ambient music visualizer with now playing' (Opal's player: the picture full-bleed, the title over it and the
//   microphone at the edge; Brink: the next and previous scene beside the picture)
//
// PURPOSE
//   Ambience: the screen, the space behind the panes and the person's lights moving with the sound around them. The
//   look fills the stage and moves with the sound; over it, what is playing (from a connected music service) or the
//   look's own name, with the previous and next look beside it; beside the stage (below it on a narrow pane) the shared
//   controls: where the music plays (pictures of the places, a press listens to it), where else the sound comes from,
//   the look (the person's own looks among them, saved from here by name), its strength, speed and colour, and which
//   lights follow (in plain words, with a way to connect some when there are none), and how Trillion talks (its voice and
//   speed, everywhere or per place: voices-panel.tsx over the person's own rows). "Put behind my screens" puts the
//   same look behind every pane, and "Take it away" removes it, from this screen itself (screen-arrangement's
//   behind-the-panes asks), so nobody has to find a menu. Opened with `{ listen: "computer" }` (from a music service's
//   connection) it leads with one button that hears the music on this computer.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every control is the shared one (parts/ui/show/sound-signal); this file writes no markup of its own and names no
//      look, source, light or service.
//   2. The chosen look and the lights that follow are kept on this device in the same shape a background layer keeps
//      them (`{ look, custom, following }`), so a look tuned here reads the same everywhere.
//   3. One export, `mount(element, { surfaceInput })`, returning how to take the screen down: the module kind's contract.
//   4. What is behind the panes is read from the arrangement, never kept here: the buttons say what is there now, and
//      a look changed here changes the one behind the panes too.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import React from 'react';
import { openAddress } from '#workspace/open-screen.ts';
import { askBehindPanes, useBehindPanes } from '../../screen-arrangement/show/behind-the-panes';
import { colourOf, contrast, type Rgba } from '../../screen-look/read-data/look-over-time';
import { Button, ChoiceTiles, Container, Input, NamedIcon, Text } from '../../ui';
import { mountSharedContent } from '../../ui/show/coss/shared-content';
import {
  SoundCanvas, SoundFollowers, SoundLookPicker, SoundLookTuning, SoundSourcePicker, followSound, keepSoundLook,
  listenTo, onSoundState, readSoundLook, registerSoundTargets, saveOwnSoundLook, soundLooks, useOwnSoundLooks,
  type SoundLook, type SoundState,
} from '../../ui/show/sound-signal';
import { followLights, lightKinds, lightServices, musicPlaces, nowPlaying, type NowPlaying } from './sound-followers';
import { VoicesPanel } from './voices-panel';

const KEPT = 'trillion-ambience';
const PLAYING_EVERY_MS = 15_000;
const BEHIND = 'effect.sound';
const MUSIC_SOURCE = 'computer';

type Kept = { look?: string; custom?: Partial<SoundLook>; following?: string[] };

const readKept = (): Kept => {
  try { return JSON.parse(localStorage.getItem(KEPT) ?? '{}') as Kept; } catch { return {}; }
};

function usePlaying(): NowPlaying | null {
  const [playing, setPlaying] = React.useState<NowPlaying | null>(null);
  React.useEffect(() => {
    let gone = false;
    const read = () => { void nowPlaying().then(answer => { if (!gone) setPlaying(answer); }); };
    read();
    const timer = window.setInterval(read, PLAYING_EVERY_MS);
    return () => { gone = true; window.clearInterval(timer); };
  }, []);
  return playing;
}

function useSoundState(): SoundState {
  const [state, setState] = React.useState<SoundState>({ status: 'off', source: null, words: null });
  React.useEffect(() => onSoundState(setState), []);
  return state;
}

/** Ask the arrangement; a page with no panes to put it behind says so in the button. */
async function ask(...args: Parameters<typeof askBehindPanes>): Promise<void> {
  if (!askBehindPanes(...args)) throw new Error('Open Trillion with your screens to put it behind them.');
}

/** The places music plays: a press listens to this computer's sound, so the look moves with whatever plays there. */
function MusicPlaces({ chosen, onChosen }: { chosen: string | null; onChosen: (id: string) => void }) {
  const state = useSoundState();
  const listening = state.source === MUSIC_SOURCE && (state.status === 'listening' || state.status === 'asking');
  return (
    <Container layout="vertical" gap="sm">
      <Text variant="label">Where your music plays</Text>
      <ChoiceTiles
        tiles={musicPlaces.map(place => ({ id: place.id, label: place.label, picture: place.picture }))}
        chosen={listening ? chosen : null}
        label="Where your music plays"
        onPick={tile => { onChosen(tile.id); void listenTo(MUSIC_SOURCE); }}
      />
      <Text variant="caption" color="muted">Play your music, press where it plays, then pick its tab or your screen with sound.</Text>
    </Container>
  );
}

/** A look tuned here, kept as the person's own under a name. */
function SaveOwnLook({ look, own }: { look: SoundLook; own: readonly SoundLook[] }) {
  const [name, setName] = React.useState('');
  return (
    <Container layout="horizontal" gap="sm" className="items-end">
      <Input label="Name your look" value={name} placeholder="Late night" onChange={event => setName(event.target.value)} />
      <Button variant="outline" doneLabel="Saved" disabled={!name.trim()} onClick={async () => { await saveOwnSoundLook(look, name, own); setName(''); }}>Save as my look</Button>
    </Container>
  );
}

const BLACK: Rgba = [0, 0, 0, 1];
const WHITE: Rgba = [255, 255, 255, 1];
/** The words over a look's own ground (its dark or light stage) take whichever of black and white stands out more
 *  from it, so a light screen look never writes dark words on a dark stage; a look with no ground shows the page's own
 *  ground and keeps the page's words. */
function wordsOver(ground: string | null | undefined): React.CSSProperties | undefined {
  const colour = colourOf(ground ?? undefined);
  if (!colour) return undefined;
  const light = contrast(WHITE, colour) >= contrast(BLACK, colour);
  return {
    '--text-primary': light ? 'rgb(255, 255, 255)' : 'rgb(0, 0, 0)',
    '--text-secondary': light ? 'rgba(255, 255, 255, 0.72)' : 'rgba(0, 0, 0, 0.66)',
  } as React.CSSProperties;
}

function Ambience({ leadWithMusic }: { leadWithMusic: boolean }) {
  const [kept, setKept] = React.useState<Kept>(readKept);
  const [place, setPlace] = React.useState<string | null>(null);
  const own = useOwnSoundLooks();
  const behind = useBehindPanes();
  const isBehind = behind.layers.some(layer => layer.paint.capability.capabilityId === BEHIND && layer.enabled !== false);
  const look = readSoundLook(kept);
  const lookRef = React.useRef(look);
  lookRef.current = look;
  const following = kept.following ?? [];
  const playing = usePlaying();
  const keep = (next: Kept) => {
    setKept(next);
    try { localStorage.setItem(KEPT, JSON.stringify(next)); } catch { /* a private window keeps nothing */ }
  };
  const layerInput = (next: Kept) => ({ look: next.look, custom: next.custom ?? {}, following: next.following ?? [] });
  const onLook = (next: SoundLook) => {
    const kept = { ...keepSoundLook(next), following };
    keep(kept);
    if (isBehind) askBehindPanes({ change: BEHIND, input: layerInput(kept) });
  };
  const step = (by: number) => {
    const at = soundLooks.looks.findIndex(row => row.id === look.id);
    onLook(soundLooks.looks[(at + by + soundLooks.looks.length) % soundLooks.looks.length]);
  };
  const followingKey = following.join('\n');
  React.useEffect(() => followSound(followingKey ? followingKey.split('\n') : [], () => lookRef.current), [followingKey]);
  return (
    <Container layout="vertical" height="full" minHeight="0" overflow="y-auto" className="@container">
      <Container layout="vertical" gap="none" className="min-h-full @[48rem]:flex-row">
        <Container position="relative" overflow="hidden" data-corner-follows="" className="h-[60vh] min-h-[18rem] shrink-0 @[48rem]:h-auto @[48rem]:min-h-0 @[48rem]:flex-1">
          <SoundCanvas look={look} label={`${look.label}, moving with the sound`} />
          <Container position="absolute" inset="0" layout="vertical" padding="lg" gap="sm" pointerEvents="none" className="items-center justify-end text-center" style={wordsOver(look.ground)}>
            {playing ? (
              <>
                <Text variant="label" color="white">{`Playing on ${playing.service}`}</Text>
                <Text variant="heading-lg" color="white">{playing.title}</Text>
                {playing.by ? <Text variant="body" color="white">{playing.by}</Text> : null}
              </>
            ) : (
              <>
                <Text variant="heading-lg" color="white">{look.label}</Text>
                {look.about ? <Text variant="body" color="white">{look.about}</Text> : null}
              </>
            )}
            <Container layout="horizontal" gap="sm" pointerEvents="auto">
              <Button variant="ghost" size="icon" radius="full" aria-label="The look before" onClick={() => step(-1)}><NamedIcon name="ChevronLeft" /></Button>
              <Button variant="ghost" size="icon" radius="full" aria-label="The next look" onClick={() => step(1)}><NamedIcon name="ChevronRight" /></Button>
            </Container>
          </Container>
        </Container>
        <Container layout="vertical" gap="lg" padding="lg" className="@[48rem]:w-[24rem] @[48rem]:shrink-0 @[48rem]:overflow-y-auto">
          {leadWithMusic ? (
            <Button variant="primary" size="lg" fullWidth onClick={() => listenTo(MUSIC_SOURCE)}>Hear your music</Button>
          ) : null}
          {isBehind ? (
            <Button variant="outline" fullWidth doneLabel="Taken away" onClick={() => ask({ take: BEHIND })}>Take it away from behind my screens</Button>
          ) : (
            <Button variant="primary" fullWidth doneLabel="Behind your screens" data-put-behind="" onClick={() => ask({ put: BEHIND, input: layerInput(kept) })}>Put behind my screens</Button>
          )}
          <MusicPlaces chosen={place} onChosen={setPlace} />
          <SoundSourcePicker />
          <SoundLookPicker look={look} onLook={onLook} own={own} />
          <SoundLookTuning look={look} onLook={onLook} />
          <SaveOwnLook look={look} own={own} />
          <VoicesPanel />
          <SoundFollowers
            following={following}
            onFollowing={ids => keep({ ...kept, following: ids })}
            whenNone={(
              <Container layout="vertical" gap="sm">
                <Text variant="caption" color="muted">{`Your lights can change colour with the music. Works with ${lightKinds.join(' and ')}.`}</Text>
                <Button variant="outline" size="sm" onClick={() => openAddress(`/connections?show_row=${lightServices.join(',')}`)}>Connect your lights</Button>
              </Container>
            )}
          />
        </Container>
      </Container>
    </Container>
  );
}

export function mount(element: HTMLElement, props: { surfaceInput?: Record<string, unknown> }): () => void {
  registerSoundTargets(followLights);
  const host = document.createElement('div');
  host.className = 'trillion-ambience h-full';
  element.replaceChildren(host);
  // Opened from a link (a music service's Hear it from this computer) the address carries what it opens on; opened
  // from inside Trillion, the screen's input does.
  const listen = props.surfaceInput?.listen ?? new URLSearchParams(location.search).get('listen');
  mountSharedContent(host, <Ambience leadWithMusic={listen === MUSIC_SOURCE} />);
  return () => { element.replaceChildren(); };
}
