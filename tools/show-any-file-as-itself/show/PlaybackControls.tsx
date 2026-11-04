import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Captions,
  FastForward,
  Maximize2,
  MessageSquare,
  Minimize2,
  Pause,
  Play,
  Volume1,
  Volume2,
  VolumeX,
} from 'lucide-react';
import {AnimatePresence} from 'framer-motion';
import { motion } from '../../ui/motion/lazy-motion';
import * as Popover from '@radix-ui/react-popover';
import { classNames } from './class-names';

const SPEED_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

/**
 * How the one set of controls is drawn. `over-picture` lies over a video's picture and fades with the pointer;
 * `sound` is a sound's own face: always shown on the page's surface, a large round play, the sound's waveform as the
 * seek bar (played part filled), the time, then volume, speed and the words. Each look is a set of class names on the
 * same parts, so a control added once appears in every look.
 */
export type PlaybackControlsLook = 'over-picture' | 'sound';

type LookClasses = {
  button: string;
  buttonOn: string;
  icon: string;
  time: string;
  track: string;
  fill: string;
  thumb: string;
  bar: string;
  barPlayed: string;
  speedMenu: string;
  speedOption: string;
  speedOptionOn: string;
  speedOptionOff: string;
  speedRange: string;
};

const LOOKS: Record<PlaybackControlsLook, LookClasses> = {
  'over-picture': {
    button: 'rounded-md border-0 bg-transparent p-1.5 text-white shadow-none outline-none ring-0 transition-colors hover:bg-white/10 hover:text-white sm:p-2',
    buttonOn: 'bg-white/20',
    icon: 'h-5 w-5 sm:h-6 sm:w-6',
    time: 'text-xs text-white tabular-nums sm:text-sm',
    track: 'h-1 w-full overflow-hidden rounded-full bg-white/20',
    fill: 'bg-white',
    thumb: 'bg-white shadow-[0_0_10px_rgba(255,255,255,0.5)]',
    bar: 'bg-white/30',
    barPlayed: 'bg-white',
    speedMenu: 'border-white/10 bg-black/90 text-white',
    speedOption: 'text-white',
    speedOptionOn: 'bg-white/20',
    speedOptionOff: 'bg-transparent hover:bg-white/10',
    speedRange: 'bg-white/20 [&::-webkit-slider-thumb]:bg-white',
  },
  sound: {
    button: 'rounded-full border-0 bg-transparent p-1.5 text-muted-foreground shadow-none outline-none ring-0 transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
    buttonOn: 'bg-accent text-foreground',
    icon: 'h-4 w-4',
    time: 'text-xs tabular-nums text-muted-foreground',
    track: 'h-1 w-full overflow-hidden rounded-full bg-input',
    fill: 'bg-foreground',
    thumb: 'bg-foreground shadow-sm',
    bar: 'bg-foreground/20',
    barPlayed: 'bg-foreground',
    speedMenu: 'border-input bg-popover text-popover-foreground',
    speedOption: 'text-popover-foreground',
    speedOptionOn: 'bg-accent',
    speedOptionOff: 'bg-transparent hover:bg-accent',
    speedRange: 'bg-input [&::-webkit-slider-thumb]:bg-foreground',
  },
};

// A bar and its gap; below this the waveform turns into hairlines, so neighbouring peaks are merged.
const WAVE_BAR_PITCH = 4;

/** Merges neighbouring peaks (keeping the loudest) down to `count` bars; fewer peaks than bars just draw wider bars. */
export function fitPeaks(peaks: readonly number[], count: number): number[] {
  if (count <= 0 || count >= peaks.length) return [...peaks];
  return Array.from({ length: count }, (_, index) => {
    const start = Math.floor((index * peaks.length) / count);
    const end = Math.max(Math.floor(((index + 1) * peaks.length) / count), start + 1);
    return Math.max(...peaks.slice(start, end));
  });
}

