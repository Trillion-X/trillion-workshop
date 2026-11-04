// parts/record-audio/read-data/heard-words.mjs
//
// PURPOSE
//   The words heard while recording with a line said again and again back to back kept once, and whether a stretch of
//   words is mostly such a line. A speaker playing one line on repeat near the microphone fills the live words with
//   that line dozens of times; the person reads it once, and a stretch that is mostly one line repeated is never handed
//   to their AIs as if it were something said for work. Every number is heard-words.json.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only a run of repeats_from or more copies of a phrase in a row is shortened, and to exactly one copy, so a word
//      or phrase said twice on purpose ("no, no") stays as said.
//   2. Words that only grow are read once: `loopFreeWords` keeps what it already read and reads only the words added
//      since, starting over only when the earlier words themselves changed.
//   3. Nothing here names a language: words are compared lower case with punctuation removed, letters and digits of
//      any script kept.

import settings from './heard-words.json' with { type: 'json' };

/** A word as it is compared: lower case letters and digits only. */
const comparable = word => word.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const split = text => String(text ?? '').trim().split(/\s+/).filter(Boolean);

/** Whether the `length` words ending at `end` match the `length` words before them (same_share of them alike). */
function repeatsBefore(keys, end, length, rules) {
  if (end < length * 2) return false;
  let alike = 0;
  for (let index = 0; index < length; index += 1) if (keys[end - length + index] === keys[end - 2 * length + index]) alike += 1;
  return length === 1 ? alike === 1 : alike >= Math.ceil(length * rules.same_share);
}

/**
 * Reads words one at a time and keeps them, a phrase repeated repeats_from times or more in a row kept once.
 * add(words) takes the new words; words is what is kept so far.
 */
export function loopReader(rules = settings) {
  const kept = [];
  const keys = [];
  let run = null; // { length, pending } of the phrase repeating at the end of what is kept
  const push = word => { kept.push(word); keys.push(comparable(word)); };
  const pop = count => { kept.length -= count; keys.length -= count; };
  const add = words => {
    for (const word of words) {
      push(word);
      if (run) {
        run.pending += 1;
        if (run.pending < run.length) continue;
        // A whole further copy has arrived: drop it when it repeats the kept copy, else the run is over.
        run.pending = 0;
        if (repeatsBefore(keys, keys.length, run.length, rules)) { pop(run.length); continue; }
        run = null;
      }
      for (let length = 1; length <= rules.phrase_words_up_to; length += 1) {
        let copies = 1;
        while (copies < rules.repeats_from && repeatsBefore(keys, keys.length - (copies - 1) * length, length, rules)) copies += 1;
        if (copies >= rules.repeats_from) {
          pop((copies - 1) * length);
          run = { length, pending: 0 };
          break;
        }
      }
    }
    return kept;
  };
  return { add, get words() { return kept; } };
}

/**
 * Keeps words that only grow (the final words of a recording) loop free, reading each word once. Returns a function
 * from the whole text heard so far to that text with its loops kept once.
 */
export function loopFreeWords(rules = settings) {
  let read = [];
  let reader = loopReader(rules);
  return text => {
    const words = split(text);
    const grew = words.length >= read.length && read.every((word, index) => word === words[index]);
    if (!grew) { reader = loopReader(rules); read = []; }
    reader.add(words.slice(read.length));
    read = words;
    return reader.words.join(' ');
  };
}

/** The text with a phrase repeated repeats_from times or more in a row kept once. */
export const withoutLoops = (text, rules = settings) => loopReader(rules).add(split(text)).join(' ');

/** Whether a stretch of words is mostly one line on repeat rather than someone talking (distinct_share_min). */
export function isMostlyRepeated(text, rules = settings) {
  const keys = split(text).map(comparable).filter(Boolean);
  if (keys.length < rules.judge_from_words) return false;
  const runs = [];
  for (let index = 0; index + 3 <= keys.length; index += 1) runs.push(keys.slice(index, index + 3).join(' '));
  return new Set(runs).size / runs.length < rules.distinct_share_min;
}
