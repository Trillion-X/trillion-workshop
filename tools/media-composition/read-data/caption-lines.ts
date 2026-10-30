/**
 * caption-lines.ts: PURE grouping of a transcript word stream into timed caption lines.
 *
 * Zero I/O. The UI (or an AI worker) calls `groupWordsIntoCaptionLines` to turn the
 * audio-transcription words into a DATA `lines` array [{text, start, end}], which the
 * `add-captions` fold then expands into timed text overlays. The fold stays blind (L090):
 * it never groups, it only renders the lines it is handed as DATA.
 *
 * Grouping is bounded by three DATA knobs so any caption cadence (fast word-by-word,
 * Descript-style two-line blocks, karaoke) is a config, not code: max words per line,
 * max characters per line, and the max silence gap that forces a line break.
 */

export type CaptionWord = { text: string; start: number; end: number };
/** A line carries its constituent `words` (with per-word timing) so a caption fold can render
 *  either the whole line at once (default) or reveal it word-by-word (karaoke). */
export type CaptionLine = { text: string; start: number; end: number; words: CaptionWord[] };

export type CaptionGroupOptions = {
  /** Hard cap on words per caption line (default 6). */
  maxWords?: number;
  /** Hard cap on characters per caption line (default 42). */
  maxChars?: number;
  /** A silence gap (seconds) between consecutive words that forces a new line (default 0.6). */
  maxGap?: number;
  /** Longest a line may stay on screen, first word start to last word end (default: no limit). */
  maxSeconds?: number;
  /** End a line after a word ending a sentence (. ! ?), so a line never straddles two sentences (default false). */
  breakAfterSentence?: boolean;
  /** How words are written on screen, whatever case the transcript heard them in (DATA, per style): `sentenceStart`
   *  capitalises the first word and every word after one ending a sentence; `alwaysCapital` lists words always written
   *  with a capital first letter (in English, "i" and its contractions), matched without case or punctuation. */
  casing?: { sentenceStart?: boolean; alwaysCapital?: string[] };
};

const capitalised = (text: string) => text.replace(/\p{L}/u, letter => letter.toLocaleUpperCase());
const bare = (text: string) => text.toLocaleLowerCase().replace(/[’]/g, "'").replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '');

/** Words written as the style's `casing` says: a sentence's first word and the always-capital words capitalised. */
export function casedWords<W extends { text: string }>(words: W[], casing: CaptionGroupOptions['casing'] = {}): W[] {
  const always = new Set((casing.alwaysCapital ?? []).map(bare));
  let startsSentence = true;
  return words.map(word => {
    const cased = (casing.sentenceStart && startsSentence) || always.has(bare(word.text)) ? capitalised(word.text) : word.text;
    startsSentence = /[.!?]["')\]]*$/.test(word.text);
    return cased === word.text ? word : { ...word, text: cased };
  });
}

/**
 * Group words into caption lines. A new line starts when adding the next word would exceed
 * maxWords, maxChars or maxSeconds, when the gap from the previous word's end to this word's start
 * exceeds maxGap, or (breakAfterSentence) after a word that ends a sentence. Each line's window is [first word start, last word end]. Words with
 * non-finite timing are skipped; empty text is ignored.
 */
export function groupWordsIntoCaptionLines(
  words: CaptionWord[],
  opts: CaptionGroupOptions = {},
): CaptionLine[] {
  const maxWords = opts.maxWords ?? 6;
  const maxChars = opts.maxChars ?? 42;
  const maxGap = opts.maxGap ?? 0.6;
  const maxSeconds = opts.maxSeconds ?? Infinity;

  const clean = (Array.isArray(words) ? words : [])
    .map((w) => ({ text: String(w?.text ?? '').trim(), start: Number(w?.start), end: Number(w?.end) }))
    .filter((w) => w.text.length > 0 && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start)
    .sort((a, b) => a.start - b.start);
  const written = casedWords(clean, opts.casing);

  const lines: CaptionLine[] = [];
  let cur: CaptionWord[] = [];
  const flush = () => {
    if (cur.length === 0) return;
    lines.push({ text: cur.map((w) => w.text).join(' '), start: cur[0].start, end: cur[cur.length - 1].end, words: cur.slice() });
    cur = [];
  };

  for (const w of written) {
    if (cur.length > 0) {
      const prev = cur[cur.length - 1];
      const wouldChars = cur.reduce((n, c) => n + c.text.length + 1, 0) + w.text.length;
      const breakHere = cur.length >= maxWords || wouldChars > maxChars || (w.start - prev.end) > maxGap || (w.end - cur[0].start) > maxSeconds;
      if (breakHere) flush();
    }
    cur.push(w);
    if (opts.breakAfterSentence && /[.!?]["')\]]*$/.test(w.text)) flush();
  }
  flush();
  return lines;
}

/** The timed words in a kept transcript of any accepted shape, as `{ text, start, end }`: `{ words }`,
 *  `{ segments: [{ words }] }` (src/transcript-words.mjs, the shape Trillion keeps) or a bare word list, each word
 *  `{ text | word, start, end }`. Read by shape, never by who made it; a word without finite times is dropped. */
export function wordsOf(transcript: unknown): CaptionWord[] {
  const t = transcript as { words?: unknown; segments?: unknown } | null;
  const list: unknown[] = Array.isArray(transcript) ? transcript
    : Array.isArray(t?.words) ? t.words
      : Array.isArray(t?.segments) ? t.segments.flatMap((segment: { words?: unknown }) => (Array.isArray(segment?.words) ? segment.words : []))
        : [];
  return list.map(item => {
    const word = item as { text?: unknown; word?: unknown; start?: unknown; end?: unknown } | null;
    return { text: String(word?.text ?? word?.word ?? '').trim(), start: Number(word?.start), end: Number(word?.end) };
  }).filter(word => word.text && Number.isFinite(word.start) && Number.isFinite(word.end) && word.end >= word.start);
}

/** The caption lines for the words spoken inside [from, to] of a source, moved so `from` shows at `at` (0 for a cut
 *  of its own, the clip's place in a longer edit otherwise). `transcriptFrom` is the time in the source where the
 *  transcript's zero is (a transcript of the cut's own audio starts at `from`). */
export function captionLinesForCut(words: CaptionWord[], from: number, to: number, grouping: CaptionGroupOptions = {}, transcriptFrom = 0, at = 0): CaptionLine[] {
  const inside = words.map(word => ({ ...word, start: word.start + transcriptFrom, end: word.end + transcriptFrom }))
    .filter(word => word.start >= from && word.end <= to)
    .map(word => ({ text: word.text, start: word.start - from + at, end: word.end - from + at }));
  return groupWordsIntoCaptionLines(inside, grouping);
}

/** One stretch of an edit for captioning: the words heard in its source (source time) and the part kept, in order. */
export type CaptionStretch = { words: CaptionWord[]; from: number; to: number };

/** The caption lines for a whole edit made of stretches played one after another, on the edit's own time: each
 *  stretch's words become lines as `grouping` says, placed where that stretch plays. A line never spans two stretches. */
export function captionLinesForEdit(stretches: CaptionStretch[], grouping: CaptionGroupOptions = {}): CaptionLine[] {
  let at = 0;
  return stretches.flatMap(stretch => {
    const lines = captionLinesForCut(stretch.words, stretch.from, stretch.to, grouping, 0, at);
    at += Math.max(0, stretch.to - stretch.from);
    return lines;
  });
}
