// parts/record-audio/show/record-in-the-browser.ts
//
// PORTED FROM: parts/ui/show/composer/media-capture.ts and src/workspace/voice-capture.ts (Trillion's two browser
// recorders, merged here and deleted there), standing on record-audio's own pieces: the stream is asked for by each
// package's own opener (record-audio/show/browser-media-capture.ts, record-video/show/browser-media-capture.ts,
// screen-recording/do-work/browser-screen-capture.ts), recording time is record-audio/show/recording-lifecycle.ts, and
// a sound's level is record-video/show/silence-stop.ts.
//
// PURPOSE
//   The one recorder every Trillion screen uses (the message box, the Record screen with or without a script, a phone
//   in the browser): one recording from any source in ../read-data/capture-sources.json through MediaRecorder. Most
//   sources are opened by browser APIs; the Mac meeting source mixes a native ScreenCaptureKit stream with its selected
//   microphone before returning the same MediaStream shape. While it runs it reports the words heard (where it can) and a
//   problem in the person's words when one happens; stopping hands back one finished File named by the source's DATA.
//   It keeps nothing and sends nothing itself: each piece the browser makes is handed to the screen as it is made
//   (`onPiece`), so the screen can keep it on the device and send it on while the recording goes on, and the screen
//   that started it decides where the file goes.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The stream is opened by the source's `ask` entry in OPENERS; adding a way of asking is one entry there, never a
//      branch on a source id. The native Mac meeting adapter returns an ordinary MediaStream, so the same piece, pause,
//      stop, discard and device-persistence path handles it.
//   2. Recording never fails over a recording kind: the first of the source's `types` the browser says it can record
//      is tried, and when the browser then refuses it (when making the recorder or when starting it), the recording
//      starts again in the browser's own kind. Only a browser that cannot record at all is a problem.
//   3. Nothing is half-started: a recording that cannot start lets every track go and throws a RecordingProblem whose
//      `said` is plain words from the DATA (what happened and what to do).
//   4. A recording the browser stops by itself (a device unplugged, a screen share ended from the browser's bar, the
//      recorder failing) stops, keeps what it made, and says why; stopping a recording that already stopped hands back
//      what it made at once, so Done never waits forever.
//   5. The words never gate the recording: a browser without speech recognition, or one that stops hearing, still
//      records, and is told so in plain words. `final` only grows; `hearing` is the phrase still being heard.
//   6. A microphone that hears nothing for the DATA's quiet time is reported once, while the recording goes on. A sound
//      level that cannot be measured (the browser did not let the page listen) is unknown, never "silent".
//   7. Paused time is never counted in a recording's length; pausing holds both the sound and the words.
//   8. Every piece goes to `onPiece` in the order it was made, and the finished File is exactly those pieces in that
//      order, so a copy built from the pieces is the same bytes as the File. Pausing asks the browser for the piece
//      made so far, so everything recorded before a pause has been handed out.
//   9. A recording's microphone can be changed while it records (`openSwitchableMicrophone`, `feedMicrophone`): the new
//      one takes over at its first sound (or after the DATA's hand-over time) and only then is the old one let go, one
//      change at a time with the latest choice winning; a microphone that cannot be opened changes nothing. Stopping the
//      recording's sound track lets go of the microphone and the mix; the microphone ending by itself ends that track,
//      as before. A browser that cannot mix records the opened stream.

import { createChunker } from './live-audio-encoding';
import { createLiveStream } from './live-audio-stream';
import { createFailover, createLadder, pageStore } from './adaptation-ladder';
import sources from '../read-data/capture-sources.json';
import type { DevicePick } from '../../permission-lease/read-data/capability-permission';
import { activeDurationMs, beginActiveTime, pauseActiveTime, resumeActiveTime, type RecordingTiming } from './recording-lifecycle';
import { rootMeanSquare } from '../../record-video/show/silence-stop';
import { screenMediaStream, isScreenCaptureAvailable } from '../../screen-recording/do-work/browser-screen-capture';
import { holdWhileRecording, runPreflight } from '../read-data/capture-preflight.mjs';
import { endNativeSystemAudioTrack, listenToNativeSystemAudio, nativeStartMessage } from './native-system-audio-session.mjs';
import { CodeLoadFailure, loadCode } from '../../ui/show/load-later/load-code';

export type CaptureType = { media_type: string; extension: string };
export type CaptureSource = {
  id: string;
  label: string;
  icon: string;
  ask: string;
  device: string;
  check_quiet: boolean;
  /** Optional source-specific wording when the sound level stays quiet. */
  silent_problem?: string;
  /** Optional source-specific wording for an unavailable recording permission. */
  permission_problem?: string;
  /** false: never offered in a list of sources; recorded from only by a screen that names it. */
  listed?: boolean;
  preview: 'waveform' | 'video';
  mirrored: boolean;
  file_name: string;
  types: CaptureType[];
};
type Problems = Record<string, string>;

/** The sources as DATA, in the order they are offered (`listed: false` ones are not offered, only named). */
const ALL_SOURCES = sources.sources as CaptureSource[];
export const CAPTURE_SOURCES = ALL_SOURCES.filter(source => source.listed !== false);
const PROBLEMS = sources.problems as Problems;
const QUIET = sources.quiet;
const CHANGE = sources.microphone_change;

/** The source with this id. */
export const captureSource = (id: string) => ALL_SOURCES.find(source => source.id === id) ?? null;

// How the browser is asked for a stream, by the source's `ask`: each package's own opener. The microphone and camera
// openers carry their package's permission DATA, so they are fetched the first time a recording starts.
type CurrentCaptureRequest = () => boolean | Promise<boolean>;
type Opener = { available: () => boolean; open: (pick?: DevicePick, current?: CurrentCaptureRequest, signal?: AbortSignal) => Promise<MediaStream> };

