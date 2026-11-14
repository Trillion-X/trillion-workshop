// packages/ui/show/audio-clip-player/AudioClipPlayer.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// One-row inline audio player: play/pause toggle, thin progress line, and a
// tabular m:ss / m:ss readout. The calm reference pattern (Amie's note
// player, fey's restraint) for playing a clip inside a list row without a
// media card.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Raw <audio> is legal ONLY inside ui primitives (same rule as MediaFrame).
//    Feature code passes a src and never touches the element.
// 2. All visuals through ui primitives + screen-look tokens.
// 3. The component is generic: any package, any audio src (object URL, http,
//    data URI). No product vocabulary.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';

import * as Popover from '@radix-ui/react-popover';
import { Check, Pause, Play, Volume2, VolumeX } from 'lucide-react';

import { Button } from '../button/Button';
import { Container } from '../container';
import { Dropdown } from '../dropdown';
import { Icon } from '../icon';
import { ProgressBar } from '../progress-bar/ProgressBar';
import { speedLabel, speedScale } from '../speed-control';
import { Text } from '../text/Text';

export type AudioClipPlayerProps = {
  /** Audio source: object URL, http(s) URL, or data URI. */
  src: string;
  /** Start playing as soon as the clip is ready. */
  autoPlay?: boolean;
  /** Called when playback reaches the end of the clip. */
  onEnded?: () => void;
  /**
   * File name to save the clip as. When present, a quiet Download action
   * appears after the readout.
   */
  downloadName?: string;
  /**
   * How fast it starts playing, as times natural with the pitch kept (the speed the person set for where it is
   * heard); natural when left out. The listener can still change it from the speed menu.
   */
  rate?: number;
};

/** Playback speeds offered by the speed menu: the shared speed scale's steps (speed-control/speeds.json). */
const PLAYBACK_RATE_ITEMS = speedScale.presets.map((rate) => ({ value: String(rate), label: speedLabel(rate) }));

function clockLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

