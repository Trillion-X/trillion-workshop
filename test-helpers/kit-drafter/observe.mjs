// What a tool really answers, for the kit drafter (tools/workflows/read-data/draft-a-kit.mjs): each of the tool's own
// sample runs (verify, kind sample-run) is run here the way the container runner runs it (test-helpers/run-a-row.mjs),
// and a run that ends well (exit 0, a JSON line, no error) gives the answer its result_selector picks. So a drafted
// worked example hands back a real answer, not a description of one. A sample whose input names a folder or server only
// this runner makes ({grant:...}) is no input a person could give, and an answer that still holds a home folder is never
// shown. Lengths and words are DATA (observe.json); nothing here names a tool.
//
//   observe(row) -> [{ sample, answer, kept }]       kept: the ids of the rows the run wrote that the sample did not seed
//   observeAll(rows) -> Map(id -> [{ sample, answer, kept }])
//   givenOf(sample), handsBackOf(seen), compact(value, most): the plain words a kit shows them in

import { readFileSync, realpathSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { runRow, select } from '../run-a-row.mjs';

export const OBSERVE = JSON.parse(readFileSync(new URL('./observe.json', import.meta.url), 'utf8'));
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// Words cut at `most` characters on a word boundary, marked when cut.
export function compact(value, most) {
  const flat = (typeof value === 'string' ? value : JSON.stringify(value)).replace(/\s+/g, ' ').trim();
  if (flat.length <= most) return flat;
  const head = flat.slice(0, most);
  return `${head.slice(0, Math.max(head.lastIndexOf(' '), head.lastIndexOf(','), most / 2))} ...`;
}

// The run's own folder stands for `/`: put back as `/`. Null when the answer still names this computer's home folder,
// its user or its temporary folder, so no example carries a path from the computer that drafted it.
const escaped = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const RUN_FOLDER = new RegExp(`${escaped(realpathSync(tmpdir()))}/workshop-row-[^/"]+`, 'g');
const THIS_COMPUTER = [homedir(), userInfo().username, realpathSync(tmpdir()), tmpdir()].filter(word => word && word.length > 2);
export function cleanAnswer(value) {
  const text = JSON.stringify(value ?? null).replace(RUN_FOLDER, '');
  return THIS_COMPUTER.some(word => text.includes(word)) ? null : JSON.parse(text);
}

export const samplesOf = row => [row.verify ?? []].flat().filter(check => check?.kind === 'sample-run' && object(check.input)
  && !OBSERVE.runner_only_words.some(word => JSON.stringify(check.input).includes(word)));

export async function observe(row) {
  const seen = [];
  for (const sample of samplesOf(row)) {
    if (seen.length >= OBSERVE.most_runs) break;
    const ran = await runRow(row, sample.input, sample).catch(error => ({ cannot: error.message }));
    if (ran.cannot || ran.code !== 0 || !object(ran.last) || 'error' in ran.last) continue;
    const answer = cleanAnswer(row.result_selector ? select(ran.last, row.result_selector) : ran.last);
    if (answer === null || answer === undefined) continue;
    const seeded = new Set((sample.records ?? []).map(record => record.id));
    seen.push({ sample, answer, kept: ran.kept.map(record => record.id).filter(id => typeof id === 'string' && !seeded.has(id)) });
  }
  return seen;
}

export async function observeAll(rows) {
  const answers = new Map();
  const queue = [...rows];
  await Promise.all(Array.from({ length: OBSERVE.runs_at_once }, async () => {
    while (queue.length) {
      const row = queue.shift();
      answers.set(row.id, await observe(row));
    }
  }));
  return answers;
}

// What a sample run starts from, in plain words: its input, the rows it finds kept, the recorded web replies it reads.
export function givenOf(sample) {
  const kinds = (sample.records ?? []).map(record => record.type ?? record.id?.split(':')[0]).filter(Boolean);
  const replies = [sample.replies ?? []].flat().length;
  return `The input ${compact(sample.input, OBSERVE.input_chars)}${kinds.length ? `, with ${kinds.length} example row${kinds.length === 1 ? '' : 's'} (${[...new Set(kinds)].join(', ')}) already kept` : ''}${replies ? `, the web answering from ${replies} recorded repl${replies === 1 ? 'y' : 'ies'}` : ''}.`;
}

export const handsBackOf = ({ answer, kept }) =>
  `It answered ${compact(answer, OBSERVE.answer_chars)}${kept.length ? `, and kept ${compact(kept.join(', '), OBSERVE.input_chars)}` : ''}.`;