// One row of bars, drawn once per width; only the clip over the played copy changes as the sound plays.
const WaveBars = React.memo(function WaveBars({ barClassName, peaks }: { barClassName: string; peaks: readonly number[] }) {
  return (
    <div className="flex h-full items-center gap-[2px]">
      {peaks.map((peak, index) => (
        // A silent stretch still shows as a dot rather than disappearing.
        <span className={classNames('min-w-[2px] flex-1 rounded-full', barClassName)} key={index} style={{ height: `${Math.max(peak, 0.06) * 100}%` }} />
      ))}
    </div>
  );
});

function formatTime(seconds: number) {
  const safeSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = Math.floor(safeSeconds % 60);
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

type SliderProps = {
  ariaLabel: string;
  className?: string;
  look: LookClasses;
  onChange: (value: number) => void;
  /** The sound's own loudness, 0..1 from start to end: the track is drawn as its waveform. */
  peaks?: readonly number[];
  value: number;
  valueText?: string;
};

function stopControlEvent(event: React.SyntheticEvent) {
  event.stopPropagation();
}

function Slider({ ariaLabel, className, look, onChange, peaks, value, valueText }: SliderProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const sliderRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const boundedValue = Math.min(Math.max(value, 0), 100);
  const hasWave = Boolean(peaks?.length);
  const bars = React.useMemo(() => (peaks?.length && width > 0 ? fitPeaks(peaks, Math.floor(width / WAVE_BAR_PITCH)) : []), [peaks, width]);

  useEffect(() => {
    const slider = sliderRef.current;
    if (!slider || !hasWave || typeof ResizeObserver === 'undefined') return undefined;
    setWidth(slider.clientWidth);
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(slider);
    return () => observer.disconnect();
  }, [hasWave]);

  const updateValue = useCallback((clientX: number) => {
    const slider = sliderRef.current;
    if (!slider) return;
    const rect = slider.getBoundingClientRect();
    const nextValue = ((clientX - rect.left) / rect.width) * 100;
    onChange(Math.min(Math.max(nextValue, 0), 100));
  }, [onChange]);

  function handleMouseDown(event: React.MouseEvent) {
    event.stopPropagation();
    setIsDragging(true);
    updateValue(event.clientX);
    event.preventDefault();
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    const step = event.shiftKey ? 10 : 5;
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      event.stopPropagation();
      onChange(event.key === 'Home' ? 0 : 100);
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      event.preventDefault();
      onChange(Math.max(boundedValue - step, 0));
    }
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      event.preventDefault();
      onChange(Math.min(boundedValue + step, 100));
    }
  }

  useEffect(() => {
    if (!isDragging) return undefined;

    function handleMouseMove(event: MouseEvent) {
      updateValue(event.clientX);
    }

    function handleMouseUp() {
      setIsDragging(false);
    }

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, updateValue]);

  return (
    <div
      aria-label={ariaLabel}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={Math.round(boundedValue)}
      aria-valuetext={valueText}
      className={classNames('relative flex w-full cursor-pointer touch-none select-none items-center group', hasWave ? 'h-10' : 'h-4', className)}
      data-playback-seek-wave={hasWave ? 'true' : undefined}
      onClick={stopControlEvent}
      onKeyDown={handleKeyDown}
      onMouseDown={handleMouseDown}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onPointerDown={stopControlEvent}
      ref={sliderRef}
      role="slider"
      tabIndex={0}
    >
      {hasWave ? (
        <>
          <div className="pointer-events-none absolute inset-0">
            <WaveBars barClassName={look.bar} peaks={bars} />
          </div>
          {/* The same bars again, clipped to the played part: colour follows the look, and only the clip moves. */}
          <div
            className="pointer-events-none absolute inset-0"
            style={{ clipPath: `inset(0 ${100 - boundedValue}% 0 0)`, transition: isDragging ? 'none' : 'clip-path 100ms linear' }}
          >
            <WaveBars barClassName={look.barPlayed} peaks={bars} />
          </div>
          <div
            className={classNames('pointer-events-none absolute inset-y-1 w-[2px] rounded-full transition-opacity', look.fill, (isHovered || isDragging) ? 'opacity-100' : 'opacity-0 group-focus-visible:opacity-100')}
            style={{ left: `calc(${boundedValue}% - 1px)` }}
          />
        </>
      ) : (
        <>
          <div className={look.track}>
            <div
              className={classNames('h-full rounded-full pointer-events-none', look.fill)}
              style={{
                transition: isDragging ? 'none' : 'width 100ms linear',
                width: `${boundedValue}%`,
              }}
            />
          </div>
          <div
            className={classNames(
              'absolute h-3 w-3 rounded-full pointer-events-none',
              look.thumb,
              (isHovered || isDragging) ? 'scale-125' : '',
            )}
            style={{
              left: `calc(${boundedValue}% - 6px)`,
              transition: isDragging ? 'transform 150ms' : 'left 100ms linear, transform 150ms',
            }}
          />
        </>
      )}
    </div>
  );
}

