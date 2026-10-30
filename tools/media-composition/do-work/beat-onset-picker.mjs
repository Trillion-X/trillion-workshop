/**
 * The ONE beat/onset picker (SSOT): an energy-flux onset detector over a mono PCM channel, shared by BOTH the
 * in-browser live-edit path (detect-beats-browser.ts re-exports this) AND the offline node producer
 * (detect-beats.mjs feeds it ffmpeg-extracted PCM). One algorithm, two PCM sources, so the two entry points
 * can never silently diverge (L030 / canonical-single-source). Pure math, zero deps, deterministic.
 *
 * Method: frame the mono signal, take per-frame RMS energy, compute the positive energy flux (increase over
 * the previous frame), then pick local maxima that clear an adaptive mean+k*std window threshold and respect a
 * minimum inter-beat gap. Percussive / transient material yields clean beats; the adaptive threshold keeps it
 * tempo-agnostic (L090: the picker is blind to genre, it just finds energy onsets, so footsteps, ball bounces,
 * or spoken stresses drive it identically).
 */

/**
 * The ONE onset envelope: per-frame RMS energy and its positive flux (the increase over the previous frame).
 * Both the beat picker (adaptive peak pick) and the alignment producer (argmax = strongest transient) read this,
 * so there is a single energy/flux implementation (SSOT). `hop` samples per frame, frame window = 2*hop.
 * @param {Float32Array|Float64Array|number[]} samples
 * @param {number} [hop]
 * @returns {{flux:Float64Array, nFrames:number, hop:number, win:number}}
 */
export function frameEnergyFlux(samples, hop = 512) {
  const n = samples.length;
  const h = Math.max(64, Math.floor(hop));
  const win = h * 2;
  const nFrames = Math.max(0, Math.floor((n - win) / h) + 1);
  const flux = new Float64Array(Math.max(0, nFrames));
  if (nFrames <= 2) return { flux, nFrames, hop: h, win };
  const energy = new Float64Array(nFrames);
  for (let f = 0; f < nFrames; f += 1) {
    const start = f * h;
    let sum = 0;
    for (let i = 0; i < win; i += 1) {
      const s = samples[start + i] ?? 0;
      sum += s * s;
    }
    energy[f] = Math.sqrt(sum / win);
  }
  for (let f = 1; f < nFrames; f += 1) {
    const d = energy[f] - energy[f - 1];
    flux[f] = d > 0 ? d : 0;
  }
  return { flux, nFrames, hop: h, win };
}

/**
 * Detect beat times (seconds) from a single mono channel.
 * @param {Float32Array|Float64Array|number[]} samples
 * @param {number} sampleRate
 * @param {{hop?:number, thresholdK?:number, minGap?:number, windowFrames?:number}} [opts]
 * @returns {number[]} ascending beat times in seconds (rounded to ms)
 */
export function detectBeatsFromChannel(samples, sampleRate, opts = {}) {
  const n = samples.length;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || n === 0) return [];
  const thresholdK = Number.isFinite(opts.thresholdK) ? opts.thresholdK : 1.3;
  const minGap = Number.isFinite(opts.minGap) ? Math.max(0, opts.minGap) : 0.18;
  const windowFrames = Math.max(2, Math.floor(opts.windowFrames ?? 16));

  const { flux, nFrames, hop } = frameEnergyFlux(samples, opts.hop ?? 512);
  if (nFrames <= 2) return [];
  // Adaptive peak pick.
  const beats = [];
  let lastBeatSample = -Infinity;
  for (let f = 1; f < nFrames - 1; f += 1) {
    if (!(flux[f] > flux[f - 1] && flux[f] >= flux[f + 1])) continue; // local max
    const lo = Math.max(0, f - windowFrames);
    const hi = Math.min(nFrames, f + windowFrames + 1);
    let mean = 0;
    for (let k = lo; k < hi; k += 1) mean += flux[k];
    mean /= (hi - lo);
    let variance = 0;
    for (let k = lo; k < hi; k += 1) variance += (flux[k] - mean) * (flux[k] - mean);
    const std = Math.sqrt(variance / (hi - lo));
    if (flux[f] < mean + thresholdK * std || flux[f] <= 0) continue;
    const sampleIdx = f * hop;
    if ((sampleIdx - lastBeatSample) / sampleRate < minGap) continue;
    beats.push(Math.round((sampleIdx / sampleRate) * 1000) / 1000);
    lastBeatSample = sampleIdx;
  }
  return beats;
}
