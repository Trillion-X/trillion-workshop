// tools/media-playback/read-data/subtitle-window.mjs
//
// PURPOSE
//   The words a subtitle shows for one passage at a moment of the playback: a window of at most `windowWords` words around the
//   word being said, each marked whether it is that word. The player's subtitle caption (MediaPlaybackSurface.tsx, SubtitleCaption)
//   draws this window; nothing here draws, reads or writes anything.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The window never shows more than `windowWords` words, so a long passage stays within two lines of a caption.
//   2. The window always contains the word being said, when a word is being said.
//   3. A passage with no words gives no window; its text is what the caller shows.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

export const SUBTITLE_WORDS = 14;

/** The window of a passage at `seconds`: { words: [{ word, active }], activeIndex, text }. `segment` has `words` with start and
 *  end in seconds, and `text`. `activeIndex` is the index into the passage's words of the word being said, or -1 when none is. */
export function subtitleWordsOf(segment, seconds, windowWords = SUBTITLE_WORDS) {
  const words = Array.isArray(segment?.words) ? segment.words : [];
  const text = typeof segment?.text === 'string' ? segment.text : '';
  if (!words.length) return { words: [], activeIndex: -1, text };
  let activeIndex = words.findIndex(word => seconds >= word.start && seconds < word.end);
  if (activeIndex < 0) {
    for (let index = words.length - 1; index >= 0; index -= 1) {
      if (seconds >= words[index].end) { activeIndex = index; break; }
    }
  }
  const size = Math.min(windowWords, words.length);
  const start = Math.max(0, Math.min(Math.max(activeIndex, 0) - Math.floor(size / 2), words.length - size));
  const window = words.slice(start, start + size).map((word, offset) => ({ word: word.word, active: start + offset === activeIndex }));
  return { words: window, activeIndex, text };
}