export function AudioClipPlayer({ src, autoPlay = false, onEnded, downloadName, rate: startRate }: AudioClipPlayerProps) {
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const seekRef = React.useRef<HTMLDivElement | null>(null);
  const [playing, setPlaying] = React.useState(false);
  const [position, setPosition] = React.useState(0);
  const [duration, setDuration] = React.useState(0);
  const [rate, setRate] = React.useState(String(startRate ?? 1));
  const [volume, setVolume] = React.useState(1);
  const [muted, setMuted] = React.useState(false);

  const toggle = React.useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play();
    else audio.pause();
  }, []);

  const changeRate = React.useCallback((next: string) => {
    setRate(next);
    const audio = audioRef.current;
    if (audio) audio.playbackRate = Number(next);
  }, []);

  // The speed set for where it is heard can arrive after the player draws (the person's rows read later, or changed).
  React.useEffect(() => {
    if (startRate !== undefined) changeRate(String(startRate));
  }, [startRate, changeRate]);

  const changeVolume = React.useCallback((next: number) => {
    setVolume(next);
    setMuted(next === 0);
    const audio = audioRef.current;
    if (audio) {
      audio.volume = next;
      audio.muted = next === 0;
    }
  }, []);

  const changeVolumeByKeyboard = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'PageUp' || event.key === 'PageDown' ? 0.1 : 0.05;
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowUp':
      case 'PageUp':
        next = (muted ? 0 : volume) + step;
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
      case 'PageDown':
        next = (muted ? 0 : volume) - step;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    changeVolume(Math.min(1, Math.max(0, next)));
  }, [changeVolume, muted, volume]);

  const volumeTrackRef = React.useRef<HTMLDivElement | null>(null);
  const volumeFromPointer = React.useCallback((event: { clientY: number }) => {
    const track = volumeTrackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    if (rect.height <= 0) return;
    const fraction = Math.min(1, Math.max(0, (rect.bottom - event.clientY) / rect.height));
    changeVolume(Math.round(fraction * 20) / 20);
  }, [changeVolume]);

  const handleVolumePointerDown = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    volumeTrackRef.current?.setPointerCapture(event.pointerId);
    volumeFromPointer(event);
  }, [volumeFromPointer]);

  const handleVolumePointerMove = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!volumeTrackRef.current?.hasPointerCapture(event.pointerId)) return;
    volumeFromPointer(event);
  }, [volumeFromPointer]);

  const seekToPointer = React.useCallback((event: { clientX: number }) => {
    const audio = audioRef.current;
    const track = seekRef.current;
    if (!audio || !track || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return;
    const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    audio.currentTime = fraction * audio.duration;
    setPosition(audio.currentTime);
  }, []);

  const seekByKeyboard = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
    const step = event.key === 'PageUp' || event.key === 'PageDown' ? 30 : 5;
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        next = audio.currentTime + step;
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        next = audio.currentTime - step;
        break;
      case 'PageUp':
        next = audio.currentTime + step;
        break;
      case 'PageDown':
        next = audio.currentTime - step;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = audio.duration;
        break;
      default:
        return;
    }
    event.preventDefault();
    audio.currentTime = Math.min(audio.duration, Math.max(0, next));
    setPosition(audio.currentTime);
  }, []);

  const handleSeekPointerDown = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    seekRef.current?.setPointerCapture(event.pointerId);
    seekToPointer(event);
  }, [seekToPointer]);

  const handleSeekPointerMove = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!seekRef.current?.hasPointerCapture(event.pointerId)) return;
    seekToPointer(event);
  }, [seekToPointer]);

  const download = React.useCallback(() => {
    if (!downloadName) return;
    const anchor = document.createElement('a');
    anchor.href = src;
    anchor.download = downloadName;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }, [downloadName, src]);

  React.useEffect(() => {
    setPosition(0);
    setDuration(0);
    setPlaying(false);
    const audio = audioRef.current;
    if (audio) {
      audio.playbackRate = Number(rate);
      audio.volume = volume;
      audio.muted = muted;
    }
    // Rate/volume carry across clips deliberately (the listener chose them);
    // only position/duration reset per src.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  return (
    <Container layout="horizontal" gap="sm" alignItems="center">
      <audio
        ref={audioRef}
        src={src}
        autoPlay={autoPlay}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          onEnded?.();
        }}
        onTimeUpdate={(event) => setPosition((event.target as HTMLAudioElement).currentTime)}
        onDurationChange={(event) => {
          const next = (event.target as HTMLAudioElement).duration;
          if (Number.isFinite(next)) setDuration(next);
        }}
      />
      <Button variant="ghost" size="icon" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
        <Icon icon={playing ? Pause : Play} size="sm" />
      </Button>
      <Text variant="body-xs" color="faint" tabular>
        {clockLabel(position)}
      </Text>
      <div
        ref={seekRef}
        role="slider"
        aria-label="Seek"
        aria-valuetext={`${clockLabel(position)} of ${clockLabel(duration)}`}
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(position)}
        data-control="audio-seek"
        tabIndex={0}
        className="flex min-w-0 flex-1 cursor-pointer touch-none items-center py-2"
        onKeyDown={seekByKeyboard}
        onPointerDown={handleSeekPointerDown}
        onPointerMove={handleSeekPointerMove}
      >
        <Container layout="vertical" gap="none" flex="1">
          <ProgressBar
            percentage={duration > 0 ? (position / duration) * 100 : 0}
            color="var(--accent-primary)"
          />
        </Container>
      </div>
      <Text variant="body-xs" color="faint" tabular>
        {clockLabel(duration)}
      </Text>
      <Popover.Root>
        <Popover.Trigger asChild>
          <Button variant="ghost" size="icon" aria-label="Volume">
            <Icon icon={muted || volume === 0 ? VolumeX : Volume2} size="sm" />
          </Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            side="top"
            align="center"
            sideOffset={6}
            className="z-50 flex flex-col items-center rounded-full bg-[var(--glass-popover-background,var(--glass-bg-active,var(--glass-bg-subtle)))] px-2 py-2.5 shadow-2xl backdrop-blur-2xl backdrop-saturate-150"
          >
            <div
              ref={volumeTrackRef}
              role="slider"
              aria-label="Volume"
              aria-orientation="vertical"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round((muted ? 0 : volume) * 100)}
              aria-valuetext={`${Math.round((muted ? 0 : volume) * 100)}%`}
              data-control="audio-volume"
              tabIndex={0}
              className="flex h-20 w-4 cursor-pointer touch-none items-center justify-center"
              onKeyDown={changeVolumeByKeyboard}
              onPointerDown={handleVolumePointerDown}
              onPointerMove={handleVolumePointerMove}
            >
              <div className="relative h-full w-1 overflow-hidden rounded-full bg-[var(--glass-bg-hover)]">
                <div
                  className="absolute inset-x-0 bottom-0 rounded-full bg-[var(--accent-primary)]"
                  style={{ height: `${Math.round((muted ? 0 : volume) * 100)}%` }}
                />
              </div>
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <Dropdown
        items={PLAYBACK_RATE_ITEMS}
        value={rate}
        onValueChange={changeRate}
        align="end"
        header="Playback speed"
        aria-label="Playback speed"
        customTrigger={(
          <Button variant="ghost" size="sm" aria-label="Playback speed">
            {speedLabel(Number(rate))}
          </Button>
        )}
        renderItem={(item, state) => (
          <Container layout="horizontal" gap="sm" alignItems="center" className="w-full">
            <Text variant="body-xs" className="flex-1">{item.label}</Text>
            {state.selected ? <Icon icon={Check} size="xs" /> : null}
          </Container>
        )}
      />
      {downloadName ? (
        <Button variant="ghost" size="sm" onClick={download}>
          Download
        </Button>
      ) : null}
    </Container>
  );
}
