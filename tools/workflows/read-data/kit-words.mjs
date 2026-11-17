// tools/workflows/read-data/kit-words.mjs
//
// The plain words a kit shows a run in: what it started from (givenOf), what it answered (handsBackOf), a value cut to a
// length (compact), and the lengths themselves (OBSERVE, DATA in ../kit-observe.json). Pure: it runs nothing, so the kit
// drafter (draft-a-kit.mjs) can run anywhere a recipe is started, and the sample runner in test-helpers/kit-drafter/observe.mjs
// shows its runs in the same words.

import { readFileSync } from 'node:fs';

export const OBSERVE = JSON.parse(readFileSync(new URL('../kit-observe.json', import.meta.url), 'utf8'));

// Words cut at `most` characters on a word boundary, marked when cut.
export function compact(value, most) {
  const flat = (typeof value === 'string' ? value : JSON.stringify(value)).replace(/\s+/g, ' ').trim();
  if (flat.length <= most) return flat;
  const head = flat.slice(0, most);
  return `${head.slice(0, Math.max(head.lastIndexOf(' '), head.lastIndexOf(','), most / 2))} ...`;
}

// What a sample run starts from, in plain words: its input, the rows it finds kept, the recorded web replies it reads.
export function givenOf(sample) {
  const kinds = (sample.records ?? []).map(record => record.type ?? record.id?.split(':')[0]).filter(Boolean);
  const replies = [sample.replies ?? []].flat().length;
  return `The input ${compact(sample.input, OBSERVE.input_chars)}${kinds.length ? `, with ${kinds.length} example row${kinds.length === 1 ? '' : 's'} (${[...new Set(kinds)].join(', ')}) already kept` : ''}${replies ? `, the web answering from ${replies} recorded repl${replies === 1 ? 'y' : 'ies'}` : ''}.`;
}

export const handsBackOf = ({ answer, kept }) =>
  `It answered ${compact(answer, OBSERVE.answer_chars)}${kept.length ? `, and kept ${compact(kept.join(', '), OBSERVE.input_chars)}` : ''}.`;
