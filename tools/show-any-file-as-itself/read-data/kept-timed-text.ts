import type { TimedTextSegment } from '../show/MediaPlaybackSurface';

/** Saved transcript passages use seconds; the shared player indexes passages
 * in milliseconds and keeps word times in seconds. Preserve only valid timings.
 */
export function timedTextOf(identity: string, passages: unknown): TimedTextSegment[] {
  if (!Array.isArray(passages)) return [];
  return passages.flatMap((passage, index) => {
    if (!passage || typeof passage.text !== 'string' || !Number.isFinite(passage.start) || !Number.isFinite(passage.end)
      || passage.start < 0 || passage.end < passage.start) return [];
    const start_ms = Math.round(passage.start * 1000);
    const end_ms = Math.round(passage.end * 1000);
    if (!Number.isSafeInteger(start_ms) || !Number.isSafeInteger(end_ms)) return [];
    const speaker = typeof passage.speaker === 'string' && passage.speaker.trim() ? passage.speaker.trim() : undefined;
    const words = Array.isArray(passage.words) ? passage.words.filter(word => word && typeof word.word === 'string'
      && Number.isFinite(word.start) && Number.isFinite(word.end) && word.start >= 0 && word.end >= word.start)
      .map(word => ({ word: word.word, start: word.start, end: word.end })) : undefined;
    return [{ id: `${identity}#${index}`, text: passage.text, start_ms, end_ms,
      ...(speaker ? { speaker } : {}),
      ...(words?.length ? { words } : {}) }];
  });
}
