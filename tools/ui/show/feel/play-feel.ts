// parts/ui/show/feel/play-feel.ts
//
// NO PRIOR: searched bitfield-packages/packages/*/show for "haptic", "vibrate", "AudioContext" and "earcon"
// (none; sound-signal here only draws the room's sound), and the 21st.dev MCP for "haptic feedback button" and
// "sound on click" (components that play one fixed file per button). Research and numbers:
// the touch-feel research notes (Apple Playing haptics, Core Haptics AHAP, Vibration API support,
// WebAudio unlock rules).
//
// PURPOSE
//   Plays one feel on the device the page runs on: what an output of a feel row says (records/feel-moments.json) is
//   handed to that output's player. Touch goes to the first way this device can play it: the app that hosts the page
//   (the iPhone app plays it with Core Haptics, the Mac app on its trackpad) or a phone browser that vibrates. Sound is
//   synthesised here from the row's tones, so every device plays the same notes with no sound files. Motion plays the
//   row's keyframes on the thing that was pressed, sent or dropped.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a moment, a feel or a pattern: every number comes from the caller's row. An output with no
//      player plays nothing; a new output is one entry in `FEEL_OUTPUT_PLAYERS`, a new way to touch one entry in
//      `TOUCH_ROUTES`, and no caller changes.
//   2. A player that cannot play here says so (returns null) instead of throwing; a feel never interrupts the work.
//   3. Sound waits for the person's first tap or key on the page (browsers refuse sound before it), its audio context
//      is made when the page is idle after that, never inside a tap or key (a sound asked before then is skipped), and
//      it never plays louder than the row's gain; motion asked of a device that wants less motion plays the row's `reduced` instead.
//   4. Every feel played is written to this page's feel log (`feelLog()`, the last 50, also `globalThis.__trillionFeel`)
//      with the way each output went, so a proof can show a touch that cannot be pictured.
//
// The extensive documentation in this codebase is a critical design feature. You are forbidden from simplifying
// or removing it.

/** One touch as Core Haptics describes it: when (seconds), how strong and how sharp (0 to 1), and how long a held one lasts. */
export type FeelTouchEvent = { at: number; intensity: number; sharpness: number; duration?: number };
export type FeelTouch = { events: FeelTouchEvent[]; vibrate?: number[] };
export type FeelTone = { at: number; hz: number; hz_to?: number; ms: number; gain: number; wave?: OscillatorType };
export type FeelSound = { tones: FeelTone[] };
export type FeelMotionSpec = { keyframes: Keyframe[]; options: KeyframeAnimationOptions; reduced?: { keyframes: Keyframe[]; options: KeyframeAnimationOptions } };
export type FeelPlay = { target?: Element | null; moment?: string; feel?: string };
/** A player answers the way it played (a word for the log), or null when it could not play on this device. */
export type FeelOutputPlayer = (spec: unknown, play: FeelPlay) => string | null;
export type FeelLogEntry = { at: number; moment: string; feel: string; played: Record<string, string>; skipped: string[] };

import { switchTick } from './switch-tick';

const LOG_KEY = '__trillionFeel';
/** The message channel an app hosting the page listens on to play touch (iPhone and Mac apps). */
export const FEEL_HOST_CHANNEL = 'trillionFeel';

type Scope = typeof globalThis & {
  [LOG_KEY]?: FeelLogEntry[];
  webkit?: { messageHandlers?: Record<string, { postMessage: (message: unknown) => void } | undefined> };
};
const scope = globalThis as Scope;

/** This page's feel log, newest last. */
export function feelLog(): FeelLogEntry[] {
  return (scope[LOG_KEY] ??= []);
}

function writeLog(entry: FeelLogEntry) {
  const log = feelLog();
  log.push(entry);
  if (log.length > 50) log.splice(0, log.length - 50);
  if (typeof console !== 'undefined') console.debug('[feel]', entry.moment, entry.feel, entry.played);
}

