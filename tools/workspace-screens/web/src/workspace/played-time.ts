// src/workspace/played-time.ts
//
// PURPOSE
//   How long the audio or video inside one element really played, told once it reaches a number of seconds: the
//   Recent screen's "watched" (file-uses.ts) is said only after a recording played that long.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only playing counts: a jump between two time reports longer than a normal step is a seek, and time reported
//      while paused is not played.
//   2. Media events do not bubble, so they are heard in the capture phase on the host, whatever player the shared
//      preview mounted inside it; anything reporting a numeric currentTime and a paused flag counts as media.
//   3. `done` is called once; the listener is gone after it, and after the returned teardown.

// A step between two time reports longer than this was a seek, not playing.
const LONGEST_PLAYED_STEP = 1.5;

/** Calls `done` once, after media inside `host` really played for `seconds`. Returns a teardown. */
export function afterPlaying(host: EventTarget, seconds: number, done: () => void): () => void {
  const last = new WeakMap<object, number>();
  let played = 0;
  let told = false;
  const onTime = (event: Event) => {
    if (told) return;
    const media = event.target as { currentTime?: unknown; paused?: unknown } | null;
    if (!media || typeof media.currentTime !== 'number' || typeof media.paused !== 'boolean') return;
    const previous = last.get(media);
    const current = media.currentTime;
    last.set(media, current);
    if (media.paused || previous === undefined) return;
    const step = current - previous;
    if (step > 0 && step < LONGEST_PLAYED_STEP) played += step;
    if (played >= seconds) { told = true; stop(); done(); }
  };
  const stop = () => host.removeEventListener('timeupdate', onTime, true);
  host.addEventListener('timeupdate', onTime, true);
  return stop;
}
