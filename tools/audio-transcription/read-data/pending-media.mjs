// tools/audio-transcription/read-data/pending-media.mjs
//
// Purpose
//   The first step of workflow:transcribe-every-new-media-file, unwired. A seeds row change (one row per new recording, from the
//   workflows session's seed intake) starts one run; this step reads the seed by its id and answers the media items that
//   still need words: a stored file identity, an audio or video type, and words still 'pending'. An empty answer ends the run.
//
// Non-negotiable invariants
//   1. The seed is read by its id (fact.key), never trusted from the fact: a fact carries the row only up to 1,000 bytes.
//   2. Only audio/* and video/* media, and octet-stream .MP4/.M4A/.MOV/.WAV by name, count; the extension list is the DATA
//      `MEDIA_NAMES` below, not a branch scattered through the code.
//   3. An item without stored_as (the files session has not kept it yet) is not a candidate: nothing is heard on a guess.

export const AUDIO_OR_VIDEO = /^(audio|video)\//;
export const MEDIA_NAMES = ['.mp4', '.m4a', '.mov', '.wav'];
const PENDING = 'pending';

/** The media items of one seed that need words: { stored_as, type, path } for each. */
export function mediaToTranscribe(seed) {
  if (!seed || typeof seed !== 'object') return [];
  if (seed.words !== PENDING) return [];
  const media = Array.isArray(seed.media) ? seed.media : [];
  return media
    .filter(item => typeof item?.stored_as === 'string' && item.stored_as.startsWith('1f:'))
    .filter(item => AUDIO_OR_VIDEO.test(String(item.type ?? '')) || (item.type === 'application/octet-stream' && MEDIA_NAMES.some(extension => String(item.path ?? '').toLowerCase().endsWith(extension))))
    .map(item => ({ stored_as: item.stored_as, type: item.type, path: item.path }));
}

/** The first SQL step: the seed by the id the fact names (the position is the middle part of fact.key). */
export const SEED_SQL = `SELECT id, words, media FROM seeds WHERE id = $1`;
