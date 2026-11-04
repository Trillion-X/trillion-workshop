// tools/listen-for-a-while/show/live-audio-encoding.ts (moved from Trillion-X/trillion parts/record-audio/show/live-audio-encoding.ts)
//
// Purpose
//   How the microphone is turned into the packets the live-words route takes: samples are cut into fixed-size chunks
//   (so every packet is the same length whatever the audio thread hands over), converted to 16-bit PCM, and, when the
//   browser has WebCodecs Opus and the route says it takes it, compressed instead. The AudioWorklet that cuts the chunks
//   off the audio thread is a source string here, with the ScriptProcessor kept as the fallback for browsers without one.
//
// Non-negotiable invariants
//   1. A chunk is always exactly `frameSamples` samples, or it is not emitted yet; leftover samples wait for the next call.
//   2. PCM is the default and the fallback. Opus is used only when the browser can encode it AND the caller says the route
//      accepts it; a failed Opus encoder falls back to PCM for the rest of the recording, never drops audio.
//   3. Samples are clamped to [-1, 1] before they become integers; nothing here reads or sends a sample elsewhere.

export type Encoding = 'pcm16' | 'opus';

/** Cuts a stream of sample blocks into chunks of exactly `frameSamples`. */
export function createChunker(frameSamples: number) {
  let pending = new Float32Array(0);
  return {
    push(block: Float32Array): Float32Array[] {
      const joined = new Float32Array(pending.length + block.length);
      joined.set(pending); joined.set(block, pending.length);
      const chunks: Float32Array[] = [];
      let at = 0;
      for (; at + frameSamples <= joined.length; at += frameSamples) chunks.push(joined.slice(at, at + frameSamples));
      pending = joined.slice(at);
      return chunks;
    },
    pendingSamples: () => pending.length,
  };
}

/** Float samples as little-endian signed 16-bit integers. */
export function pcm16Of(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) out[index] = Math.round(Math.max(-1, Math.min(1, samples[index])) * 32767);
  return out;
}

/** The encoding to use: Opus only when wanted, supported by the browser and accepted by the route; otherwise PCM. */
export function chooseEncoding(options: { wanted: Encoding; browserHasOpus: boolean; routeAcceptsOpus: boolean }): Encoding {
  return options.wanted === 'opus' && options.browserHasOpus && options.routeAcceptsOpus ? 'opus' : 'pcm16';
}

type OpusEncoderLike = { encode(data: unknown): void; close(): void };
type OpusFactory = (onChunk: (bytes: Uint8Array) => void, onError: (error: unknown) => void) => OpusEncoderLike;

/**
 * A sender that gives each chunk to `send` as bytes: PCM, or Opus through `makeOpus` (WebCodecs AudioEncoder in a browser).
 * If the Opus encoder throws, it switches to PCM for every later chunk (and says so once through `onFallback`).
 */
export function createChunkSender(send: (bytes: ArrayBufferLike, encoding: Encoding) => void, encoding: Encoding,
  makeOpus?: OpusFactory, onFallback: () => void = () => {}, makeFrame?: (chunk: Float32Array) => unknown) {
  let mode: Encoding = encoding;
  let opus: OpusEncoderLike | null = null;
  const fall = () => { if (mode === 'opus') { mode = 'pcm16'; onFallback(); opus?.close(); opus = null; } };
  if (mode === 'opus') {
    try { opus = makeOpus!((bytes) => send(bytes.buffer, 'opus'), fall); } catch { fall(); }
  }
  return {
    encoding: () => mode,
    push(chunk: Float32Array) {
      if (mode === 'opus' && opus) {
        try { opus.encode(makeFrame ? makeFrame(chunk) : chunk); return; } catch { fall(); }
      }
      send(pcm16Of(chunk).buffer, 'pcm16');
    },
    close() { opus?.close(); opus = null; },
  };
}

/** The source of the AudioWorkletProcessor that posts fixed-size chunks of the first input channel to the page. */
export const workletSource = (frameSamples: number) => `
class TrillionChunkProcessor extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = new Float32Array(${frameSamples}); this.filled = 0; }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    let read = 0;
    while (read < channel.length) {
      const take = Math.min(channel.length - read, this.buffer.length - this.filled);
      this.buffer.set(channel.subarray(read, read + take), this.filled);
      this.filled += take; read += take;
      if (this.filled === this.buffer.length) { this.port.postMessage(this.buffer.slice(0)); this.filled = 0; }
    }
    return true;
  }
}
registerProcessor('trillion-chunk-processor', TrillionChunkProcessor);
`;

/** Loads the worklet into an audio context; false when this browser has none (the caller then keeps its ScriptProcessor). */
export async function loadChunkWorklet(context: { audioWorklet?: { addModule(url: string): Promise<void> } }, frameSamples: number): Promise<boolean> {
  if (!context.audioWorklet || typeof Blob === 'undefined' || typeof URL === 'undefined') return false;
  const url = URL.createObjectURL(new Blob([workletSource(frameSamples)], { type: 'text/javascript' }));
  try { await context.audioWorklet.addModule(url); return true; } catch { return false; } finally { URL.revokeObjectURL(url); }
}