const hasTapped = () => {
  const activation = (typeof navigator !== 'undefined' ? (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation : undefined);
  return activation ? activation.hasBeenActive : true;
};

// ---- Touch: the ways a device can play it, tried in order ----

type TouchRoute = { id: string; play: (touch: FeelTouch, play: FeelPlay) => boolean };

/** The ways touch can be played, the first that can wins: an Apple app hosting the page, any other app hosting it, a
 *  browser that vibrates (Android), then Safari's switch tick on an iPhone or iPad (inside a real tap). */
export const TOUCH_ROUTES: TouchRoute[] = [
  { id: 'app', play: (touch, play) => {
    const host = scope.webkit?.messageHandlers?.[FEEL_HOST_CHANNEL];
    if (!host) return false;
    host.postMessage({ moment: play.moment ?? '', feel: play.feel ?? '', events: touch.events });
    return true;
  } },
  // Any other app that hosts the page and plays touch itself (an Android or Windows app) adds one object to the page,
  // TrillionFeelHost, whose play(json) takes the same { moment, feel, events } as text.
  { id: 'host', play: (touch, play) => {
    const host = (scope as Scope & { TrillionFeelHost?: { play: (json: string) => unknown } }).TrillionFeelHost;
    if (typeof host?.play !== 'function') return false;
    host.play(JSON.stringify({ moment: play.moment ?? '', feel: play.feel ?? '', events: touch.events }));
    return true;
  } },
  { id: 'vibrate', play: touch => {
    if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function' || !touch.vibrate?.length || !hasTapped()) return false;
    return navigator.vibrate(touch.vibrate);
  } },
  // Safari on an iPhone or iPad has no vibrate: inside a real tap, its hidden switch plays the system tick.
  { id: 'switch', play: () => switchTick() },
];

const playTouch: FeelOutputPlayer = (spec, play) => {
  const touch = spec as FeelTouch;
  if (!Array.isArray(touch?.events) || !touch.events.length) return null;
  for (const route of TOUCH_ROUTES) {
    try { if (route.play(touch, play)) return route.id; } catch { /* the next way is tried */ }
  }
  return null;
};

// ---- Sound: tones synthesised on the device ----

let audio: AudioContext | null = null;
let audioAsked = false;
/** Starts this page's audio context when the page is idle, once the person has tapped or pressed a key. Making one
 *  starts the device's audio and blocks the page for up to a second, so it is never made inside the tap or key that
 *  asked for it (that key would wait, such as the first Command-K of a visit); the page's lasting activation lets the
 *  context run when it is made. */
function askAudio(): void {
  if (audio || audioAsked || typeof window === 'undefined') return;
  const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) return;
  audioAsked = true;
  const make = () => {
    audio = new Context({ latencyHint: 'interactive' });
    if (audio.state === 'suspended') void audio.resume().catch(() => {});
  };
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(make, { timeout: 2000 });
  else setTimeout(make, 200);
}

/** Lets sound play after the person's first tap or key (browsers keep an audio context asleep until then): the first
 *  one asks for the context at idle, later ones wake a context the browser put to sleep. */
export function wakeFeelSound(root: Document | HTMLElement = document): () => void {
  const wake = () => {
    if (!audio) return askAudio();
    if (audio.state === 'suspended') void audio.resume().catch(() => {});
  };
  root.addEventListener('pointerdown', wake, true);
  root.addEventListener('keydown', wake, true);
  return () => { root.removeEventListener('pointerdown', wake, true); root.removeEventListener('keydown', wake, true); };
}

const playSound: FeelOutputPlayer = spec => {
  const tones = (spec as FeelSound)?.tones;
  if (!Array.isArray(tones) || !tones.length || !hasTapped()) return null;
  const context = audio;
  if (!context) { askAudio(); return null; }
  if (context.state === 'suspended') void context.resume().catch(() => {});
  const start = context.currentTime + 0.005;
  for (const tone of tones) {
    const at = start + Math.max(0, tone.at);
    const end = at + Math.max(0.02, tone.ms / 1000);
    const peak = Math.min(Math.max(tone.gain, 0.0001), 0.2);
    const oscillator = context.createOscillator();
    const level = context.createGain();
    oscillator.type = tone.wave ?? 'sine';
    oscillator.frequency.setValueAtTime(tone.hz, at);
    if (tone.hz_to) oscillator.frequency.exponentialRampToValueAtTime(tone.hz_to, end);
    level.gain.setValueAtTime(0.0001, at);
    level.gain.linearRampToValueAtTime(peak, at + 0.003);
    level.gain.exponentialRampToValueAtTime(0.0001, end);
    oscillator.connect(level).connect(context.destination);
    oscillator.start(at);
    oscillator.stop(end + 0.02);
  }
  return context.state === 'running' ? 'played' : 'waking';
};

// ---- Motion: keyframes on the thing it happened to ----

const wantsLessMotion = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const playMotion: FeelOutputPlayer = (spec, play) => {
  const motion = spec as FeelMotionSpec;
  const target = play.target as (Element & { animate?: Element['animate'] }) | null | undefined;
  if (!target?.isConnected || typeof target.animate !== 'function' || !motion?.keyframes) return null;
  const less = wantsLessMotion();
  const chosen = less ? motion.reduced : motion;
  if (!chosen) return null;
  target.animate(chosen.keyframes, chosen.options);
  return less ? 'reduced' : 'played';
};

/** The player for each output a feel row can carry. */
export const FEEL_OUTPUT_PLAYERS: Record<string, FeelOutputPlayer> = { haptic: playTouch, sound: playSound, motion: playMotion };

/** Plays what each output of one feel says and writes it to the feel log. `plays` is [{ output, play }]. */
export function playFeel(plays: Array<{ output: string; play: unknown }>, play: FeelPlay): FeelLogEntry {
  const entry: FeelLogEntry = { at: Date.now(), moment: play.moment ?? '', feel: play.feel ?? '', played: {}, skipped: [] };
  for (const one of plays) {
    const player = FEEL_OUTPUT_PLAYERS[one.output];
    let way: string | null = null;
    try { way = player ? player(one.play, play) : null; } catch { way = null; }
    if (way) entry.played[one.output] = way; else entry.skipped.push(one.output);
  }
  writeLog(entry);
  return entry;
}
