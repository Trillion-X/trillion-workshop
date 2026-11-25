//
// PURPOSE
//   The pure edits a person makes to a recording's kept words: name a speaker (or take the name back), split one
//   passage in two before a chosen word, and write the passages as plain words for Copy and Export PDF. Times are seconds in the
//   recording, the shape the transcription tool keeps (`TimedPassage`); nothing here reads or saves anything.
//
// NON-NEGOTIABLE INVARIANTS
//   1. An edit returns new passages; the ones handed in are never changed.
//   2. Naming a speaker changes only the label, and keeps the label it had before in `speaker_was`, so taking the
//      name back restores it exactly. Words, times and order never change.
//   3. A split keeps every word and every second: the two halves together say exactly what the passage said, the
//      first ends where the second begins, and the split falls between two words, never inside one.
//   4. Rewording a passage keeps its start and end; its new words share that span, and no other passage changes.

export type EditWord = { word: string; start: number; end: number };
export type EditPassage = { start: number; end: number; text: string; speaker?: string; speaker_was?: string; words?: EditWord[] };

const clean = (name: string) => name.replace(/\s+/g, ' ').trim();

/** Every passage said by `from` is said by `name` instead; an empty name is refused. */
export function nameSpeaker<P extends EditPassage>(passages: readonly P[], from: string, name: string): P[] {
  const to = clean(name);
  if (!to) throw new Error('Give the speaker a name.');
  return passages.map(passage => (passage.speaker === from ? { ...passage, speaker: to, speaker_was: passage.speaker_was ?? from } : passage));
}

/** Every passage said under `name` goes back to the label it had before it was named. */
export function takeNameBack<P extends EditPassage>(passages: readonly P[], name: string): P[] {
  return passages.map(passage => {
    if (passage.speaker !== name || !passage.speaker_was) return passage;
    const { speaker_was: was, ...rest } = passage;
    return { ...rest, speaker: was } as P;
  });
}

/** The speakers that were named by the person (a label that has one to go back to), by their current name. */
export const namedSpeakers = (passages: readonly EditPassage[]): string[] => [...new Set(passages.filter(passage => passage.speaker && passage.speaker_was).map(passage => passage.speaker!))];

/**
 * The passage at `index` split into two just before its word number `wordIndex` (the caret). The first half ends
 * where the second begins: at that word's own start second.
 */
export function splitPassage<P extends EditPassage>(passages: readonly P[], index: number, wordIndex: number): P[] {
  const passage = passages[index];
  if (!passage) throw new Error('That passage is no longer in the transcript.');
  const words = passage.words ?? [];
  if (!Number.isInteger(wordIndex) || wordIndex <= 0 || wordIndex >= words.length) throw new Error('Choose a word in the middle of the passage to split it there.');
  const say = (part: readonly EditWord[]) => part.map(word => word.word.trim()).join(' ');
  const before = words.slice(0, wordIndex), after = words.slice(wordIndex);
  const head = { ...passage, text: say(before), end: after[0].start, words: before };
  const tail = { ...passage, text: say(after), start: after[0].start, words: after };
  return [...passages.slice(0, index), head, tail, ...passages.slice(index + 1)];
}

/**
 * The passage at `index` with its words written as `text`. The passage keeps its own start and end. When the new words are
 * as many as the old, each keeps the seconds of the word it replaces (a spelling fix moves no word); otherwise the passage's
 * span is shared evenly among the new words, so every word still has a second the reader can follow and seek to.
 */
export function rewordPassage<P extends EditPassage>(passages: readonly P[], index: number, text: string): P[] {
  const passage = passages[index];
  if (!passage) throw new Error('That passage is no longer in the transcript.');
  const said = text.replace(/\s+/g, ' ').trim();
  if (!said) throw new Error('A passage needs words. Split or keep it instead of emptying it.');
  const next = said.split(' ');
  const old = passage.words ?? [];
  if (!old.length) return passages.map((row, at) => (at === index ? { ...row, text: said } : row));
  const start = old[0].start, end = old[old.length - 1].end;
  const step = (end - start) / next.length;
  const words = next.length === old.length
    ? old.map((word, at) => ({ ...word, word: next[at] }))
    : next.map((word, at) => ({ word, start: start + at * step, end: at === next.length - 1 ? end : start + (at + 1) * step }));
  return passages.map((row, at) => (at === index ? { ...row, text: said, words } : row));
}

/** 0:05 or 1:02:03 for a second in the recording. */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600), m = Math.floor(whole / 60) % 60, s = String(whole % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** The transcript as plain lines, `Speaker  0:05` over its words, one blank line between passages. */
export function transcriptAsText(passages: readonly EditPassage[]): string {
  return passages.map(passage => `${[passage.speaker, clock(passage.start)].filter(Boolean).join('  ')}\n${passage.text.trim()}`).join('\n\n');
}
