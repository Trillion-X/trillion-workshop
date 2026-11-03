// tools/media-composition/do-work/stream-core.mjs
//
// PURPOSE
//   A detector that reads a recording as a stream of feature frames and carries what it has learned so far: the encoder turns
//   a stretch of the recording into frames of named features, the CORE keeps a running baseline for each feature, and the
//   HEADS read how far a frame stands above that baseline and say what happened. The state goes in and out of every step as
//   plain data, so a stream can be stopped, saved, resumed and tested, and a head is a row that can be retuned or swapped
//   without touching the encoder or the core.
//
// NON-NEGOTIABLE INVARIANTS
//   1. `step` is pure: the same config, state and frame give the same new state and events. Nothing is kept inside.
//   2. Blind: no feature, event kind or sport is named here. The features, the core's smoothing and every head
//      (kind, feature weights, thresholds, refractory time) are the rows of the config handed in (detect-events.json `streams`).
//   3. A frame is judged against the baseline from BEFORE it, then learned: an event never raises the bar it is judged by.
//   4. A head makes no event while the baseline is warming (`warmup_frames`) or inside its refractory time after its last event.
const clamp01 = value => Math.max(0, Math.min(1, value));

/** The state of a stream that has seen nothing. */
export const newState = () => ({ frames: 0, baseline: {}, last: {} });

/** One frame { t, <feature>: number } against the state: { state, events: [{ kind, time, confidence, z }] }. */
export function step(config, state, frame) {
  const features = config.features;
  const z = {};
  for (const name of features) {
    const seen = state.baseline[name];
    const value = Number(frame[name]);
    z[name] = seen && Number.isFinite(value) ? (value - seen.mean) / Math.sqrt(seen.variance + config.core.floor) : 0;
  }
  const events = [];
  const last = { ...state.last };
  if (state.frames >= config.core.warmup_frames) {
    for (const head of config.heads) {
      const score = Object.entries(head.weights).reduce((sum, [name, weight]) => sum + weight * (z[name] ?? 0), 0);
      if (score < head.z_min) continue;
      if (last[head.kind] !== undefined && frame.t - last[head.kind] < head.refractory_s) continue;
      last[head.kind] = frame.t;
      events.push({ kind: head.kind, time: frame.t, confidence: clamp01((score - head.z_min) / (head.z_full - head.z_min)), z: Math.round(score * 100) / 100 });
    }
  }
  const baseline = {};
  for (const name of features) {
    const value = Number(frame[name]);
    const seen = state.baseline[name];
    if (!Number.isFinite(value)) { if (seen) baseline[name] = seen; continue; }
    if (!seen) { baseline[name] = { mean: value, variance: 0 }; continue; }
    const alpha = config.core.alpha;
    const mean = seen.mean + alpha * (value - seen.mean);
    baseline[name] = { mean, variance: (1 - alpha) * (seen.variance + alpha * (value - seen.mean) ** 2) };
  }
  return { state: { frames: state.frames + 1, baseline, last }, events };
}

/** Runs every frame in order from `state` (a new one when none): { state, events }. */
export function run(config, frames, state = newState()) {
  const events = [];
  let current = state;
  for (const frame of frames) {
    const stepped = step(config, current, frame);
    current = stepped.state;
    events.push(...stepped.events);
  }
  return { state: current, events };
}
