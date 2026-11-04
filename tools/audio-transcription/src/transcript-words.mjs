// src/transcript-words.mjs
//
// PURPOSE
//   The one shape a transcript is kept in: { text, segments: [{ start, end, text, words: [{ word, start, end }] }],
//   language }. tool:transcribe-file (src/person-store.mjs accountActions) keeps what the speech model heard in it, and
//   every reader already reads it: the Media words count (src/media-library.json `$.text`), search moments
//   (src/search.json `$.segments` start/text), captions (parts/media-composition/read-data/caption-lines.ts wordsOf,
//   `segments[].words`) and the transcript reader (parts/transcript-reader, words as { word, start, end }).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only what the model said is kept: a segment or word without finite times is dropped, never given guessed ones,
//      and a passage the model gave no word times for has no `words`.
//   2. Times are seconds from the start of the file that was heard.
//   3. Nothing here names a model; the model's answer is read by shape (text, segments, segments[].words).

const finite = value => typeof value === 'number' && Number.isFinite(value);

/** The timed words of one model segment, each { word, start, end }. */
const wordsOfSegment = segment => (Array.isArray(segment?.words) ? segment.words : [])
  .map(word => ({ word: String(word?.word ?? word?.text ?? '').trim(), start: word?.start, end: word?.end }))
  .filter(word => word.word && finite(word.start) && finite(word.end) && word.end >= word.start);

/** A speech model's answer as the kept transcript shape. */
export function timedTranscript(output) {
  const segments = (Array.isArray(output?.segments) ? output.segments : [])
    .filter(segment => finite(segment?.start) && finite(segment?.end))
    .map(segment => {
      const words = wordsOfSegment(segment);
      return { start: segment.start, end: segment.end, text: String(segment.text ?? '').trim(), ...(words.length ? { words } : {}) };
    });
  const text = typeof output?.text === 'string' ? output.text.trim() : '';
  const language = output?.transcription_info?.language ?? output?.language ?? null;
  return { text, segments, ...(language ? { language } : {}) };
}

/** Whether a kept transcript carries word timings, so captions and picking a stretch by its words can use it. */
export const hasWordTimings = value => Array.isArray(value?.segments) && value.segments.some(segment => Array.isArray(segment?.words) && segment.words.length > 0);
