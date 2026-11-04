// parts/media-playback/read-data/measure-media-length.ts
//
// How long a sound or video file plays, read from the file itself by the browser's own media decoder: only its
// metadata is fetched (a range request for the header), nothing plays and nothing is shown.
//
// Invariants
//   1. The answer is the decoder's measured duration, or null when the file cannot say (not media, a stream with no
//      end, an error, or no answer in time). A length is never guessed.
//   2. The element is detached and released after the read, so measuring many files leaves nothing behind.

const WAIT_MS = 20_000;

/** Seconds the file at `url` plays for, or null when it cannot be measured. `kind` is its family, audio or video. */
export function measureMediaLength(url: string, kind: 'audio' | 'video' = 'video'): Promise<number | null> {
  if (typeof document === 'undefined' || !url) return Promise.resolve(null);
  return new Promise(resolve => {
    const element = document.createElement(kind);
    let settled = false;
    const finish = (seconds: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      element.removeAttribute('src');
      element.load();
      resolve(seconds);
    };
    const timer = setTimeout(() => finish(null), WAIT_MS);
    element.preload = 'metadata';
    element.muted = true;
    element.addEventListener('loadedmetadata', () => {
      const seconds = element.duration;
      finish(Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) / 1000 : null);
    }, { once: true });
    element.addEventListener('error', () => finish(null), { once: true });
    element.src = url;
  });
}
