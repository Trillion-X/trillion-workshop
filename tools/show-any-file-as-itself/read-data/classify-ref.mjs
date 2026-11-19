// tools/show-any-file-as-itself/read-data/classify-ref.mjs
//
// PURPOSE
//   Chooses how one ref is drawn, from the ref's text alone: a picture, a video, a sound, or a web page (drawn in a frame,
//   which plays and scrolls as the page does). It opens nothing and fetches nothing, so the screen calls it before it
//   draws, and the test runs without a browser. A ref is an https address, or a relative path to a file the page is
//   served beside (a file the host has already placed there). Any other scheme (files:, mailto:, ...) is `unsupported`:
//   the screen says so and shows the text of the ref, never a broken frame.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

const EXTENSION_KIND = new Map([
  ...['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp'].map(ext => [ext, 'image']),
  ...['mp4', 'webm', 'mov', 'm4v', 'ogv'].map(ext => [ext, 'video']),
  ...['mp3', 'wav', 'm4a', 'ogg', 'oga', 'flac', 'aac'].map(ext => [ext, 'audio']),
]);

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

/** { kind: 'image' | 'video' | 'audio' | 'page' | 'unsupported', src }: src is the ref as the screen loads it. */
export function classifyRef(ref) {
  if (typeof ref !== 'string' || ref.trim() === '') throw new TypeError('A ref must be a non-empty string.');
  const src = ref.trim();
  const scheme = SCHEME.exec(src);
  if (scheme && scheme[1].toLowerCase() !== 'https' && scheme[1].toLowerCase() !== 'http') return { kind: 'unsupported', src };
  const path = src.split(/[?#]/)[0];
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1].toLowerCase();
  return { kind: EXTENSION_KIND.get(ext) ?? 'page', src };
}
