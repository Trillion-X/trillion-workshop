// parts/ui/show/sound-signal/sound-signal.ts
//
// NO PRIOR: searched bitfield-packages show for getDisplayMedia, AnalyserNode, audio reactive, visualizer, beat detect, and 21st.dev 'audio reactive visualizer microphone background'
//   Found only single-recording loudness meters (record-video, screen-recording, ui/live-waveform) and one-page demos
//   (21st #2560 Music Reactive Hero Section, #7245 Neon Dither); none is a shared reading. The loudness scale is
//   live-waveform's (parts/ui/show/live-waveform/LiveWaveform.tsx loudness()).
//
// PURPOSE
//   One live reading of the sound around the person, shared by everything on the page that moves with it: a
//   background behind the panes, a card, the Ambience screen, the person's lights. A source (sound-sources.json) is
//   opened once, read by one Web Audio analyser, and every frame is handed to whoever listens: how loud it is (0..1),
//   how strong each band is (0..1, bands as DATA) and whether a beat just landed.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One reading per page: however many things move with the sound, the microphone or shared screen is opened
//      once and read once a frame. Starting another source stops the one before.
//   2. Nothing is heard until the person picks a source; a microphone already allowed is picked up again by itself
//      the next time something moves with it, a shared screen never is (the browser asks every time).
//   3. Frames only run while someone listens and the page is visible; nothing is kept or sent anywhere by this file.
//   4. Sources, bands and the beat rule are DATA (sound-sources.json); how a source is opened is the one map
//      OPENERS, keyed by the row's `opens`, because each is a different browser API.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import settings from './sound-sources.json';

export type SoundSource = { id: string; label: string; about: string; icon: string; opens: string };
export type SoundFrame = {
  /** How loud, 0..1, on the same scale every waveform in Trillion uses. */
  level: number;
  /** Each band's strength, 0..1, by the band's id in sound-sources.json. */
  bands: Record<string, number>;
  /** True on the frame a beat lands. */
  beat: boolean;
  /** True while a real source is being heard; false while things only breathe on their own. */
  heard: boolean;
  /** Seconds since the page started reading, for motion. */
  time: number;
};
export type SoundStatus = 'off' | 'asking' | 'listening' | 'refused' | 'unavailable';
export type SoundState = { status: SoundStatus; source: string | null; words: string | null };

export const soundSources = settings.sources as SoundSource[];
const BANDS = settings.bands as { id: string; from_hz: number; to_hz: number }[];
const BEAT = settings.beat;
const CHOSEN_KEY = 'trillion-sound-source';

type Opened = { stream: MediaStream | null; stop: () => void };
type Opener = (context: AudioContext, analyser: AnalyserNode) => Promise<Opened>;

const streamOpened = (context: AudioContext, analyser: AnalyserNode, stream: MediaStream): Opened => {
  const node = context.createMediaStreamSource(stream);
  node.connect(analyser);
  return { stream, stop: () => { node.disconnect(); stream.getTracks().forEach(track => track.stop()); } };
};

/** How each kind of source is opened: one browser API each. */
const OPENERS: Record<string, Opener> = {
  microphone: async (context, analyser) => streamOpened(context, analyser, await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true } })),
  'screen-sound': async (context, analyser) => {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } as MediaTrackConstraints });
    // Only the sound is read; the picture the browser insists on sharing is stopped at once.
    stream.getVideoTracks().forEach(track => track.stop());
    if (!stream.getAudioTracks().length) throw new Error('No sound was shared. Share again and turn on "Share audio".');
    return streamOpened(context, analyser, stream);
  },
  'page-media': async (context, analyser) => {
    const joined = new Map<HTMLMediaElement, AudioNode>();
    const join = (element: HTMLMediaElement) => {
      if (joined.has(element)) return;
      const capture = (element as HTMLMediaElement & { captureStream?: () => MediaStream }).captureStream;
      if (typeof capture !== 'function') return;
      const stream = capture.call(element);
      if (!stream.getAudioTracks().length) return;
      const node = context.createMediaStreamSource(stream);
      node.connect(analyser);
      joined.set(element, node);
    };
    const onPlay = (event: Event) => { if (event.target instanceof HTMLMediaElement) join(event.target); };
    document.querySelectorAll('video, audio').forEach(element => { if (!(element as HTMLMediaElement).paused) join(element as HTMLMediaElement); });
    document.addEventListener('play', onPlay, true);
    return { stream: null, stop: () => { document.removeEventListener('play', onPlay, true); joined.forEach(node => node.disconnect()); joined.clear(); } };
  },
};

let context: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let opened: Opened | null = null;
let state: SoundState = { status: 'off', source: null, words: null };
const stateListeners = new Set<(state: SoundState) => void>();
const frameListeners = new Set<(frame: SoundFrame) => void>();
let raf = 0;
const startedAt = typeof performance === 'undefined' ? 0 : performance.now();
let lowAverage = 0;
let lastBeatAt = 0;
let spectrum: Float32Array<ArrayBuffer> | null = null;
let samples: Float32Array<ArrayBuffer> | null = null;

const setState = (next: SoundState) => { state = next; stateListeners.forEach(listener => listener(state)); };
const clamp = (value: number) => Math.max(0, Math.min(1, value));