/** Cancellation must settle even while an external owner has not answered. */
export function awaitCaptureOperation<T>(operation: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return Promise.resolve().then(operation);
  return new Promise((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(signal.reason ?? new DOMException('Recording cancelled.', 'AbortError')); };
    if (signal.aborted) { aborted(); return; }
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }).then(value => {
      signal.removeEventListener('abort', aborted); resolve(value);
    }, error => { signal.removeEventListener('abort', aborted); reject(error); });
  });
}
const mediaDevices = () => (typeof navigator === 'undefined' ? undefined : navigator.mediaDevices);
const canAskUser = () => typeof mediaDevices()?.getUserMedia === 'function';
type NativeSystemAudioCommand = 'system-audio-start' | 'system-audio-stop' | 'system-audio-cancel';
type NativeSystemAudioMessage = { command: NativeSystemAudioCommand; session_id: string; exclude_apps?: string[] };
type NativeSystemAudioBridge = { postMessage: (message: NativeSystemAudioMessage) => void };
type OwnedCaptureStream = MediaStream & { cancelNativeCapture?: () => void };
type NativeSystemAudioWindow = Window & {
  webkit?: { messageHandlers?: { trillionSystemAudio?: NativeSystemAudioBridge } };
};
const nativeSystemAudioBridge = (): NativeSystemAudioBridge | null => typeof window === 'undefined'
  ? null
  : (window as NativeSystemAudioWindow).webkit?.messageHandlers?.trillionSystemAudio ?? null;

// ---------------------------------------------------------------------------------------------------------------------
// The microphone of a running recording, which the person can change while it records (invariant 9).
//
// The recorder records a destination the microphone is fed into, not the microphone itself (the same mix the Mac meeting
// source makes): changing the microphone opens the new one, feeds it in at its first sound, and only then lets the old one go, so the
// recorder's stream never changes and every moment before and after the change is in the one recording.

/** The microphone of a running recording, which the person can change. '' is the device's default microphone. */
export type MicrophoneSwitch = {
  deviceId: () => string;
  /** Feeds the microphone `deviceId` into the recording in place of the one in use. */
  switchTo: (deviceId: string) => Promise<void>;
  subscribe: (listener: () => void) => () => void;
};

/** A recording's stream whose microphone can be changed while it records. */
export type SwitchingStream = MediaStream & { microphone?: MicrophoneSwitch };

type MicrophoneOpener = (pick?: DevicePick) => Promise<MediaStream>;
const pickOf = (deviceId: string): DevicePick | undefined => (deviceId ? { audio: deviceId } : undefined);
const releaseStream = (stream: MediaStream) => { for (const track of stream.getTracks()) track.stop(); };

/** Answers once `node` sends any sound, or after the DATA's hand-over time if it stays silent. */
function firstSound(context: AudioContext, node: AudioNode): Promise<void> {
  const listen = context.createAnalyser();
  node.connect(listen);
  const samples = new Float32Array(listen.fftSize);
  const until = Date.now() + CHANGE.hand_over_within_ms;
  return new Promise<void>(done => {
    const timer = setInterval(() => {
      listen.getFloatTimeDomainData(samples);
      if (samples.some(sample => sample !== 0) || Date.now() >= until) { clearInterval(timer); node.disconnect(listen); done(); }
    }, CHANGE.look_every_ms);
  });
}

/** Feeds `opened` (opened for `deviceId`) into `destination` and lets it be changed for another microphone. `lost` is
 *  called once when the microphone in use ends by itself. */
function feedMicrophone(context: AudioContext, destination: AudioNode, opened: MediaStream, deviceId: string,
  open: MicrophoneOpener, lost: () => void): MicrophoneSwitch & { stop: () => void } {
  const listeners = new Set<() => void>();
  let current = { stream: opened, node: context.createMediaStreamSource(opened), deviceId };
  let wanted = 0;
  let stopped = false;
  let changing: Promise<void> = Promise.resolve();
  const watch = (stream: MediaStream) => {
    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', () => { if (!stopped && current.stream === stream) lost(); }, { once: true });
    }
  };
  current.node.connect(destination);
  watch(opened);
  const switchTo = (next: string): Promise<void> => {
    const ask = ++wanted;
    changing = changing.catch(() => undefined).then(async () => {
      if (stopped || ask !== wanted || next === current.deviceId) return;
      const stream = await open(pickOf(next));
      if (stopped || ask !== wanted) { releaseStream(stream); return; }
      const node = context.createMediaStreamSource(stream);
      // The old microphone goes on until the new one sends its first sound, so the recording never holds silence the
      // person did not make (a phone's microphone opens a moment before it sends anything).
      await firstSound(context, node);
      if (stopped || ask !== wanted) { node.disconnect(); releaseStream(stream); return; }
      node.connect(destination);
      const last = current;
      current = { stream, node, deviceId: next };
      watch(stream);
      last.node.disconnect();
      releaseStream(last.stream);
      for (const listener of [...listeners]) listener();
    });
    return changing;
  };
  return {
    deviceId: () => current.deviceId,
    switchTo,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    stop: () => {
      if (stopped) return;
      stopped = true;
      current.node.disconnect();
      releaseStream(current.stream);
    },
  };
}

/** Opens the microphone `pick` names through `open` and answers the stream a recorder records, whose microphone the
 *  person can change while it records (its `microphone`). */
export async function openSwitchableMicrophone(open: MicrophoneOpener, pick?: DevicePick): Promise<SwitchingStream> {
  const opened = await open(pick);
  const Context = typeof window === 'undefined' ? undefined : window.AudioContext;
  if (typeof Context !== 'function' || !opened.getAudioTracks().length) return opened;
  const context = new Context({ latencyHint: 'interactive' });
  const destination = context.createMediaStreamDestination();
  const sound = destination.stream.getAudioTracks()[0];
  const stopSound = sound.stop.bind(sound);
  let fed: ReturnType<typeof feedMicrophone>;
  try {
    fed = feedMicrophone(context, destination, opened, typeof pick?.audio === 'string' ? pick.audio : '', open, () => {
      // An ended track does not say so when stopped locally, so the recorder is told first.
      sound.dispatchEvent(new Event('ended'));
      sound.stop();
    });
    await context.resume();
  } catch (error) {
    releaseStream(opened);
    void context.close().catch(() => {});
    throw error;
  }
  sound.stop = () => { fed.stop(); stopSound(); void context.close().catch(() => {}); };
  const stream: SwitchingStream = new MediaStream([sound, ...opened.getVideoTracks()]);
  stream.microphone = { deviceId: fed.deviceId, switchTo: fed.switchTo, subscribe: fed.subscribe };
  return stream;
}

