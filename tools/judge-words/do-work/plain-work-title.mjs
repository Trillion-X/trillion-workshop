// tools/judge-words/do-work/plain-work-title.mjs
//
// A short plain title from a job's own words: the first sentence a person would read, with links, paths, record ids,
// program words and markdown taken out, its first letter in capitals, at most 80 UTF-16 units. Moved from the engine's
// src/work_title.rs (itself the port of the original src/work-title.mjs); the rules and their tests are unchanged.
// The fallback words are the caller's DATA: a request may name its own.

export const TITLE_MAX = 80;
export const FALLBACK = 'Sent to your AIs';
const HEADING_MIN_WORDS = 3;

// JavaScript's \s is exactly the whitespace set the engine port spelled out by hand (no U+0085).
const WS = /\s/g;
const LINK = /\[([^\]]*)\]\([^)]*\)/g;
const ADDRESS = /\b(?:https?|ftp|file|mailto):\S+/gi;
const PATH = /(?:^|\s)(?:~|\.|\.\.)?\/[^\s,;:)]*\/[^\s,;:)]*/g;
const RECORD_ID = /\b[A-Za-z0-9]{1,6}[_:][A-Za-z0-9-]{8,}\b/g;
const EMPHASIS = /(\*\*|__|\*|`+|~~)/g;
const LINE_MARK = /^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/;
const EMPTY_BRACKETS = /\(\s*[,;.]*\s*\)/g;
const SPACE_BEFORE_MARK = /\s+([,.;:!?])/g;
const LEAD_LABEL = /^[A-Za-z][A-Za-z ]{0,24}:\s+(\S)/;
const HEADING = /^\s*#{1,6}\s/;
const LETTER = /\p{L}/u;
const PROGRAM_WORD = /\b[A-Za-z0-9]+_[A-Za-z0-9_]+\b/;
const SENTENCE_END = /(?<=[.!?])\s+(?=[\p{Uppercase}\p{N}"'(])/u;
const FIT_TRAILING = /[\s,;:.–—-]+$/;

function clean(raw) {
  let line = raw.replace(WS, ' ').replace(LINK, '$1').replace(ADDRESS, ' ').replace(PATH, ' ');
  line = line.replace(RECORD_ID, id => (/\d/.test(id.split(/[_:]/)[1] ?? '') ? ' ' : id));
  line = line.replace(WS, ' ').replace(EMPHASIS, '').replace(LINE_MARK, '').replace(EMPTY_BRACKETS, ' ').replace(SPACE_BEFORE_MARK, '$1');
  line = line.split(' ').filter(Boolean).join(' ');
  return line.replace(LEAD_LABEL, '$1');
}

// An ASCII word token of eight or more hex digits holding a digit is an id, not a word.
const withoutLongHexIds = sentence =>
  sentence.replace(/\w+/g, token => (token.length >= 8 && /^[0-9a-f]+$/i.test(token) && /\d/.test(token) ? ' ' : token));

function upperFirst(sentence) {
  const first = sentence.charCodeAt(0);
  if (Number.isNaN(first) || (first >= 0xd800 && first <= 0xdfff)) return sentence;
  return sentence.charAt(0).toLocaleUpperCase() + sentence.slice(1);
}

function fit(text) {
  if (text.length <= TITLE_MAX) return text;
  let cut = text.slice(0, TITLE_MAX - 1);
  const space = cut.lastIndexOf(' ');
  if (space > TITLE_MAX / 2) cut = cut.slice(0, space);
  return cut.replace(FIT_TRAILING, '') + '…';
}

/** The plain title of a job's words; `fallback` when no sentence a person reads is in them. */
export function workTitle(job, fallback = FALLBACK) {
  for (const raw of String(job).split('\n')) {
    const normalized = raw.replace(/\r$/, '').replace(WS, ' ');
    const heading = HEADING.test(normalized);
    const line = clean(normalized);
    if (!LETTER.test(line) || (heading && line.split(' ').length < HEADING_MIN_WORDS)) continue;
    for (const part of line.split(SENTENCE_END)) {
      const sentence = withoutLongHexIds(part.trim().replace(/[.:;,]+$/, '').trim());
      if (!LETTER.test(sentence) || PROGRAM_WORD.test(sentence)) continue;
      return fit(upperFirst(sentence));
    }
  }
  return fallback;
}

/** A nonblank `said` kept as said (trimmed); otherwise the job's plain title. */
export function titleOf(said, job, fallback = FALLBACK) {
  const trimmed = typeof said === 'string' ? said.trim() : '';
  return trimmed ? trimmed : workTitle(job, fallback);
}
