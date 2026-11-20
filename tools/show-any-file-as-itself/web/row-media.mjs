// tools/show-any-file-as-itself/web/row-media.mjs
//
// PURPOSE
//   What a row's media field holds, read as one source: the address to play or show, its media type, and whether the
//   player (sound or video, a YouTube or other embed) or the file viewer (anything else) takes it. The screen
//   (row-media-screen-mount.tsx) reads the row and names the field; nothing here names a row, a field or a course.
//   Pure: the value arrives as a parameter and nothing is read or written here.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The address is the first of playback_url, url, embed_url or source_url the field holds; a field with no address is no source.
//   2. A sound or video type, or a YouTube address with no type, is the player's; every other type is the file viewer's.
//   3. A type the field does not hold is left empty: the file viewer then reads it by its name, as it does for any file.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

const YOUTUBE_HOST = /(^|\.)(youtu\.be|youtube\.com|youtube-nocookie\.com)$/;
const text = value => (typeof value === 'string' && value ? value : undefined);

function hostOf(address) {
  try { return new URL(address).hostname; } catch { return ''; }
}

/** One media source as the screen draws it: `media` for the player, or `file` (url, contentType, label) for the viewer.
 *  `held` is a field's address as text, or an object naming one; `id` names the source; `label` is its name when it names none.
 * @param {unknown} held
 * @param {string} id
 * @param {string} [label]
 * @returns {{ kind: 'file', file: { url: string, contentType: string, label: string }, media?: undefined } | { kind: 'media', media: { id: string, label: string, mime_type: string | undefined, source_kind: 'audio' | 'video', playback_url: string, poster_url: string | undefined }, file?: undefined } | null}
 */
export function sourceOf(held, id, label = '') {
  const source = typeof held === 'string' ? { playback_url: held } : held;
  if (!source || typeof source !== 'object') return null;
  const address = [source.playback_url, source.url, source.embed_url, source.source_url].find(value => text(value));
  if (!address) return null;
  const mime = text(source.mime_type) ?? text(source.content_type);
  const name = text(source.label) ?? label;
  const isPlayable = mime?.startsWith('audio/') || mime?.startsWith('video/') || (!mime && YOUTUBE_HOST.test(hostOf(address)));
  if (!isPlayable) return { kind: 'file', file: { url: address, contentType: mime ?? '', label: name } };
  return {
    kind: 'media',
    media: {
      id,
      label: name,
      mime_type: mime,
      source_kind: mime?.startsWith('audio/') ? 'audio' : 'video',
      playback_url: address,
      poster_url: text(source.poster_url),
    },
  };
}

/** The source a row's field holds, or null when the row holds none there. */
export function mediaOf(value, field, id) {
  if (!value || !field) return null;
  return sourceOf(value[field], id, text(value.label) ?? text(value.title) ?? '');
}

/** The body a row's field holds as text, or '' when it holds none. */
export function bodyOf(value, field) {
  return field && value ? text(value[field]) ?? '' : '';
}