// Code can arrive after a capture request was cancelled. Check the original request again before asking for a device.
async function openMediaCode(load: () => Promise<(mode: 'audio' | 'video', pick?: DevicePick) => Promise<MediaStream>>, mode: 'audio' | 'video', pick?: DevicePick, current: CurrentCaptureRequest = () => true, signal?: AbortSignal): Promise<MediaStream> {
  const open = await awaitCaptureOperation(load, signal);
  if (!await awaitCaptureOperation(current, signal)) throw Object.assign(new Error('This recording request has ended.'), { name: 'AbortError' });
  return open(mode, pick);
}
const audioCode = () => loadCode(() => import('./browser-media-capture'), module => module.mediaStreamForMode);
const videoCode = () => loadCode(() => import('../../record-video/show/browser-media-capture'), module => module.mediaStreamForMode);

/** Mixes the Mac's ScreenCaptureKit output with its microphone into a normal MediaStream. */
async function openNativeMeetingAudio(pick?: DevicePick, current: CurrentCaptureRequest = () => true, signal?: AbortSignal): Promise<MediaStream> {
  const bridge = nativeSystemAudioBridge();
  if (!bridge) throw Object.assign(new Error('Open this recording in Trillion for Mac.'), { name: 'system-audio-unavailable' });
  const mic = await openMediaCode(audioCode, 'audio', pick, current, signal);
  let cancelOpening = () => mic.getTracks().forEach(track => track.stop());
  const onAbort = () => cancelOpening();
  signal?.addEventListener('abort', onAbort, { once: true });
  const requireCurrent = async () => {
    if (await awaitCaptureOperation(current, signal)) return;
    mic.getTracks().forEach(track => track.stop());
    throw Object.assign(new Error('This recording request has ended.'), { name: 'AbortError' });
  };
  try { await requireCurrent(); }
  catch (error) { signal?.removeEventListener('abort', onAbort); mic.getTracks().forEach(track => track.stop()); throw error; }
  const AudioContextType = globalThis.AudioContext;
  if (typeof AudioContextType !== 'function') {
    signal?.removeEventListener('abort', onAbort);
    mic.getTracks().forEach(track => track.stop());
    throw Object.assign(new Error('This Mac cannot mix meeting audio in this window.'), { name: 'system-audio-unavailable' });
  }
  const context = new AudioContextType({ latencyHint: 'interactive' });
  let destination: MediaStreamAudioDestinationNode;
  // The microphone in the mix, which the person can change while the meeting records; it lets go of whichever one is in use.
  let microphone: ReturnType<typeof feedMicrophone> | null = null;
  const releaseMicrophone = () => { if (microphone) microphone.stop(); else mic.getTracks().forEach(track => track.stop()); };
  try {
    destination = context.createMediaStreamDestination();
    microphone = feedMicrophone(context, destination, mic, typeof pick?.audio === 'string' ? pick.audio : '',
      next => openMediaCode(audioCode, 'audio', next, current, signal), () => {});
    await context.resume();
    await requireCurrent();
  } catch (error) {
    signal?.removeEventListener('abort', onAbort);
    releaseMicrophone();
    void context.close().catch(() => {});
    throw error;
  }

  const sessionID = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let closed = false;
  let failed = false;
  let nextAt = context.currentTime + 0.06;
  const stream = destination.stream;
  const track = stream.getAudioTracks()[0];
  if (!track) {
    signal?.removeEventListener('abort', onAbort);
    releaseMicrophone();
    void context.close().catch(() => {});
    throw Object.assign(new Error('The meeting audio stream could not be opened.'), { name: 'system-audio-unavailable' });
  }
  const stopMixedTrack = track.stop.bind(track);
  let handleNativeFailure = () => {};
  const onNativeAudio = (detail: { pcm16?: string; sample_rate?: number }) => {
    if (closed) return;
    if (detail.pcm16 && detail.sample_rate) {
      try {
        const binary = atob(detail.pcm16);
        const samples = binary.length / 2;
        if (!samples || !Number.isInteger(samples)) return;
        const buffer = context.createBuffer(1, samples, detail.sample_rate);
        const channel = buffer.getChannelData(0);
        for (let index = 0; index < samples; index += 1) {
          const value = binary.charCodeAt(index * 2) | (binary.charCodeAt(index * 2 + 1) << 8);
          channel[index] = (value & 0x8000 ? value - 0x10000 : value) / 32768;
        }
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(destination);
        const starts = Math.max(nextAt, context.currentTime + 0.02);
        source.start(starts);
        nextAt = starts + buffer.duration;
      } catch { /* A malformed native chunk is ignored; capture failure is reported by the native error event. */ }
    }
  };
  let resolveStart!: () => void;
  let rejectStart!: (error: Error) => void;
  let started = false;
  const startedPromise = new Promise<void>((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
  const timeout = window.setTimeout(() => rejectStart(Object.assign(new Error('System audio capture did not start.'), { name: 'system-audio-unavailable' })), 20_000);
  const onStarted = () => {
    if (closed) return;
    started = true;
    window.clearTimeout(timeout);
    resolveStart();
  };
  const stopListening = listenToNativeSystemAudio(window, sessionID, {
    audio: onNativeAudio,
    started: onStarted,
    failure: detail => {
      if (!started) rejectStart(Object.assign(new Error(detail.kind ?? 'system-audio-unavailable'), { name: detail.kind ?? 'system-audio-unavailable' }));
      else handleNativeFailure();
    },
  });

  const closeCapture = (nativeStopped = false, command: NativeSystemAudioCommand = 'system-audio-stop') => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener('abort', onAbort);
    window.clearTimeout(timeout);
    stopListening();
    if (!nativeStopped) bridge.postMessage({ command, session_id: sessionID });
    releaseMicrophone();
    void context.close().catch(() => {});
  };
  cancelOpening = () => { closeCapture(); stopMixedTrack(); };
  handleNativeFailure = () => {
    if (failed || closed) return;
    failed = true;
    closeCapture(true);
    // Local stop() does not emit `ended`, so notify the shared recorder first.
    endNativeSystemAudioTrack({ dispatchEvent: event => track.dispatchEvent(event), stop: stopMixedTrack });
  };
  track.stop = () => { closeCapture(); stopMixedTrack(); };
  try {
    await requireCurrent();
    bridge.postMessage(nativeStartMessage(sessionID, (sources.sources as Array<{ ask: string; exclude_apps?: string[] }>).find(row => row.ask === 'native-system-audio')));
    await awaitCaptureOperation(() => startedPromise, signal);
    await requireCurrent();
    if (failed) throw Object.assign(new Error('System audio stopped while it was opening.'), { name: 'system-audio-ended' });
  } catch (error) {
    closeCapture();
    throw error;
  } finally { window.clearTimeout(timeout); }

  (stream as OwnedCaptureStream).cancelNativeCapture = () => closeCapture(false, 'system-audio-cancel');
  const { deviceId, switchTo, subscribe } = microphone;
  (stream as SwitchingStream).microphone = { deviceId, switchTo, subscribe };
  return stream;
}

export const OPENERS: Record<string, Opener> = {
  'record-audio': { available: canAskUser, open: (pick, current, signal) => openMediaCode(audioCode, 'audio', pick, current, signal) },
  'record-video': { available: canAskUser, open: (pick, current, signal) => openMediaCode(videoCode, 'video', pick, current, signal) },
  'screen-recording': { available: () => isScreenCaptureAvailable(), open: () => screenMediaStream({ video: true, audio: true }) },
  'native-system-audio': { available: () => canAskUser() && nativeSystemAudioBridge() !== null, open: openNativeMeetingAudio },
};

/** Whether this browser can record from `source` at all. */
export const canCapture = (source: CaptureSource) => typeof MediaRecorder !== 'undefined' && Boolean(OPENERS[source.ask]?.available());

/** A recording that cannot start, or stopped by itself: `said` is what the person is told. */
export class RecordingProblem extends Error {
  readonly kind: string;
  readonly said: string;
  constructor(kind: string, source: CaptureSource, cause?: unknown) {
    const custom = kind === 'silent' ? source.silent_problem
      : kind === 'NotAllowedError' ? source.permission_problem : undefined;
    const said = (custom ?? PROBLEMS[kind] ?? PROBLEMS.default).replaceAll('{device}', source.device);
    super(said);
    this.name = 'RecordingProblem';
    this.kind = kind;
    this.said = said;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/** The browser's name for what went wrong: its own error name, looked through the permission lease's wrapping. */
export function problemKind(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    if (current instanceof CodeLoadFailure) return current.reason === 'replaced' ? 'page-updated' : current.reason === 'unreached' ? 'code-unreached' : 'code-unavailable';
    const name = (current as { name?: unknown }).name;
    const message = (current as { message?: unknown }).message;
    if (name === 'TypeError' && typeof message === 'string' &&
        /(?:dynamically imported module|module script failed|module.*fetch.*failed)/i.test(message)) return 'page-updated';
    if (name === 'CapabilityPermissionDeniedError') return 'NotAllowedError';
    if (name === 'CapabilityPermissionUnavailableError') return 'unavailable';
    if (name === 'RecordingProblem') return (current as RecordingProblem).kind;
    if (typeof name === 'string' && name in PROBLEMS) return name;
    current = (current as { cause?: unknown }).cause;
  }
  return 'default';
}

/** What the person is told about `error` while recording from `source`. */
export const problemWords = (error: unknown, source: CaptureSource) => (error instanceof RecordingProblem ? error.said : new RecordingProblem(problemKind(error), source, error).said);

/** The moment a thing was made, as it goes into a file name: 2026-09-29 14.03.12. */
export function momentName(at: Date) {
  const two = (value: number) => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}.${two(at.getMinutes())}.${two(at.getSeconds())}`;
}

/** The file ending for what the browser actually recorded, from the source's kinds; else the kind's own name. */
export function extensionOf(source: CaptureSource, mediaType: string) {
  const base = mediaType.split(';')[0].trim();
  return source.types.find(type => type.media_type.split(';')[0] === base)?.extension ?? (base.split('/')[1] || 'webm');
}

/** Opens the source's stream, for a picture shown before recording starts (a camera) or for a recording. */
export async function openSource(source: CaptureSource, pick?: DevicePick, current: CurrentCaptureRequest = () => true, signal?: AbortSignal): Promise<MediaStream> {
  const opener = OPENERS[source.ask];
  if (!opener?.available() || typeof MediaRecorder === 'undefined') throw new RecordingProblem('unavailable', source);
  try {
    if (!await awaitCaptureOperation(current, signal)) throw Object.assign(new Error('This recording request has ended.'), { name: 'AbortError' });
    const stream = await opener.open(pick, current, signal);
    let allowed = false;
    try { allowed = await awaitCaptureOperation(current, signal); }
    catch (error) {
      (stream as OwnedCaptureStream).cancelNativeCapture?.();
      stream.getTracks().forEach(track => track.stop());
      throw error;
    }
    if (!allowed) {
      (stream as OwnedCaptureStream).cancelNativeCapture?.();
      stream.getTracks().forEach(track => track.stop());
      throw Object.assign(new Error('This recording request has ended.'), { name: 'AbortError' });
    }
    return stream;
  }
  catch (error) { throw new RecordingProblem(problemKind(error), source, error); }
}

// ---------------------------------------------------------------------------------------------------------------------
// The words heard while recording (speech recognition, where the browser has it).

/** What a capture reports while it runs. */
export type Heard = { final: string; hearing: string };
type RecognitionResult = { isFinal: boolean; 0: { transcript: string } };
type RecognitionEvent = { resultIndex: number; results: ArrayLike<RecognitionResult> };
type Recognition = {
  continuous: boolean; interimResults: boolean; lang: string;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: (audioTrack?: MediaStreamTrack) => void; stop: () => void; abort: () => void;
};
type RecognitionConstructor = new () => Recognition;

function speechRecognition(): RecognitionConstructor | null {
  const scope = globalThis as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

type NativeSpeechMessage = { command: 'start' | 'stop' } | { command: 'audio'; sample_rate: number; pcm16: string };
function nativeSpeechBridge(): { postMessage: (message: NativeSpeechMessage) => void } | null {
  if (typeof window === 'undefined') return null;
  const host = window as Window & { webkit?: { messageHandlers?: { trillionSpeech?: { postMessage: (message: NativeSpeechMessage) => void } } } };
  return host.webkit?.messageHandlers?.trillionSpeech ?? null;
}

export const hasNativeSpeechBridge = () => nativeSpeechBridge() !== null;

/** Whether this browser can show the words as they are said. */
export const canShowWords = () => typeof WebSocket !== 'undefined' || nativeSpeechBridge() !== null || speechRecognition() !== null;

// The iPhone and Mac carriers feed recognition from the recorder’s already-open
// microphone stream, so the chosen input supplies both the recording and words.
function nativeSpeechUsesPCM(): boolean {
  return typeof window !== 'undefined'
    && (window as Window & { __trillionSpeechAudioInput?: string }).__trillionSpeechAudioInput === 'pcm';
}

// Why the words stopped, in the person's words, for the reasons a browser gives.
const NOT_ALLOWED = 'Your browser did not allow Trillion to hear the words, so they will not show here. Your recording still saves, and your AI reads it.';
const NO_WORDS = 'This browser cannot show your words as you speak. Your recording still saves, and your AI reads it.';
const STOPPED = 'Your words stopped showing here. Your recording goes on and still saves.';
// A recognizer that cannot reach its speech service ('network') stops for good too, so it never restarts in a loop.
const FATAL_ERRORS = new Set(['not-allowed', 'service-not-allowed', 'language-not-supported', 'audio-capture', 'network']);

export type Listener = { pause: () => void; resume: () => void; stop: () => void; abort: () => void; codecLine?: () => string };

/** The browser sends only the selected recorder stream to Trillion's signed-in live speech route. */
function streamSpeech(recording: () => boolean, stream: MediaStream, context: AudioContext,
  onHeard: (heard: Heard) => void, onWordsUnavailable: (reason: string) => void): Listener {
  const input = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  const chunker = createChunker(4096);
  const silent = context.createGain();
  silent.gain.value = 0;
  let active = true;
  let listening = true;
  let final = '';
  let latest = '';
  let socket: WebSocket | null = null;
  let lastEndedTurn = -1;
  let codecLine = '';
  // Numbered chunks kept for replay, a lost connection replaced and caught up, a repeated line shown once, and the codec row said (live-audio-stream.ts).
  const live = createLiveStream({
    open: () => open(), isOpen: opened => opened.readyState === WebSocket.OPEN, chunkSeconds: 4096 / context.sampleRate,
    conditions: { browserHasOpus: typeof AudioEncoder !== 'undefined', routeAcceptsOpus: false, layerFlag: false, layerModelReady: false, rung: 0 },
    onLine: line => { codecLine = line; },
  });
  // A bad connection steps the stream down a rung and a good one back up; an endpoint that just failed is left alone for a while (adaptation-ladder.ts).
  const ladder = createLadder(change => live.setRung(change.rung));
  const failover = createFailover(pageStore());
  let told = false;
  const unavailable = () => { if (!told) { told = true; onWordsUnavailable(STOPPED); } };
  const show = () => onHeard({ final, hearing: latest });
  const settle = () => {
    if (latest) final = [final, latest].filter(Boolean).join(' ');
    latest = '';
    show();
  };
  const open = () => {
    const endpoint = failover.pick(Date.now());
    const address = new URL(endpoint.path, window.location.href);
    address.protocol = address.protocol === 'https:' ? 'wss:' : 'ws:';
    address.searchParams.set('sample_rate', String(context.sampleRate));
    const opened = new WebSocket(address.href);
    socket = opened;
    lastEndedTurn = -1;
    opened.onmessage = event => {
      if (!active || !listening || socket !== opened || !recording() || typeof event.data !== 'string') return;
      let value: { event?: string; transcript?: string; turn_index?: number };
      try { value = JSON.parse(event.data); } catch { return; }
      if (!value || typeof value !== 'object') return;
      const transcript = typeof value.transcript === 'string' ? value.transcript.trim() : '';
      if (value.event === 'StartOfTurn') { latest = transcript; show(); }
      else if (value.event === 'Update' || value.event === 'EagerEndOfTurn' || value.event === 'TurnResumed') {
        latest = transcript;
        show();
      } else if (value.event === 'EndOfTurn') {
        if (typeof value.turn_index === 'number' && value.turn_index === lastEndedTurn) return;
        if (typeof value.turn_index === 'number') lastEndedTurn = value.turn_index;
        latest = transcript || latest;
        if (live.heard({ event: 'EndOfTurn', transcript })) settle(); else latest = '';
      }
      if (value.event === 'StartOfTurn') live.heard({ event: 'StartOfTurn' });
    };
    opened.onerror = () => {};
    opened.onclose = () => { if (active && listening && socket === opened) { failover.failed(endpoint.id, Date.now()); ladder.observe({ lost: true }); live.lost(unavailable); } };
    return opened;
  };
  const connect = () => { live.connect(); };
  processor.onaudioprocess = event => {
    if (!active || !listening || !recording()) return;
    ladder.observe({ backlog: socket?.bufferedAmount ?? 0 });
    if (socket && socket.bufferedAmount > 1_000_000) return;
    for (const chunk of chunker.push(event.inputBuffer.getChannelData(0))) live.push(chunk);
  };
  input.connect(processor);
  processor.connect(silent);
  silent.connect(context.destination);
  try { connect(); } catch { unavailable(); }
  const close = () => {
    live.close();
    socket?.close();
    socket = null;
  };
  const stop = (keepWords: boolean) => {
    if (!active) return;
    if (keepWords) settle();
    active = false;
    processor.onaudioprocess = null;
    input.disconnect();
    processor.disconnect();
    silent.disconnect();
    close();
  };
  return {
    pause: () => { listening = false; settle(); close(); },
    resume: () => { if (active && recording()) { listening = true; told = false; try { connect(); } catch { unavailable(); } } },
    stop: () => stop(true),
    abort: () => stop(false),
    codecLine: () => codecLine,
  };
}

/** Hears the words while `recording()` holds; reports them and why they stopped. Any screen that records may use it. */
export function listen(recording: () => boolean, stream: MediaStream, context: AudioContext | null,
  onHeard: (heard: Heard) => void, onWordsUnavailable: (reason: string) => void): Listener {
  // The signed-in live words route hears the same selected stream on web,
  // iPhone, and Mac. Keep native recognition where the socket API is absent.
  if (context && typeof WebSocket !== 'undefined') return streamSpeech(recording, stream, context, onHeard, onWordsUnavailable);
  const native = nativeSpeechBridge();
  if (native) {
    let active = true;
    let listening = true;
    let prefix = '';
    let latest = '';
    let confirmed = '';
    const onEvent = (event: Event) => {
      if (!active || !listening) return;
      const detail = (event as CustomEvent<{ event: string; text: string; is_final?: boolean }>).detail;
      if (detail?.event === 'words') {
        latest = detail.text.trim();
        if (detail.is_final !== false) confirmed = latest;
        const hearing = detail.is_final === false
          ? (latest.startsWith(confirmed) ? latest.slice(confirmed.length).trim() : latest)
          : '';
        onHeard({ final: [prefix, confirmed].filter(Boolean).join(' '), hearing });
      } else if (detail?.event === 'error') {
        onWordsUnavailable(detail.text || STOPPED);
      }
    };
    window.addEventListener('trillion-native-speech', onEvent);
    let disconnectAudio = () => {};
    if (nativeSpeechUsesPCM()) {
      if (!context || typeof context.createScriptProcessor !== 'function') {
        window.removeEventListener('trillion-native-speech', onEvent);
        onWordsUnavailable(NO_WORDS);
        return { pause() {}, resume() {}, stop() {}, abort() {} };
      }
      const input = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const silent = context.createGain();
      silent.gain.value = 0;
      processor.onaudioprocess = event => {
        if (!active || !listening || !recording()) return;
        const samples = event.inputBuffer.getChannelData(0);
        const pcm = new Int16Array(samples.length);
        for (let index = 0; index < samples.length; index += 1) {
          pcm[index] = Math.max(-32768, Math.min(32767, Math.round(samples[index] * 32767)));
        }
        const bytes = new Uint8Array(pcm.buffer);
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        native.postMessage({ command: 'audio', sample_rate: context.sampleRate, pcm16: btoa(binary) });
      };
      input.connect(processor);
      processor.connect(silent);
      silent.connect(context.destination);
      disconnectAudio = () => {
        processor.onaudioprocess = null;
        input.disconnect();
        processor.disconnect();
        silent.disconnect();
      };
    }
    native.postMessage({ command: 'start' });
    const stop = () => { native.postMessage({ command: 'stop' }); };
    const close = () => {
      if (!active) return;
      active = false;
      disconnectAudio();
      stop();
      window.removeEventListener('trillion-native-speech', onEvent);
    };
    return {
      pause: () => { listening = false; prefix = [prefix, latest].filter(Boolean).join(' '); latest = ''; confirmed = ''; stop(); },
      resume: () => { if (active && recording()) { listening = true; native.postMessage({ command: 'start' }); } },
      stop: close,
      abort: close,
    };
  }
  const Recognizer = speechRecognition();
  if (!Recognizer) { onWordsUnavailable(NO_WORDS); return { pause() {}, resume() {}, stop() {}, abort() {} }; }
  let running = true;
  let listening = true;
  let recognizing = false;
  let final = '';
  let sessionFinal = '';
  // A recognizer the browser cannot make (no speech service) leaves the recording going without words.
  let recognition: Recognition | null;
  try { recognition = new Recognizer(); } catch { onWordsUnavailable(NO_WORDS); return { pause() {}, resume() {}, stop() {}, abort() {} }; }
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = navigator.language;
  // Browsers with the audio-track form of Web Speech hear the exact microphone
  // the person selected for recording. Older browsers ignore the extra argument.
  const audioTrack = stream.getAudioTracks()[0];
  let acceptsTrack = true;
  const startRecognition = () => {
    try {
      recognition?.start(acceptsTrack ? audioTrack : undefined);
      recognizing = true;
      return true;
    } catch (error) {
      // Keep browser speech available when a recognizer has not implemented
      // the audio-track overload yet.
      const name = error instanceof Error ? error.name : '';
      if (acceptsTrack && (error instanceof TypeError || name === 'NotSupportedError')) {
        acceptsTrack = false;
        try { recognition?.start(); recognizing = true; return true; } catch { /* unavailable */ }
      }
      return false;
    }
  };
  const hear = () => { if (!startRecognition()) onWordsUnavailable(STOPPED); };
  recognition.onresult = event => {
    if (!running || !listening || !recording()) return;
    const settled: string[] = [];
    let hearing = '';
    // Web Speech returns the complete results list for this recognition session.
    // Reading only from resultIndex and appending repeats settled words when an
    // earlier result changes or the browser sends another interim result.
    for (let index = 0; index < event.results.length; index += 1) {
      const result = event.results[index];
      const words = result[0].transcript.trim();
      if (!words) continue;
      if (result.isFinal) settled.push(words);
      else hearing = hearing ? `${hearing} ${words}` : words;
    }
    sessionFinal = settled.join(' ');
    onHeard({ final: [final, sessionFinal].filter(Boolean).join(' '), hearing });
  };
  recognition.onerror = event => {
    if (!FATAL_ERRORS.has(event.error)) return;
    running = false;
    onWordsUnavailable(event.error === 'audio-capture' || event.error === 'network' ? STOPPED : NOT_ALLOWED);
  };
  recognition.onend = () => {
    recognizing = false;
    final = [final, sessionFinal].filter(Boolean).join(' ');
    sessionFinal = '';
    if (running && listening && recording()) hear();
  };
  if (!startRecognition()) { recognition.abort(); recognition = null; onWordsUnavailable(NO_WORDS); }
  return {
    pause: () => { listening = false; recognition?.stop(); },
    // Still ending from the pause: its end starts it again.
    resume: () => { listening = true; if (running && recognition && !recognizing) hear(); },
    stop: () => { running = false; recognition?.stop(); },
    abort: () => { running = false; recognition?.abort(); },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Whether the microphone hears anything.

type QuietWatch = { heardSpeech: () => void; stop: () => void };
type AudioContextConstructor = typeof AudioContext;
const audioContextConstructor = (): AudioContextConstructor | null => {
  if (typeof window === 'undefined') return null;
  const scope = window as Window & { webkitAudioContext?: AudioContextConstructor };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
};

/** Made and resumed inside the press that starts a recording, so the browser lets the page listen. */
export function listeningContext(): AudioContext | null {
  const Constructor = audioContextConstructor();
  if (!Constructor) return null;
  try {
    const context = new Constructor();
    void context.resume().catch(() => {});
    return context;
  } catch { return null; }
}

/** Warns when no sound has reached the microphone since recording began. Once sound or speech is heard, silence is
 *  an ordinary pause in speaking, not evidence that the microphone is unavailable. */
function watchQuiet(context: AudioContext | null, stream: MediaStream, recording: () => boolean, onQuiet: () => void, onRecovered: () => void): QuietWatch {
  if (!context || !stream.getAudioTracks().length) { void context?.close().catch(() => {}); return { heardSpeech() {}, stop() {} }; }
  const STEP = 250;
  const analyser = context.createAnalyser();
  // Each read covers at least the time since the last one, so a short sound between reads is never missed: a 43 ms
  // window read every 250 ms heard nothing of a sound shorter than the gap (Chromium's test microphone beeps 20 ms
  // every 500 ms, always in the same gap) and told a working microphone it was silent.
  analyser.fftSize = Math.min(32768, 2 ** Math.ceil(Math.log2((context.sampleRate * STEP) / 1000)));
  const input = context.createMediaStreamSource(stream);
  input.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  let quietMs = 0;
  let told = false;
  let heard = false;
  const recovered = () => { heard = true; quietMs = 0; if (told) { told = false; onRecovered(); } };
  const timer = setInterval(() => {
    // Not measured (the page may not listen yet, or the recording is paused): unknown, never counted as quiet.
    if (heard || context.state !== 'running' || !recording()) return;
    analyser.getFloatTimeDomainData(samples);
    if (rootMeanSquare(samples) >= QUIET.heard_level) recovered();
    else quietMs += STEP;
    if (!told && quietMs >= QUIET.after_ms) { told = true; onQuiet(); }
  }, STEP);
  return { heardSpeech: recovered, stop: () => { clearInterval(timer); input.disconnect(); void context.close().catch(() => {}); } };
}

// ---------------------------------------------------------------------------------------------------------------------
// The recording.

export type CaptureEvents = {
  /** A stream already open for this source (a camera showing its picture); it is the recording's from here on. */
  stream?: MediaStream;
  /** A microphone chosen from the browser's available inputs; the default is used when absent. */
  audioDeviceId?: string;
  /** Hear the words as they are said (only where the source has sound). */
  onHeard?: (heard: Heard) => void;
  /** Speech recognition is not available (or stopped being available): the recording goes on without words. */
  onWordsUnavailable?: (reason: string) => void;
  /** Something the person should know while it runs (the microphone hears nothing), in their words. */
  onProblem?: (said: string) => void;
  /** Sound returned after a quiet warning; the screen may clear that warning. */
  onQuietRecovered?: () => void;
  /** The browser stopped the recording by itself: what it made, and why in the person's words. */
  onEnded?: (recorded: Recorded, said: string) => void;
  /** Each piece of the recording as the browser makes it, in order (about one a second, and one at each pause). */
  onPiece?: (piece: Blob) => void;
};
export type Recorded = { file: File; seconds: number };
export type Capture = {
  source: CaptureSource;
  stream: MediaStream;
  startedAt: Date;
  /** The kind of recording the browser is making (its media type, without parameters). */
  mediaType: string;
  /** The file name the finished recording gets. */
  fileName: string;
  elapsedMs: () => number;
  paused: () => boolean;
  pause: () => void;
  resume: () => void;
  /** Everything recorded so far as one piece of sound, while the recording goes on or is paused. */
  soFar: () => Promise<Blob>;
  /** Stops and hands back the finished file. */
  stop: () => Promise<Recorded>;
  /** Stops and keeps nothing. */
  discard: () => void;
};

/** Makes a recorder that the browser will start: the first kind it says it can record, else its own kind. */
function startRecorder(stream: MediaStream, source: CaptureSource): { recorder: MediaRecorder; chosen: CaptureType | null } {
  const chosen = source.types.find(type => MediaRecorder.isTypeSupported(type.media_type)) ?? null;
  const attempts: Array<MediaRecorderOptions | undefined> = chosen ? [{ mimeType: chosen.media_type }, undefined] : [undefined];
  let refusal: unknown = null;
  for (const options of attempts) {
    let recorder: MediaRecorder | null = null;
    try {
      recorder = new MediaRecorder(stream, options);
      recorder.start(1000);
      return { recorder, chosen: options ? chosen : null };
    } catch (error) {
      refusal = error;
      try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch { /* never started */ }
    }
  }
  throw new RecordingProblem('NotSupportedError', source, refusal);
}

type BatteryManager = { level: number; charging: boolean };
type DeviceNavigator = Navigator & { getBattery?: () => Promise<BatteryManager>; wakeLock?: { request: (kind: 'screen') => Promise<{ release: () => Promise<void> }> } };
/** The facts about this device that capture-preflight.json's checks read; a fact the browser cannot give is null. */
const deviceFacts = () => {
  const device = navigator as DeviceNavigator;
  const battery = () => (device.getBattery ? device.getBattery() : Promise.resolve(null));
  return {
    storage_free_bytes: async () => { const found = await navigator.storage?.estimate?.(); return found?.quota != null && found.usage != null ? found.quota - found.usage : null; },
    battery_level: async () => (await battery())?.level ?? null,
    battery_charging: async () => (await battery())?.charging ?? null,
  };
};
const deviceHolders = () => {
  const device = navigator as DeviceNavigator;
  return { wake_lock: async () => { const lock = await device.wakeLock?.request('screen'); return lock ? () => lock.release() : null; } };
};

/** Asks for the source's stream (unless one is handed in) and starts recording it. Throws a RecordingProblem. */
export async function startCapture(source: CaptureSource, events: CaptureEvents = {}): Promise<Capture> {
  // Made inside the press, before anything is awaited, so the browser lets the page listen to the sound.
  const context = (source.check_quiet && events.onProblem) || events.onHeard || nativeSpeechUsesPCM() ? listeningContext() : null;
  // A recording that cannot succeed is stopped before the person has said anything; one that probably will not only warns.
  const checked = await runPreflight(deviceFacts());
  if (checked.blocking.length) { void context?.close().catch(() => {}); throw new RecordingProblem(checked.blocking[0].problem, source); }
  for (const warning of checked.warnings) events.onProblem?.(new RecordingProblem(warning.problem, source).said);
  let stream: MediaStream;
  try { stream = events.stream ?? await openSource(source, events.audioDeviceId ? { audio: events.audioDeviceId } : undefined); }
  catch (error) { void context?.close().catch(() => {}); throw error; }
  let releaseHeld: (() => void) | null = null;
  const release = (cancel = false) => {
    if (cancel) (stream as OwnedCaptureStream).cancelNativeCapture?.();
    for (const track of stream.getTracks()) track.stop();
    releaseHeld?.();
  };
  let made: { recorder: MediaRecorder; chosen: CaptureType | null };
  try { made = startRecorder(stream, source); }
  catch (error) { release(); void context?.close().catch(() => {}); throw error; }
  const { recorder, chosen } = made;
  releaseHeld = await holdWhileRecording(deviceHolders());

  const pieces: Blob[] = [];
  recorder.ondataavailable = event => { if (event.data.size) { pieces.push(event.data); events.onPiece?.(event.data); } };
  const startedAt = new Date();
  const recordedType = recorder.mimeType || chosen?.media_type || source.types[0]?.media_type || 'application/octet-stream';
  const mediaType = recordedType.split(';')[0];
  const fileName = `${source.file_name.replace('{when}', momentName(startedAt))}.${extensionOf(source, recordedType)}`;
  let timing: RecordingTiming = beginActiveTime(Date.now());
  const elapsedMs = () => activeDurationMs(timing, Date.now());
  const recording = () => recorder.state === 'recording';
  const quiet = watchQuiet(context, stream, recording, () => events.onProblem?.(new RecordingProblem('silent', source).said), () => events.onQuietRecovered?.());
  const words = stream.getAudioTracks().length && (events.onHeard || events.onWordsUnavailable)
    ? listen(recording, stream, context, heard => { if (heard.final.trim() || heard.hearing.trim()) quiet.heardSpeech(); events.onHeard?.(heard); }, events.onWordsUnavailable ?? (() => {}))
    : null;

  let finished: Promise<Recorded> | null = null;
  let kept = true;
  // Whether the recorder has finished handing over its last piece (its `stop` event), however it was stopped.
  let stopped = false;
  recorder.addEventListener('stop', () => { stopped = true; }, { once: true });
  const finish = (): Recorded => {
    words?.abort(); quiet.stop(); release();
    return { file: new File(pieces, fileName, { type: mediaType, lastModified: Date.now() }), seconds: elapsedMs() / 1000 };
  };
  const stop = () => {
    if (finished) return finished;
    timing = pauseActiveTime(timing, Date.now());
    words?.stop();
    finished = new Promise<Recorded>(done => {
      if (stopped) { done(finish()); return; }
      // Stopped already but its last piece is still coming: its `stop` event finishes it.
      recorder.addEventListener('stop', () => done(finish()), { once: true });
      if (recorder.state === 'inactive') return;
      try { recorder.stop(); } catch { done(finish()); }
    });
    return finished;
  };
  // The browser stopping by itself (a device unplugged, a screen share ended from its bar, the recorder failing) stops
  // the recording and keeps what it made.
  const endedBy = (kind: string) => () => {
    if (finished || !kept) return;
    void stop().then(recorded => events.onEnded?.(recorded, new RecordingProblem(kind, source).said));
  };
  for (const track of stream.getTracks()) track.addEventListener('ended', endedBy('ended'), { once: true });
  recorder.addEventListener('error', endedBy('failed'), { once: true });
  // A recorder that stops when nobody asked it to (the browser gave up on the stream) is the same: kept, and said.
  recorder.addEventListener('stop', () => { if (!finished) endedBy('failed')(); }, { once: true });

  return {
    source, stream, startedAt, mediaType, fileName, elapsedMs,
    paused: () => recorder.state === 'paused',
    pause: () => {
      if (!recording()) return;
      // What was recorded up to now is handed out before the pause, so the screen holds all of it.
      try { recorder.requestData(); } catch { /* a recorder that cannot hand out a piece now hands it out at stop */ }
      recorder.pause();
      timing = pauseActiveTime(timing, Date.now());
      words?.pause();
    },
    resume: () => {
      if (recorder.state !== 'paused') return;
      recorder.addEventListener('resume', () => {
        timing = resumeActiveTime(timing, Date.now());
        words?.resume();
      }, { once: true });
      recorder.resume();
    },
    soFar: () => new Promise<Blob>(done => {
      const whole = () => done(new Blob(pieces, { type: mediaType }));
      if (recorder.state === 'inactive') { whole(); return; }
      // The piece being made is asked for; it is added to the pieces (the recorder's own handler runs first) before
      // this one answers.
      recorder.addEventListener('dataavailable', whole, { once: true });
      try { recorder.requestData(); } catch { recorder.removeEventListener('dataavailable', whole); whole(); }
    }),
    stop,
    discard: () => {
      kept = false;
      finished ??= Promise.resolve({ file: new File([], ''), seconds: 0 });
      words?.abort(); quiet.stop();
      try { if (recorder.state !== 'inactive') recorder.stop(); } catch { /* already stopped */ }
      release(true);
    },
  };
}