function audio(): { context: AudioContext; analyser: AnalyserNode } {
  if (!context || !analyser) {
    const Constructor = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    context = new Constructor();
    analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.55;
  }
  return { context, analyser };
}

/** One frame read from the analyser, or a gentle breath when nothing is heard. */
function read(): SoundFrame {
  const time = (performance.now() - startedAt) / 1000;
  if (!analyser || !context || state.status !== 'listening') {
    const breath = 0.18 + 0.1 * Math.sin(time * 0.9);
    return { level: breath, bands: Object.fromEntries(BANDS.map((band, index) => [band.id, clamp(breath + 0.06 * Math.sin(time * (0.7 + index * 0.4)))])), beat: false, heard: false, time };
  }
  spectrum ??= new Float32Array(analyser.frequencyBinCount);
  samples ??= new Float32Array(analyser.fftSize);
  analyser.getFloatFrequencyData(spectrum);
  analyser.getFloatTimeDomainData(samples);
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) sum += samples[index] * samples[index];
  // The loudness scale every waveform in Trillion uses (live-waveform): speech sits around -50 to -10 dB.
  const level = clamp((20 * Math.log10(Math.sqrt(sum / samples.length) || 1e-8) + 50) / 40);
  const hzPerBin = context.sampleRate / analyser.fftSize;
  const bands: Record<string, number> = {};
  for (const band of BANDS) {
    const from = Math.max(1, Math.floor(band.from_hz / hzPerBin));
    const to = Math.min(spectrum.length - 1, Math.ceil(band.to_hz / hzPerBin));
    let total = 0;
    for (let bin = from; bin <= to; bin += 1) total += clamp((spectrum[bin] + 95) / 65);
    bands[band.id] = to >= from ? total / (to - from + 1) : 0;
  }
  const low = bands[BEAT.band] ?? level;
  const now = performance.now();
  const beat = low > BEAT.least_level && low > lowAverage * BEAT.above_average && now - lastBeatAt > BEAT.rest_ms;
  if (beat) lastBeatAt = now;
  lowAverage += (low - lowAverage) / BEAT.average_over_frames;
  return { level, bands, beat, heard: level > settings.quiet_level, time };
}

function tick() {
  raf = 0;
  if (!frameListeners.size || document.hidden) return;
  const frame = read();
  frameListeners.forEach(listener => listener(frame));
  raf = requestAnimationFrame(tick);
}
const run = () => { if (!raf && frameListeners.size && !document.hidden) raf = requestAnimationFrame(tick); };
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', run);

/** Every frame while anything listens; returns how to stop listening. A microphone the person already allowed is
 *  picked up again by itself. */
export function onSoundFrame(listener: (frame: SoundFrame) => void): () => void {
  frameListeners.add(listener);
  run();
  if (state.status === 'off') void resumeChosen();
  return () => { frameListeners.delete(listener); };
}

export function onSoundState(listener: (state: SoundState) => void): () => void {
  stateListeners.add(listener);
  listener(state);
  return () => { stateListeners.delete(listener); };
}

export const soundState = () => state;

/** Start hearing one source (call it from a press: browsers only open sound after one). */
export async function listenTo(sourceId: string): Promise<SoundState> {
  const source = soundSources.find(row => row.id === sourceId);
  const opener = source && OPENERS[source.opens];
  if (!source || !opener) { setState({ status: 'unavailable', source: sourceId, words: 'This sound source cannot be opened here.' }); return state; }
  stopListening();
  setState({ status: 'asking', source: source.id, words: null });
  try {
    const { context: audioContext, analyser: node } = audio();
    if (audioContext.state === 'suspended') await audioContext.resume();
    opened = await opener(audioContext, node);
    opened.stream?.getAudioTracks().forEach(track => track.addEventListener('ended', () => { if (state.source === source.id) stopListening(); }));
    try { localStorage.setItem(CHOSEN_KEY, source.id); } catch { /* a private window keeps nothing */ }
    setState({ status: 'listening', source: source.id, words: null });
  } catch (error) {
    const refused = error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
    setState({ status: refused ? 'refused' : 'unavailable', source: source.id, words: refused ? 'Sound was not allowed. Allow it in your browser and try again.' : String((error as Error)?.message ?? error) });
  }
  run();
  return state;
}

export function stopListening() {
  opened?.stop();
  opened = null;
  if (state.status !== 'off') setState({ status: 'off', source: null, words: null });
}

/** The microphone the person chose before, opened again without asking when the browser still allows it. */
async function resumeChosen() {
  let chosen: string | null = null;
  try { chosen = localStorage.getItem(CHOSEN_KEY); } catch { return; }
  const source = soundSources.find(row => row.id === chosen);
  if (!source || source.opens !== 'microphone' || !navigator.permissions) return;
  const allowed = await navigator.permissions.query({ name: 'microphone' as PermissionName }).then(answer => answer.state === 'granted', () => false);
  if (!allowed || state.status !== 'off') return;
  const resumeOnPress = async () => { if (state.status === 'off') await listenTo(source.id); };
  // Audio only starts after a press anywhere on the page; the microphone itself needs no new answer.
  if (audio().context.state === 'running') await resumeOnPress();
  else document.addEventListener('pointerdown', () => void resumeOnPress(), { once: true, capture: true });
}
