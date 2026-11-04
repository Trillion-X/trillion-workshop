// parts/record-audio/show/edit-recording.ts
//
// NO PRIOR: searched parts/ and ~/dev/bitfield-packages/packages for cutting or splicing recorded sound in the browser
// ('OfflineAudioContext', 'decodeAudioData', 'wav', 'splice'); media-composition renders timelines on the server with
// ffmpeg and parts/media-composition/do-work/decode-audio-peaks.ts only reads peaks for drawing.
//
// PURPOSE
//   The sound side of editing a recording on the device: decode what was recorded, play an edit (a list of spans of the
//   recording made, src/workspace/recording.mjs) from any second, and make the edited recording as one WAV file. The
//   spans are joined by the browser's own audio renderer (OfflineAudioContext), so a cut or an addition needs no server
//   and no upload before it can be heard.
//
// NON-NEGOTIABLE INVARIANTS
//   1. An edit is rendered from the decoded recording and the spans alone; nothing here keeps a second copy of what the
//      edit is.
//   2. Every span is clamped to the recording's length, so a span measured a little past the end never fails a render.
//   3. Playing never changes the edit; stopping is always safe, more than once.

type Span = { from: number; to: number };
type AudioContextConstructor = typeof AudioContext;

const audioContextConstructor = (): AudioContextConstructor | null => {
  if (typeof window === 'undefined') return null;
  const scope = window as Window & { webkitAudioContext?: AudioContextConstructor };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
};

/** The recorded sound, decoded. Throws when this browser cannot read the recording. */
export async function decodeRecording(recording: Blob): Promise<AudioBuffer> {
  const Constructor = audioContextConstructor();
  if (!Constructor) throw new Error('This browser cannot play the recording back here.');
  const context = new Constructor();
  try { return await context.decodeAudioData(await recording.arrayBuffer()); }
  finally { void context.close().catch(() => {}); }
}

/** The edit as one sound, `sampleRate` samples a second in one channel. */
export async function renderEdit(recording: AudioBuffer, edit: Span[], sampleRate = recording.sampleRate): Promise<AudioBuffer> {
  const spans = edit
    .map(span => ({ from: Math.max(0, Math.min(span.from, recording.duration)), to: Math.max(0, Math.min(span.to, recording.duration)) }))
    .filter(span => span.to - span.from > 1e-4);
  const seconds = spans.reduce((sum, span) => sum + (span.to - span.from), 0);
  const context = new OfflineAudioContext(1, Math.max(1, Math.ceil(seconds * sampleRate)), sampleRate);
  let at = 0;
  for (const span of spans) {
    const source = context.createBufferSource();
    source.buffer = recording;
    source.connect(context.destination);
    source.start(at, span.from, span.to - span.from);
    at += span.to - span.from;
  }
  return context.startRendering();
}

/** A sound as a 16-bit WAV file named `name`. */
export function wavFile(sound: AudioBuffer, name: string, lastModified = Date.now()): File {
  const channels = sound.numberOfChannels;
  const frames = sound.length;
  const bytes = new ArrayBuffer(44 + frames * channels * 2);
  const view = new DataView(bytes);
  const text = (at: number, value: string) => { for (let index = 0; index < value.length; index += 1) view.setUint8(at + index, value.charCodeAt(index)); };
  text(0, 'RIFF'); view.setUint32(4, 36 + frames * channels * 2, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, sound.sampleRate, true); view.setUint32(28, sound.sampleRate * channels * 2, true); view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, frames * channels * 2, true);
  const data = Array.from({ length: channels }, (_, channel) => sound.getChannelData(channel));
  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (const channel of data) {
      const sample = Math.max(-1, Math.min(1, channel[frame] ?? 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new File([bytes], name, { type: 'audio/wav', lastModified });
}

/** Plays from `seconds`, optionally bounded to a chosen range. Repeating uses the audio clock, not frame timing.
 *  Invalid ranges do not start sound. Stopping is idempotent and does not report a natural end. */
export function playFrom(sound: AudioBuffer, seconds: number, onTime: (seconds: number) => void, onEnd: () => void,
  options: { range?: Span; loop?: boolean } = {}): () => void {
  const length = sound.duration;
  const range = options.range;
  if (!Number.isFinite(length) || length <= 0 || !Number.isFinite(seconds)
    || (range && (!Number.isFinite(range.from) || !Number.isFinite(range.to)))
    || (options.loop && !range)) { onEnd(); return () => {}; }
  const start = range ? Math.max(0, Math.min(range.from, length)) : 0;
  const end = range ? Math.max(0, Math.min(range.to, length)) : length;
  if (end <= start) { onEnd(); return () => {}; }
  const loop = options.loop === true;
  const requested = Math.max(start, Math.min(seconds, end));
  const from = loop && requested >= end ? start : requested;
  if (from >= end) { onTime(end); onEnd(); return () => {}; }
  const Constructor = audioContextConstructor();
  if (!Constructor) { onEnd(); return () => {}; }
  const context = new Constructor();
  const source = context.createBufferSource();
  source.buffer = sound;
  source.connect(context.destination);
  if (loop) { source.loop = true; source.loopStart = start; source.loopEnd = end; }
  let stopped = false;
  let frame = 0;
  const startedAt = context.currentTime;
  const tick = () => {
    if (stopped) return;
    const elapsed = Math.max(0, context.currentTime - startedAt);
    onTime(loop ? start + ((from - start + elapsed) % (end - start)) : Math.min(end, from + elapsed));
    frame = requestAnimationFrame(tick);
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frame);
    try { source.stop(); } catch { /* already ended */ }
    void context.close().catch(() => {});
  };
  source.onended = () => { if (!stopped) { onTime(end); stop(); onEnd(); } };
  try {
    if (loop) source.start(0, from);
    else source.start(0, from, end - from);
  } catch (error) { stop(); throw error; }
  frame = requestAnimationFrame(tick);
  return stop;
}