export type PlaybackControlsProps = {
  currentTime: number;
  duration: number;
  isFullscreen?: boolean;
  isMuted: boolean;
  isPlaying: boolean;
  /** How the controls are drawn (see PlaybackControlsLook); `over-picture` when not named. */
  look?: PlaybackControlsLook;
  maxPlaybackSpeed?: number;
  minPlaybackSpeed?: number;
  onSeek: (value: number) => void;
  onSpeedChange: (speed: number) => void;
  onSpeedPopoverOpenChange?: (open: boolean) => void;
  onToggleCaptions?: () => void;
  onToggleFullscreen?: () => void;
  onToggleMute: () => void;
  onTogglePlay: () => void;
  onToggleTranscript?: () => void;
  onVolumeChange: (value: number) => void;
  /** The sound's loudness from start to end (0..1): the seek bar is drawn as its waveform. */
  peaks?: readonly number[];
  playbackSpeed: number;
  popoverContainer?: HTMLElement | null;
  progress: number;
  showCaptions?: boolean;
  showControls: boolean;
  showTranscript?: boolean;
  volume: number;
};

export function PlaybackControls({
  currentTime,
  duration,
  isFullscreen,
  isMuted,
  isPlaying,
  look: lookName = 'over-picture',
  maxPlaybackSpeed = 4,
  minPlaybackSpeed = 0.1,
  onSeek,
  onSpeedChange,
  onSpeedPopoverOpenChange,
  onToggleCaptions,
  onToggleFullscreen,
  onToggleMute,
  onTogglePlay,
  onToggleTranscript,
  onVolumeChange,
  peaks,
  playbackSpeed,
  popoverContainer,
  progress,
  showCaptions,
  showControls,
  showTranscript,
  volume,
}: PlaybackControlsProps) {
  const [speedOpen, setSpeedOpen] = useState(false);
  const reservation = useRef<(() => void) | null>(null);
  // Overlays consume the controls' real occupied space. Keep it reserved while
  // AnimatePresence fades the controls out, then release it at actual removal.
  const reserveControlsSpace = useCallback((element: HTMLDivElement | null) => {
    reservation.current?.();
    reservation.current = null;
    const parent = element?.parentElement;
    if (!element || !parent || lookName === 'sound') return;
    const update = () => parent.style.setProperty('--media-playback-controls-inset', `${Math.ceil(element.getBoundingClientRect().height)}px`);
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(element);
    window.addEventListener('resize', update);
    reservation.current = () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
      parent.style.removeProperty('--media-playback-controls-inset');
    };
  }, [lookName]);
  const boundedMinSpeed = Math.max(0.05, Math.min(minPlaybackSpeed, maxPlaybackSpeed));
  const boundedMaxSpeed = Math.max(boundedMinSpeed, maxPlaybackSpeed);
  const visibleSpeedOptions = SPEED_OPTIONS.filter((speed) => speed >= boundedMinSpeed && speed <= boundedMaxSpeed);

  function setSpeedPopoverOpen(open: boolean) {
    setSpeedOpen(open);
    onSpeedPopoverOpenChange?.(open);
  }

  function controlClick(handler: () => void) {
    return (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      handler();
    };
  }

  const look = LOOKS[lookName];
  const soundFace = lookName === 'sound';

  const playButton = (
    <button
      aria-label={isPlaying ? 'Pause' : 'Play'}
      className={soundFace
        ? 'flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-0 bg-[var(--button-primary-bg)] bg-[image:var(--button-sheen)] text-[var(--button-primary-text)] shadow-[var(--button-highlight),var(--button-shadow)] outline-none transition-transform hover:scale-105 active:scale-95 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
        : look.button}
      data-playback-play=""
      onClick={controlClick(onTogglePlay)}
      onPointerDown={stopControlEvent}
      type="button"
    >
      {isPlaying ? (
        <Pause className={soundFace ? 'h-5 w-5 fill-current' : look.icon} aria-hidden="true" />
      ) : (
        <Play className={soundFace ? 'h-5 w-5 translate-x-px fill-current' : look.icon} aria-hidden="true" />
      )}
    </button>
  );

  const seekBar = (
    <Slider
      ariaLabel="Seek"
      className="flex-1"
      look={look}
      onChange={onSeek}
      peaks={peaks}
      value={progress}
      valueText={`${formatTime(currentTime)} of ${formatTime(duration)}`}
    />
  );

  const volumeControls = (
    <>
      <button
        aria-label={isMuted ? 'Unmute' : 'Mute'}
        className={look.button}
        onClick={controlClick(onToggleMute)}
        onPointerDown={stopControlEvent}
        type="button"
      >
        {isMuted ? (
          <VolumeX className={look.icon} aria-hidden="true" />
        ) : volume > 50 ? (
          <Volume2 className={look.icon} aria-hidden="true" />
        ) : (
          <Volume1 className={look.icon} aria-hidden="true" />
        )}
      </button>

      <div className="hidden w-20 sm:block lg:w-24">
        <Slider
          ariaLabel="Volume"
          look={look}
          onChange={onVolumeChange}
          value={isMuted ? 0 : volume}
        />
      </div>
    </>
  );

  const speedControl = (
    <Popover.Root open={speedOpen} onOpenChange={setSpeedPopoverOpen}>
      <Popover.Trigger asChild>
        <button
          aria-label="Playback speed"
          className={classNames(look.button, soundFace ? 'min-w-10 px-2 text-xs font-medium tabular-nums' : '')}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={stopControlEvent}
          type="button"
        >
          {soundFace ? `${playbackSpeed}×` : <FastForward className={look.icon} aria-hidden="true" />}
        </button>
      </Popover.Trigger>
      <Popover.Portal container={popoverContainer ?? undefined}>
        <Popover.Content
          align="end"
          className={classNames('z-[10000] w-auto rounded-xl border p-3 shadow-xl backdrop-blur-md', look.speedMenu)}
          onClick={stopControlEvent}
          onMouseDown={stopControlEvent}
          onPointerDown={stopControlEvent}
          side="top"
        >
          <div className="flex flex-col gap-2">
            <div className="border-b border-[color-mix(in_srgb,currentColor_12%,transparent)] px-1 pb-2">
              <div className="flex items-center gap-3">
                <input
                  aria-label="Custom playback speed"
                  className={classNames('h-1 flex-1 cursor-pointer appearance-none rounded-full [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full', look.speedRange)}
                  max={boundedMaxSpeed}
                  min={boundedMinSpeed}
                  onChange={(event) => onSpeedChange(parseFloat(event.currentTarget.value))}
                  step="0.05"
                  type="range"
                  value={playbackSpeed}
                />
                <span className="w-12 text-right text-sm font-medium tabular-nums">
                  {playbackSpeed.toFixed(2)}x
                </span>
              </div>
            </div>
            <div className="flex flex-col gap-0.5">
              {visibleSpeedOptions.map((speed) => (
                <button
                  className={classNames(
                    'w-32 rounded-lg border-none px-3 py-1.5 text-left text-sm font-medium shadow-none outline-none ring-0 transition-colors',
                    look.speedOption,
                    playbackSpeed === speed ? look.speedOptionOn : look.speedOptionOff,
                  )}
                  key={speed}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onSpeedChange(speed);
                    setSpeedPopoverOpen(false);
                  }}
                  onPointerDown={stopControlEvent}
                  type="button"
                >
                  {speed}x {speed === 1 ? '(Normal)' : ''}
                </button>
              ))}
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );

  const fullscreenButton = onToggleFullscreen ? (
    <button
      aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
      className={look.button}
      onClick={controlClick(onToggleFullscreen)}
      onPointerDown={stopControlEvent}
      type="button"
    >
      {isFullscreen ? (
        <Minimize2 className={look.icon} aria-hidden="true" />
      ) : (
        <Maximize2 className={look.icon} aria-hidden="true" />
      )}
    </button>
  ) : null;

  const transcriptButton = onToggleTranscript ? (
    <button
      aria-label={showTranscript ? 'Hide transcript' : 'Show transcript'}
      className={classNames(look.button, showTranscript ? look.buttonOn : '')}
      onClick={controlClick(onToggleTranscript)}
      onPointerDown={stopControlEvent}
      type="button"
    >
      <MessageSquare className={look.icon} aria-hidden="true" />
    </button>
  ) : null;

  const captionsButton = onToggleCaptions ? (
    <button
      aria-label={showCaptions ? 'Hide captions' : 'Show captions'}
      className={classNames(look.button, showCaptions ? look.buttonOn : '')}
      onClick={controlClick(onToggleCaptions)}
      onPointerDown={stopControlEvent}
      type="button"
    >
      <Captions className={look.icon} aria-hidden="true" />
    </button>
  ) : null;

  if (soundFace) {
    return (
      <div
        className="flex w-full flex-col gap-1.5"
        data-playback-look="sound"
        data-ui-part="playback-controls"
        onClick={stopControlEvent}
        onMouseDown={stopControlEvent}
        onPointerDown={stopControlEvent}
      >
        <div className="flex items-center gap-3">
          {playButton}
          {seekBar}
        </div>
        <div className="flex items-center justify-between gap-2 pl-14">
          <span className={look.time}>
            {formatTime(currentTime)}
            <span className="opacity-60"> / {formatTime(duration)}</span>
          </span>
          <div className="flex items-center gap-0.5">
            {volumeControls}
            {speedControl}
            {fullscreenButton}
            {transcriptButton}
            {captionsButton}
          </div>
        </div>
      </div>
    );
  }

  return (
    <AnimatePresence>
      {showControls ? (
        <motion.div
          ref={reserveControlsSpace}
          animate={{ opacity: 1 }}
          className={classNames(
            'absolute bottom-0 left-0 right-0 z-40 bg-gradient-to-t from-black/80 to-transparent',
            isFullscreen ? 'px-4 pb-2 pt-8' : 'px-3 pb-2 pt-6 sm:px-4',
          )}
          data-playback-look="over-picture"
          data-ui-part="playback-controls"
          exit={{ opacity: 0 }}
          // The shared motion owner loads features asynchronously. Controls
          // must paint and work while that import is pending; only their exit
          // fades, with the measured caption reservation kept until removal.
          initial={false}
          onClick={stopControlEvent}
          onMouseDown={stopControlEvent}
          onPointerDown={stopControlEvent}
          transition={{ duration: 0.2 }}
        >
          <div className="mb-1 flex items-center gap-2">
            <span className={look.time}>
              {formatTime(currentTime)}
            </span>
            {seekBar}
            <span className={look.time}>
              {formatTime(duration)}
            </span>
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1 sm:gap-2">
              {playButton}
              {volumeControls}
            </div>

            <div className="flex items-center gap-0.5 sm:gap-1">
              {speedControl}
              {fullscreenButton}
              {transcriptButton}
              {captionsButton}
            </div>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
