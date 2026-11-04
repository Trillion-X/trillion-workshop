// packages/media-composition/do-work/decode-audio-peaks.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Decodes raw audio bytes into a normalized peaks array suitable for rendering
// a Waveform component. Uses the Web Audio API (AudioContext.decodeAudioData)
// for format-agnostic decoding (MP3, AAC, WAV, OGG, etc.), then downsamples
// channel 0 to `bucketCount` peak values in the range [0, 1].
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. ENVIRONMENT GUARD: Returns [] immediately when AudioContext is unavailable
//    (SSR, Workers, WASM hosts without Web Audio). Never throws.
// 2. PEAK ALGORITHM: max-abs across each bucket window — faithfully represents
//    the loudest transient within each bucket, matching DAW conventions.
// 3. NORMALIZED OUTPUT: All values in [0, 1]. Divide by the channel global
//    max-abs so the waveform fills the render height regardless of gain level.
// 4. PURE TYPESCRIPT: No React, no design tokens, no DOM side-effects beyond
//    AudioContext instantiation.
// 5. IN-MEMORY CACHE: Optional cacheKey dedups repeated decodes for the same
//    byte payload within a page session. Cache is never persisted.
// 6. SINGLE CHANNEL: Operates on channel 0 only — sufficient for waveform
//    visualization of stereo or surround files.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

// ---------------------------------------------------------------------------
// IN-MEMORY CACHE
// ---------------------------------------------------------------------------

const peaksCache = new Map<string, number[]>();

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

/**
 * Downsample a Float32Array of PCM samples to `bucketCount` max-abs peaks,
 * normalized to [0, 1] by the global max-abs value.
 *
 * Each bucket covers Math.ceil(samples.length / bucketCount) frames.
 * The last bucket may cover fewer frames — this is correct behaviour.
 */
function downsampleToPeaks(samples: Float32Array, bucketCount: number): number[] {
  const total = samples.length;
  if (total === 0 || bucketCount <= 0) return [];

  const framesPerBucket = Math.ceil(total / bucketCount);
  const rawPeaks: number[] = [];

  for (let b = 0; b < bucketCount; b++) {
    const start = b * framesPerBucket;
    const end = Math.min(start + framesPerBucket, total);
    let max = 0;
    for (let i = start; i < end; i++) {
      const abs = Math.abs(samples[i] as number);
      if (abs > max) max = abs;
    }
    rawPeaks.push(max);
  }

  // Normalize by global maximum so peaks fill [0, 1].
  const globalMax = rawPeaks.reduce((m, v) => (v > m ? v : m), 0);
  if (globalMax === 0) return rawPeaks.map(() => 0);
  return rawPeaks.map((v) => v / globalMax);
}

// ---------------------------------------------------------------------------
// PUBLIC API
// ---------------------------------------------------------------------------

/**
 * Decode audio bytes to a normalized peaks array for waveform rendering.
 *
 * @param bytes       Raw audio file bytes (MP3, WAV, AAC, OGG, etc.).
 * @param mediaType   MIME type string — used for documentation only, decodeAudioData
 *                    is format-agnostic.
 * @param bucketCount Number of output peak values. Default 200.
 * @param cacheKey    Optional stable identifier (e.g. a CAS hash or source ID)
 *                    for deduplicating decodes within a session.
 *
 * @returns Promise resolving to an array of `bucketCount` floats in [0, 1],
 *          or [] when the environment does not support Web Audio or decoding fails.
 */
export async function decodeAudioPeaks(
  bytes: Uint8Array,
  mediaType: string,
  bucketCount = 200,
  cacheKey?: string,
): Promise<number[]> {
  if (cacheKey !== undefined) {
    const cached = peaksCache.get(cacheKey);
    if (cached !== undefined) return cached;
  }

  // Guard: AudioContext may be absent in SSR, Workers, or non-browser hosts.
  const AudioCtx =
    (globalThis as Record<string, unknown>)['AudioContext'] as (typeof AudioContext | undefined) ??
    (globalThis as Record<string, unknown>)['webkitAudioContext'] as (typeof AudioContext | undefined);

  if (AudioCtx === undefined) {
    return [];
  }

  try {
    // slice produces a new ArrayBuffer — decodeAudioData transfers ownership.
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

    const ctx = new AudioCtx({ sampleRate: 22050 });
    let audioBuffer: AudioBuffer;
    try {
      audioBuffer = await ctx.decodeAudioData(buffer as ArrayBuffer);
    } finally {
      if (typeof ctx.close === 'function') void ctx.close();
    }

    const channel0 = audioBuffer.getChannelData(0);
    const peaks = downsampleToPeaks(channel0, bucketCount);

    if (cacheKey !== undefined) {
      peaksCache.set(cacheKey, peaks);
    }

    return peaks;
  } catch {
    return [];
  }
}

/** Evict a single entry from the in-memory peaks cache. */
export function evictAudioPeaksCache(cacheKey: string): void {
  peaksCache.delete(cacheKey);
}

/** Clear the entire in-memory peaks cache (testing / low-memory situations). */
export function clearAudioPeaksCache(): void {
  peaksCache.clear();
}
